import { _BuildOrgDomain } from "@opencrane/contracts";

import type { OrgDomainProvisioner, OrgDomainProvisionRequest, OrgDomainProvisionResult, OrgDomainProvisionerConfig, CertManagerOperations, CertificateReadiness, DnsEndpointOperations } from "./org-domain-provisioner.types.js";

/** TTL (seconds) for the per-org A record — matches the terraform DNS module. */
const _RECORD_TTL = 300;

/**
 * Stable name of the per-org DNSEndpoint CR (one per org, in its bound namespace).
 * Used by both provision and deprovision so teardown targets the same object.
 */
function _DnsEndpointName(orgName: string): string
{
  return `org-dns-${orgName}`;
}

/** Stable name of the per-org vanity TLS Secret/Certificate. */
function _VanityCertName(orgName: string): string
{
  return `org-vanity-tls-${orgName}`;
}

/**
 * Concrete {@link OrgDomainProvisioner} for the single-per-org-host topology, owned by
 * the operator. Every user in an org is served at the org's SINGLE host `<org>.<base>`
 * via the identity-routing gateway proxy (no per-user subdomains), which collapses the
 * per-org domain work to two minimal side effects:
 *
 *   1. **DNS** — one A record `<org>.<base>` → the cluster ingress IP, declared as an
 *      external-dns `DNSEndpoint` CR that external-dns reconciles into the platform's DNS
 *      provider. The org host gets an EXPLICIT record (not just wildcard coverage), so it
 *      is visible/manageable. There is NO per-user `*.<org>.<base>` wildcard record.
 *   2. **TLS** — the canonical host `<org>.<base>` is one label under the platform base,
 *      so it is already covered by the platform `*.<base>` certificate; the ONLY per-org
 *      certificate is for a customer-vanity host (via cert-manager HTTP-01, since the
 *      vanity CNAME resolves to the ingress). No vanity → no per-org cert.
 *
 * Idempotent (re-apply is a no-op) so the reconciler can call it on every reconcile.
 * RUNTIME-GATED: an absent DNSEndpoint CRD (no external-dns) or Certificate CRD (no
 * cert-manager) short-circuits fail-closed; when nothing could act it returns
 * `{ ready:false, skipped:true }` and never throws.
 *
 * PRECONDITION: the org's bound namespace (`req.boundNamespace`) must already exist.
 */
export class DefaultOrgDomainProvisioner implements OrgDomainProvisioner
{
  private readonly certs: CertManagerOperations;
  private readonly dns: DnsEndpointOperations;
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
    const namespace = req.boundNamespace;

    // 1. DNS — declare the explicit org-host A record `<org>.<base>` → ingress IP as a
    //    DNSEndpoint CR (external-dns reconciles it). No per-user wildcard. Runs only when
    //    an ingress IP target is set. dnsApplied is false when no IP or external-dns absent.
    const dnsApplied = await this._ensureDnsEndpoint(req, orgDomain, namespace);

    // 2. TLS — only a customer-vanity host needs a per-org cert; the canonical host rides
    //    the platform `*.<base>` cert. No vanity → nothing to issue.
    const vanity = req.vanityDomain?.trim();
    let tlsSecretName: string | undefined;
    let certReadiness: CertificateReadiness | undefined;
    if (vanity)
    {
      tlsSecretName = _VanityCertName(req.orgName);
      const cert = this._buildVanityCertificate(req, vanity, namespace, tlsSecretName);
      certReadiness = await this.certs.applyCertificate(namespace, cert);
    }

    // 3. Gate on REAL capability signals. The vanity cert "acted" only if cert-manager is
    //    installed; if neither DNS nor the (optional) cert could act, report skipped.
    const certActed = certReadiness?.certManagerInstalled ?? false;
    if (!dnsApplied && !certActed)
    {
      return {
        orgDomain,
        tlsSecretName,
        ready: false,
        skipped: true,
        message: "external-dns unavailable (no ingress IP / no DNSEndpoint CRD) and no per-org cert to apply; org-host DNS not provisioned",
      };
    }

    // ready = the DNS record was applied AND, when a vanity cert is required, it has issued.
    const ready = dnsApplied && (!vanity || (certReadiness?.ready ?? false));
    return {
      orgDomain,
      tlsSecretName,
      ready,
      skipped: false,
      message: ready ? undefined : (certReadiness?.reason ?? "org-host DNS/cert still settling"),
    };
  }

  /** @inheritdoc */
  public async deprovisionOrgDomain(orgName: string, _platformBaseDomain: string, boundNamespace: string): Promise<void>
  {
    // Delete the per-org vanity Certificate (no-op if the org had none) and the org-host
    // DNSEndpoint; missing CRs / absent CRDs are no-ops. external-dns then reaps the record.
    await this.certs.deleteCertificate(boundNamespace, _VanityCertName(orgName));
    await this.dns.deleteDnsEndpoint(boundNamespace, _DnsEndpointName(orgName));
  }

  /**
   * Declare the org-host A record `<org>.<base>` → the ingress IP as a DNSEndpoint CR,
   * when an ingress IP target is set. Returns whether the DNS side actually acted.
   */
  private async _ensureDnsEndpoint(req: OrgDomainProvisionRequest, orgDomain: string, namespace: string): Promise<boolean>
  {
    const ingressIp = req.ingressIp?.trim();
    if (!ingressIp)
    {
      return false; // No target → nothing to point a record at.
    }

    const manifest = this._buildDnsEndpoint(req, orgDomain, namespace, ingressIp);
    const readiness = await this.dns.applyDnsEndpoint(namespace, manifest);
    return readiness.applied;
  }

  /**
   * Build the per-org DNSEndpoint CR declaring the single `<org>.<base>` A record →
   * the cluster ingress IP. external-dns reconciles it into the configured DNS provider.
   */
  private _buildDnsEndpoint(req: OrgDomainProvisionRequest, orgDomain: string, namespace: string, ingressIp: string): Record<string, unknown>
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
          { dnsName: orgDomain, recordType: "A", recordTTL: _RECORD_TTL, targets: [ingressIp] },
        ],
      },
    };
  }

  /**
   * Build the per-org vanity Certificate CR — SAN = the customer-vanity host only (no
   * wildcard; the canonical `<org>.<base>` is covered by the platform `*.<base>` cert).
   * The configured issuer must offer an HTTP-01 solver for vanity hosts (the CNAME
   * resolves to the ingress), since we do not control the customer's DNS for DNS-01.
   */
  private _buildVanityCertificate(req: OrgDomainProvisionRequest, vanity: string, namespace: string, tlsSecretName: string): Record<string, unknown>
  {
    return {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: tlsSecretName,
        namespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "app.kubernetes.io/component": "org-vanity-cert",
          "opencrane.io/cluster-tenant": req.orgName,
        },
      },
      spec: {
        secretName: tlsSecretName,
        issuerRef: { name: this.config.issuerName, kind: this.config.issuerKind },
        dnsNames: [vanity],
      },
    };
  }
}
