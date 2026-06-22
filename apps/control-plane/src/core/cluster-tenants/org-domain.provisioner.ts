import { _BuildOrgDomain, _BuildOrgWildcard } from "@opencrane/contracts";

import type { OrgDomainProvisioner, OrgDomainProvisionRequest, OrgDomainProvisionResult } from "./org-domain-provisioner.types.js";
import type { CertManagerOperations } from "./cert-manager.client.js";
import type { CloudDnsOperations } from "./cloud-dns.client.js";

/** TTL (seconds) for the per-org A records — matches the terraform DNS module. */
const _RECORD_TTL = 300;

/**
 * Static config the provisioner needs to author the per-org Certificate, supplied
 * from the chart's `certManager` values (issuerName / issuer kind) and the org's
 * bound namespace prefix. Injected so the provisioner carries no environment reads.
 */
export interface OrgDomainProvisionerConfig
{
  /** cert-manager issuer name the Certificate references (chart `certManager.issuerName`). */
  issuerName: string;
  /** Issuer kind: a cluster-singleton `ClusterIssuer` (default) or namespaced `Issuer`. */
  issuerKind: "ClusterIssuer" | "Issuer";
  /** Prefix applied to the org name to derive its bound namespace (`opencrane-<org>`). */
  namespacePrefix: string;
}

/**
 * Concrete {@link OrgDomainProvisioner} for the fixed-wildcard topology. Given an
 * org, it materialises the two cluster-side side effects the topology requires:
 *
 *   1. A per-org wildcard TLS Certificate `*.<org>.<base>` (+ the `<org>.<base>`
 *      apex SAN, and the vanity domain when present) via cert-manager DNS-01, into
 *      the org's bound namespace — because the platform `*.<base>` cert does NOT
 *      cover the extra label `<user>.<org>.<base>`.
 *   2. A per-org serving DNS record `*.<org>.<base>` (and the `<org>.<base>` apex)
 *      → the cluster ingress IP, via the terraform-managed Cloud DNS zone — so every
 *      UserTenant gateway host under the org resolves with no per-user record.
 *
 * Both side effects are idempotent (re-apply is a no-op) so the reconciler can call
 * `provisionOrgDomain` on every reconcile. It is FAIL-CLOSED and GATED: when the
 * cluster has no cert-manager (the dev cluster currently does not), it returns a
 * clear `ready:false` + reason rather than crashing — but the code path that WOULD
 * create the resources is real, not a no-op stub. This is invoked by the
 * ClusterTenant reconciler (PR #50); the create HTTP path never calls it directly,
 * preserving the API-first posture.
 *
 * PRECONDITION: the org's bound namespace (`<namespacePrefix><org>`) must already
 * exist — the reconciler fences it (the same step that binds the ClusterTenant)
 * BEFORE calling this. A missing namespace is a precondition fault: the cert-manager
 * client re-throws that 404 (it is NOT masked as "cert-manager absent"), so the
 * reconciler surfaces it as an error rather than a silent not-ready.
 */
export class DefaultOrgDomainProvisioner implements OrgDomainProvisioner
{
  /** cert-manager Certificate operations (injected; fake in tests). */
  private readonly certs: CertManagerOperations;

  /** Cloud DNS record operations (injected; fake in tests). */
  private readonly dns: CloudDnsOperations;

  /** Static issuer + namespace config from the chart values. */
  private readonly config: OrgDomainProvisionerConfig;

  /**
   * @param certs  - cert-manager Certificate operations.
   * @param dns    - Cloud DNS record operations.
   * @param config - Issuer name/kind + namespace prefix from the chart values.
   */
  public constructor(certs: CertManagerOperations, dns: CloudDnsOperations, config: OrgDomainProvisionerConfig)
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
    const namespace = `${this.config.namespacePrefix}${req.orgName}`;
    const tlsSecretName = `org-wildcard-tls-${req.orgName}`;

    // 1. DNS first — the wildcard A record `*.<org>.<base>` and the org apex
    //    `<org>.<base>`, both → the ingress IP. DNS-01 issuance below also needs the
    //    zone reachable, and serving must resolve regardless of cert state. Idempotent.
    await this.dns.ensureARecord(wildcardDnsName, [req.ingressIp], _RECORD_TTL);
    await this.dns.ensureARecord(orgDomain, [req.ingressIp], _RECORD_TTL);

    // 2. The per-org wildcard Certificate. Built to the exact shape of the WS5
    //    reference manifest (platform/helm/examples/per-org-wildcard-cert.yaml).
    const certificate = this._buildCertificate(req, orgDomain, wildcardDnsName, namespace, tlsSecretName);
    const readiness = await this.certs.applyCertificate(namespace, certificate);

    // 3. Gated: cert-manager absent → ready:false + reason, never a crash. Serving
    //    DNS still landed above, so the org resolves; only browser-trusted TLS waits.
    return { orgDomain, wildcardDnsName, tlsSecretName, ready: readiness.ready };
  }

  /** @inheritdoc */
  public async deprovisionOrgDomain(orgName: string, platformBaseDomain: string): Promise<void>
  {
    const orgDomain = _BuildOrgDomain(orgName, platformBaseDomain);
    const wildcardDnsName = _BuildOrgWildcard(orgDomain);
    const namespace = `${this.config.namespacePrefix}${orgName}`;
    const tlsSecretName = `org-wildcard-tls-${orgName}`;

    // Idempotent teardown: missing records / Certificate / CRD are all no-ops.
    await this.certs.deleteCertificate(namespace, tlsSecretName);
    await this.dns.deleteARecord(wildcardDnsName);
    await this.dns.deleteARecord(orgDomain);
  }

  /**
   * Build the per-org wildcard Certificate CR — the exact shape WS5's reference
   * manifest defines: `*.<org>.<base>` + the `<org>.<base>` apex SAN, the org's
   * vanity domain (and its wildcard) appended when set, the configured issuer ref,
   * and the per-org TLS Secret name.
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
