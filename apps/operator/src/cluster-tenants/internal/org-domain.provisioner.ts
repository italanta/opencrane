import { _BuildOrgDomain } from "@opencrane/contracts";

import type { OrgDomainProvisioner, OrgDomainProvisionRequest, OrgDomainProvisionResult, OrgDomainProvisionerConfig, CertManagerOperations } from "./org-domain-provisioner.types.js";

/**
 * Stable name of the per-org vanity TLS Secret/Certificate (one per org, in its bound
 * namespace). Used by both provision and deprovision so teardown targets the same object.
 *
 * @param orgName - The org (ClusterTenant) name.
 * @returns The Certificate / Secret name.
 */
function _VanityCertName(orgName: string): string
{
  return `org-vanity-tls-${orgName}`;
}

/**
 * Concrete {@link OrgDomainProvisioner} for the single-per-org-host topology, owned by
 * the operator (the reconciler/executor).
 *
 * Every user in an org is served at the org's single host `<org>.<base>` via the
 * identity-routing gateway proxy, so the per-org domain work is minimal:
 *   - The canonical host `<org>.<base>` is one label under the platform base, already
 *     covered by the platform wildcard `*.<base>` DNS record + certificate (set up once
 *     at install). So there is NOTHING to provision per org for the canonical host — no
 *     per-org DNS record, no per-org certificate, no external-dns DNSEndpoint.
 *   - A customer-vanity domain (`ai.client-co.com`) is the ONLY per-org side effect: it
 *     sits under no platform base, so the org needs its own certificate with the vanity
 *     SAN. The customer CNAMEs the vanity onto `<org>.<base>`, so an HTTP-01 challenge on
 *     that host succeeds — no DNS-01, no DNS-provider access.
 *
 * The cert apply is idempotent (re-apply is a no-op) so the reconciler can call
 * `provisionOrgDomain` on every reconcile. It is RUNTIME-GATED: no vanity → nothing to
 * do (`ready:true`); a vanity cert requested while cert-manager is absent →
 * `{ ready:false, skipped:true }` (fail-closed, never throws) so the reconciler records
 * the skip and the org still reaches `ready`.
 *
 * PRECONDITION: the org's bound namespace (`req.boundNamespace`) must already exist —
 * the reconciler fences it BEFORE calling this. A missing namespace is a precondition
 * fault the cert-manager client re-throws (NOT masked as "cert-manager absent").
 */
export class DefaultOrgDomainProvisioner implements OrgDomainProvisioner
{
  /** cert-manager Certificate operations (injected; fake in tests). */
  private readonly certs: CertManagerOperations;

  /** Static issuer config from the chart values. */
  private readonly config: OrgDomainProvisionerConfig;

  /**
   * @param certs  - cert-manager Certificate operations.
   * @param config - Issuer name/kind from the chart values.
   */
  public constructor(certs: CertManagerOperations, config: OrgDomainProvisionerConfig)
  {
    this.certs = certs;
    this.config = config;
  }

  /** @inheritdoc */
  public async provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>
  {
    const orgDomain = _BuildOrgDomain(req.orgName, req.platformBaseDomain);
    const vanity = req.vanityDomain?.trim();

    // No vanity domain → no per-org work: `<org>.<base>` is covered by the platform
    // `*.<base>` cert + record. The org host is ready as soon as it exists.
    if (!vanity)
    {
      return { orgDomain, ready: true, skipped: false };
    }

    // Vanity domain → issue a per-org certificate whose SAN is the vanity host. The
    // manifest is genuinely built and the apply IS issued; the client returns
    // certManagerInstalled:false (fail-closed, no crash) when there is no Certificate CRD.
    const tlsSecretName = _VanityCertName(req.orgName);
    const certificate = this._buildVanityCertificate(req, vanity, tlsSecretName);
    const readiness = await this.certs.applyCertificate(req.boundNamespace, certificate);

    if (!readiness.certManagerInstalled)
    {
      return {
        orgDomain,
        tlsSecretName,
        ready: false,
        skipped: true,
        message: readiness.reason ?? "cert-manager is unavailable; per-org vanity certificate not provisioned",
      };
    }

    return {
      orgDomain,
      tlsSecretName,
      ready: readiness.ready,
      skipped: false,
      message: readiness.ready ? undefined : readiness.reason,
    };
  }

  /** @inheritdoc */
  public async deprovisionOrgDomain(orgName: string, _platformBaseDomain: string, boundNamespace: string): Promise<void>
  {
    // Only the per-org vanity Certificate is ours to delete; a missing Certificate /
    // CRD are no-ops. (The canonical host carries no per-org cert/record.)
    await this.certs.deleteCertificate(boundNamespace, _VanityCertName(orgName));
  }

  /**
   * Build the per-org vanity Certificate CR — SAN = the customer-vanity host, the
   * configured issuer ref, and the per-org TLS Secret name. No wildcard SAN: there are
   * no per-user subdomains, and the canonical `<org>.<base>` is covered by the platform
   * `*.<base>` cert.
   *
   * @param req           - The provision request.
   * @param vanity        - The trimmed customer-vanity host.
   * @param tlsSecretName - The per-org TLS Secret name (also the Certificate name).
   * @returns The Certificate custom-resource manifest.
   */
  private _buildVanityCertificate(req: OrgDomainProvisionRequest, vanity: string, tlsSecretName: string): Record<string, unknown>
  {
    return {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: tlsSecretName,
        namespace: req.boundNamespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "app.kubernetes.io/component": "org-vanity-cert",
          "opencrane.io/cluster-tenant": req.orgName,
        },
      },
      spec: {
        secretName: tlsSecretName,
        issuerRef: {
          name: this.config.issuerName,
          kind: this.config.issuerKind,
        },
        dnsNames: [vanity],
      },
    };
  }
}
