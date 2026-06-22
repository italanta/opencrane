/**
 * Per-org domain provisioning seam (fixed-wildcard topology), operator side.
 *
 * When an org (ClusterTenant) is reconciled it becomes addressable at its derived
 * apex `<name>.<base>` and its users at `<user>.<name>.<base>`. Two cluster-side side
 * effects must follow:
 *   1. DNS — a per-org wildcard record `*.<name>.<base>` → the cluster ingress IP, so
 *      every UserTenant gateway host under the org resolves with no per-user record.
 *   2. TLS — a per-org wildcard Certificate `*.<name>.<base>` (cert-manager DNS-01),
 *      because the platform `*.<base>` cert does NOT cover the extra label
 *      `<user>.<name>.<base>` (DNS wildcards match exactly one label).
 *
 * The operator owns this seam: it is the reconciler/executor that materialises the
 * cluster state. The concrete implementation is `DefaultOrgDomainProvisioner`
 * (org-domain.provisioner.js), wired by `_BuildOrgDomainProvisioner` from operator
 * config. It is RUNTIME-GATED by real capability detection — when cert-manager is
 * absent (the Certificate CRD is not served) and no Cloud DNS zone is configured, it
 * returns `{ ready:false, skipped:true }` rather than throwing; the reconciler then
 * records a `DomainProvisioningSkipped` condition and the org still reaches `ready`,
 * because the namespace boundary (not the cert) is the openclaw-attachment gate.
 */

/** Inputs the reconciler passes when provisioning an org's domain + TLS. */
export interface OrgDomainProvisionRequest
{
  /**
   * Org (ClusterTenant) name — the single DNS label, e.g. `acme`. Sourced from the
   * ClusterTenant CR's `metadata.name`, which Kubernetes already validates as an
   * RFC 1123 subdomain, so it is safe to use unescaped in derived hostnames, the
   * bound-namespace name, and Certificate label values.
   */
  orgName: string;
  /** Platform wildcard base the org hangs off, e.g. `weownai.eu`. */
  platformBaseDomain: string;
  /**
   * Optional customer-vanity domain CNAMEd onto the org apex (`<name>.<base>`). When
   * present, the implementation adds it (and its wildcard) to the issued certificate's
   * SANs so the org is browser-trusted under the vanity name too. DNS for the vanity
   * name itself is the customer's CNAME at their own provider — never created here.
   */
  vanityDomain?: string;
  /**
   * Cluster ingress external IP the per-org wildcard A record must point at. Optional:
   * when unset, the DNS side effect is skipped (no zone target) and only the
   * Certificate is applied — the reconciler still surfaces the skip.
   */
  ingressIp?: string;
}

/** Result reported back to the reconciler so it can stamp the org's status. */
export interface OrgDomainProvisionResult
{
  /** Canonical org apex the record + cert were provisioned for (`<name>.<base>`). */
  orgDomain: string;
  /** The per-org wildcard DNS name (`*.<name>.<base>`). */
  wildcardDnsName: string;
  /** Name of the cert-manager-managed TLS Secret holding the issued wildcard cert. */
  tlsSecretName?: string;
  /** Whether issuance completed. False while DNS-01 is in flight OR when skipped. */
  ready: boolean;
  /**
   * True when the backend (cert-manager / DNS) was unavailable and the step was
   * skipped gracefully. The reconciler surfaces this as a status condition; the org
   * still reaches `ready` because the namespace boundary is the attachment gate.
   */
  skipped: boolean;
  /** Human-readable detail, set when skipped or while issuance is in flight. */
  message?: string;
}

/** Backend that materialises an org's DNS record + wildcard TLS certificate. */
export interface OrgDomainProvisioner
{
  /**
   * Provision (idempotently) the per-org wildcard DNS record and TLS certificate.
   * Called by the ClusterTenant reconciler on every reconcile; safe to re-invoke.
   * MUST NOT throw on backend-unavailable — return `{ ready: false, skipped: true }`.
   *
   * @param req - Org coordinates, platform base, optional vanity domain, ingress IP.
   * @returns The provisioned apex, wildcard name, readiness, and skip flag.
   */
  provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>;

  /**
   * Tear down the per-org DNS record + certificate when the org is deleted. Idempotent:
   * a missing record / Certificate / CRD are all no-ops.
   *
   * @param orgName - The org (ClusterTenant) name being deprovisioned.
   * @param platformBaseDomain - The platform wildcard base the org hung off.
   */
  deprovisionOrgDomain(orgName: string, platformBaseDomain: string): Promise<void>;
}

/** The readiness a cert-manager Certificate reports once issuance completes. */
export interface CertificateReadiness
{
  /** Whether the Certificate's `Ready` condition is `True` (issuance complete). */
  ready: boolean;
  /** Whether cert-manager is installed (the Certificate CRD is served). */
  certManagerInstalled: boolean;
  /** Human-readable reason when not ready (condition message, or CRD-absent note). */
  reason?: string;
}

/**
 * Minimal interface over the cert-manager Certificate operations the
 * OrgDomainProvisioner needs. Injected so unit tests can substitute a fake without a
 * live cluster or the CustomObjectsApi.
 */
export interface CertManagerOperations
{
  /**
   * Apply (create-or-replace) a Certificate CR, idempotently. A re-apply carries the
   * live resourceVersion so it never conflicts. Surfaces `certManagerInstalled: false`
   * (fail-closed, never throws) when the Certificate CRD is absent.
   *
   * @param namespace - Namespace the Certificate (and its Secret) live in.
   * @param manifest  - The Certificate manifest to apply.
   * @returns The Certificate's readiness, including whether cert-manager is installed.
   */
  applyCertificate(namespace: string, manifest: Record<string, unknown>): Promise<CertificateReadiness>;

  /**
   * Delete the named Certificate if present; absence (404) and a missing CRD are both
   * no-ops (idempotent teardown).
   *
   * @param namespace - Namespace the Certificate lives in.
   * @param name      - Certificate name.
   */
  deleteCertificate(namespace: string, name: string): Promise<void>;
}

/**
 * Minimal interface over the Cloud DNS record operations the OrgDomainProvisioner
 * needs. Injected so unit tests can substitute a fake without importing the SDK.
 */
export interface CloudDnsOperations
{
  /**
   * Ensure an A record exists for `name` pointing at `rrdatas`, idempotently. A
   * re-apply with the same data is a no-op; an existing record with different data is
   * replaced. `name` is the fully-qualified record name WITHOUT a trailing dot (e.g.
   * `*.acme.weownai.eu`); implementations append the dot Cloud DNS requires.
   *
   * @param name    - FQDN of the record (no trailing dot).
   * @param rrdatas - Record data (the ingress IP for an A record).
   * @param ttl     - Record TTL in seconds.
   */
  ensureARecord(name: string, rrdatas: string[], ttl: number): Promise<void>;

  /**
   * Delete the A record `name` if present; absence is a no-op (idempotent teardown).
   *
   * @param name - FQDN of the record (no trailing dot).
   */
  deleteARecord(name: string): Promise<void>;
}

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
