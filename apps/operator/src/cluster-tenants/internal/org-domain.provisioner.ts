import { _BuildOrgDomain, _BuildOrgWildcard } from "@opencrane/contracts";

import type { OrgDomainProvisioner, OrgDomainProvisionRequest, OrgDomainProvisionResult, OrgDomainProvisionerConfig, CertManagerOperations, DnsEndpointOperations } from "./org-domain-provisioner.types.js";

/** TTL (seconds) for the per-org A records — matches the terraform DNS module. */
const _RECORD_TTL = 300;

/**
 * Stable name of the per-org DNSEndpoint CR (one per org, in its bound namespace).
 * Used by both provision and deprovision so teardown targets the same object.
 *
 * @param orgName - The org (ClusterTenant) name.
 * @returns The DNSEndpoint resource name.
 */
function _DnsEndpointName(orgName: string): string
{
  return `org-dns-${orgName}`;
}

/**
 * Concrete {@link OrgDomainProvisioner} for the fixed-wildcard topology, owned by the
 * operator (the reconciler/executor). Given an org, it materialises the two cluster-
 * side side effects the topology requires — BOTH as namespaced custom resources, so the
 * operator talks to no cloud DNS API and carries no cloud SDK:
 *
 *   1. A per-org wildcard TLS Certificate `*.<org>.<base>` (+ the `<org>.<base>` apex
 *      SAN, and the vanity domain when present) via cert-manager DNS-01, into the org's
 *      bound namespace — because the platform `*.<base>` cert does NOT cover the extra
 *      label `<user>.<org>.<base>`.
 *   2. A per-org serving DNS record `*.<org>.<base>` (and the `<org>.<base>` apex) →
 *      the cluster ingress IP, declared as an external-dns `DNSEndpoint` CR that the
 *      external-dns controller reconciles into the configured DNS provider — so every
 *      UserTenant gateway host under the org resolves with no per-user record.
 *
 * Both side effects are idempotent (re-apply is a no-op) so the reconciler can call
 * `provisionOrgDomain` on every reconcile. It is RUNTIME-GATED by real capability
 * detection, NOT a hardcoded always-skip: each manifest is genuinely built and the apply
 * IS issued; an absent Certificate CRD short-circuits the TLS side (fail-closed) and an
 * absent DNSEndpoint CRD short-circuits the DNS side (fail-closed). When NEITHER side
 * could act (cert-manager absent AND external-dns absent / no ingress IP), it returns
 * `{ ready:false, skipped:true }` so the reconciler records the skip and the org still
 * reaches `ready` — it never throws.
 *
 * PRECONDITION: the org's bound namespace (`req.boundNamespace`) must already
 * exist — the reconciler fences it BEFORE calling this. A missing namespace is a
 * precondition fault: the cert-manager client re-throws that 404 (it is NOT masked as
 * "cert-manager absent"), so the reconciler surfaces it as an error.
 */
export class DefaultOrgDomainProvisioner implements OrgDomainProvisioner
{
  /** cert-manager Certificate operations (injected; fake in tests). */
  private readonly certs: CertManagerOperations;

  /**
   * external-dns DNSEndpoint operations (injected; fake in tests). Always wired —
   * external-dns absence is a runtime signal (the CRD is not served), not a wiring
   * decision, so the DNS side is real even on a cluster without external-dns.
   */
  private readonly dns: DnsEndpointOperations;

  /** Static issuer config from the chart values. */
  private readonly config: OrgDomainProvisionerConfig;

  /**
   * @param certs  - cert-manager Certificate operations.
   * @param dns    - external-dns DNSEndpoint operations.
   * @param config - Issuer name/kind from the chart values.
   */
  public constructor(certs: CertManagerOperations, dns: DnsEndpointOperations, config: OrgDomainProvisionerConfig)
  {
    this.certs = certs;
    this.dns = dns;
    this.config = config;
  }

  /** @inheritdoc */
  public async provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>
  {
    const orgDomain = _BuildOrgDomain(req.orgName, req.platformBaseDomain);
    const wildcardDnsName = _BuildOrgWildcard(orgDomain); // `*.<org>.<base>`
    const namespace = req.boundNamespace;
    const tlsSecretName = `org-wildcard-tls-${req.orgName}`;

    // 1. DNS first — declare the wildcard A record `*.<org>.<base>` and the org apex,
    //    both → the ingress IP, as a DNSEndpoint CR. Runs only when an ingress IP target
    //    is set; external-dns then reconciles the records. Idempotent. dnsApplied records
    //    whether the DNS side actually acted (false when no ingress IP or no external-dns).
    const dnsApplied = await this._ensureDnsEndpoint(req, orgDomain, wildcardDnsName, namespace);

    // 2. The per-org wildcard Certificate. The manifest is genuinely built and the
    //    apply IS issued; the client returns certManagerInstalled:false (fail-closed,
    //    no crash) only when the cluster has no Certificate CRD.
    const certificate = this._buildCertificate(req, orgDomain, wildcardDnsName, namespace, tlsSecretName);
    const readiness = await this.certs.applyCertificate(namespace, certificate);

    // 3. Gate on REAL capability signals: when cert-manager is absent AND no DNS record
    //    was applied, no backend acted at all → report skipped so the reconciler records
    //    the condition and the org still reaches ready. Otherwise the step is live and
    //    `ready` reflects whether DNS-01 issuance has completed.
    if (!readiness.certManagerInstalled && !dnsApplied)
    {
      return {
        orgDomain,
        wildcardDnsName,
        tlsSecretName,
        ready: false,
        skipped: true,
        message: readiness.reason ?? "cert-manager and external-dns are both unavailable; per-org wildcard cert + DNS record not provisioned",
      };
    }

    return {
      orgDomain,
      wildcardDnsName,
      tlsSecretName,
      ready: readiness.ready,
      skipped: false,
      message: readiness.ready ? undefined : readiness.reason,
    };
  }

  /** @inheritdoc */
  public async deprovisionOrgDomain(orgName: string, platformBaseDomain: string, boundNamespace: string): Promise<void>
  {
    const orgDomain = _BuildOrgDomain(orgName, platformBaseDomain);
    const wildcardDnsName = _BuildOrgWildcard(orgDomain);
    const namespace = boundNamespace;
    const tlsSecretName = `org-wildcard-tls-${orgName}`;

    // 1. Delete the Certificate first — missing Certificate / CRD are no-ops.
    await this.certs.deleteCertificate(namespace, tlsSecretName);

    // 2. Delete the DNSEndpoint — a missing CR / absent CRD are no-ops. external-dns
    //    then reaps the records it owns. (orgDomain/wildcardDnsName are derived above for
    //    symmetry with provision; the DNSEndpoint name is the org-stable handle.)
    void orgDomain;
    void wildcardDnsName;
    await this.dns.deleteDnsEndpoint(namespace, _DnsEndpointName(orgName));
  }

  /**
   * Declare the per-org wildcard AND apex A records (→ the ingress IP) as a DNSEndpoint
   * CR, when an ingress IP target is set. Returns whether the DNS side actually acted, so
   * the caller can distinguish a real no-backend skip from a partially-served reconcile.
   *
   * @param req             - The provision request (carries the optional ingress IP).
   * @param orgDomain       - The org apex `<org>.<base>`.
   * @param wildcardDnsName - The per-org wildcard `*.<org>.<base>`.
   * @param namespace       - The org's bound namespace the DNSEndpoint is created in.
   * @returns True when the DNSEndpoint was applied; false when DNS was skipped.
   */
  private async _ensureDnsEndpoint(req: OrgDomainProvisionRequest, orgDomain: string, wildcardDnsName: string, namespace: string): Promise<boolean>
  {
    const ingressIp = req.ingressIp?.trim();
    if (!ingressIp)
    {
      return false; // No target → nothing to point a record at.
    }

    const manifest = this._buildDnsEndpoint(req, orgDomain, wildcardDnsName, namespace, ingressIp);
    const readiness = await this.dns.applyDnsEndpoint(namespace, manifest);
    return readiness.applied;
  }

  /**
   * Build the per-org DNSEndpoint CR declaring the wildcard `*.<org>.<base>` and the
   * `<org>.<base>` apex as A records pointing at the cluster ingress IP. external-dns
   * reconciles these into the configured DNS provider.
   *
   * @param req             - The provision request.
   * @param orgDomain       - The org apex `<org>.<base>`.
   * @param wildcardDnsName - The per-org wildcard `*.<org>.<base>`.
   * @param namespace       - The org's bound namespace the DNSEndpoint is created in.
   * @param ingressIp       - The cluster ingress IP the A records target.
   * @returns The DNSEndpoint custom-resource manifest.
   */
  private _buildDnsEndpoint(req: OrgDomainProvisionRequest, orgDomain: string, wildcardDnsName: string, namespace: string, ingressIp: string): Record<string, unknown>
  {
    return {
      apiVersion: "externaldns.k8s.io/v1alpha1",
      kind: "DNSEndpoint",
      metadata: {
        name: _DnsEndpointName(req.orgName),
        namespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "app.kubernetes.io/component": "org-dns",
          "opencrane.io/cluster-tenant": req.orgName,
        },
      },
      spec: {
        endpoints: [
          { dnsName: wildcardDnsName, recordType: "A", recordTTL: _RECORD_TTL, targets: [ingressIp] },
          { dnsName: orgDomain, recordType: "A", recordTTL: _RECORD_TTL, targets: [ingressIp] },
        ],
      },
    };
  }

  /**
   * Build the per-org wildcard Certificate CR — `*.<org>.<base>` + the `<org>.<base>`
   * apex SAN, the org's vanity domain (and its wildcard) appended when set, the
   * configured issuer ref, and the per-org TLS Secret name.
   *
   * @param req             - The provision request (carries the optional vanity domain).
   * @param orgDomain       - The org apex `<org>.<base>`.
   * @param wildcardDnsName - The per-org wildcard `*.<org>.<base>`.
   * @param namespace       - The org's bound namespace the Certificate is created in.
   * @param tlsSecretName   - The per-org TLS Secret name (also the Certificate name).
   * @returns The Certificate custom-resource manifest.
   */
  private _buildCertificate(req: OrgDomainProvisionRequest, orgDomain: string, wildcardDnsName: string, namespace: string, tlsSecretName: string): Record<string, unknown>
  {
    const dnsNames: string[] = [wildcardDnsName, orgDomain];
    const vanity = req.vanityDomain?.trim();
    if (vanity)
    {
      // The customer CNAMEs the vanity onto <org>.<base>; add it (and its wildcard)
      // so the org is browser-trusted under the vanity name too.
      dnsNames.push(_BuildOrgWildcard(vanity), vanity);
    }

    return {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: tlsSecretName,
        namespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "app.kubernetes.io/component": "org-wildcard-cert",
          "opencrane.io/cluster-tenant": req.orgName,
        },
      },
      spec: {
        secretName: tlsSecretName,
        issuerRef: {
          name: this.config.issuerName,
          kind: this.config.issuerKind,
        },
        dnsNames,
      },
    };
  }
}
