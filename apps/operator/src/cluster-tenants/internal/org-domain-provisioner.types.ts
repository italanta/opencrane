/**
 * Per-org domain provisioning seam (single-per-org-host topology), operator side.
 *
 * Every user in an org is served at the org's SINGLE host `<name>.<base>` (the
 * identity-routing gateway proxy routes by session identity, not by hostname), so
 * there are NO per-user subdomains. That collapses the per-org domain work to almost
 * nothing:
 *   - **DNS** — `<name>.<base>` is one label under the platform base, already covered
 *     by the platform wildcard `*.<base>` record created once at install. So there is
 *     NO per-org DNS record and NO external-dns DNSEndpoint.
 *   - **TLS** — `<name>.<base>` is likewise covered by the platform `*.<base>`
 *     certificate. A per-org certificate is needed ONLY for a customer-vanity domain
 *     (`ai.client-co.com`), which sits under no platform base; the customer CNAMEs it
 *     onto `<name>.<base>` so an HTTP-01 challenge on that host succeeds.
 *
 * The operator owns this seam. The concrete implementation is
 * `DefaultOrgDomainProvisioner`, wired by `_BuildOrgDomainProvisioner`. It is
 * RUNTIME-GATED: when there is no vanity domain there is simply nothing to do, and when
 * a vanity cert is requested but cert-manager is absent it returns
 * `{ ready:false, skipped:true }` rather than throwing — the reconciler records the
 * skip and the org still reaches `ready` (the namespace boundary, not the cert, is the
 * openclaw-attachment gate).
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
  /**
   * The org's bound namespace (the reconciler derives it once via the shared-cluster
   * provisioner and passes it here), where any per-org `Certificate` is created. Passed
   * in rather than re-derived so namespace derivation lives in exactly one place.
   */
  boundNamespace: string;
  /** Platform wildcard base the org hangs off, e.g. `weownai.eu`. */
  platformBaseDomain: string;
  /**
   * Optional customer-vanity domain CNAMEd onto the org host (`<name>.<base>`). When
   * present, the implementation issues a per-org certificate whose SAN is the vanity
   * name so the org is browser-trusted under it. DNS for the vanity name itself is the
   * customer's CNAME at their own provider — never created here. When ABSENT there is
   * no per-org work: `<name>.<base>` is covered by the platform `*.<base>` cert/record.
   */
  vanityDomain?: string;
}

/** Result reported back to the reconciler so it can stamp the org's status. */
export interface OrgDomainProvisionResult
{
  /** Canonical org host (`<name>.<base>`) the org is served at. */
  orgDomain: string;
  /** Name of the cert-manager-managed TLS Secret, when a vanity cert was issued. */
  tlsSecretName?: string;
  /** Whether per-org TLS is ready. True when there is no vanity work (platform cert covers it). */
  ready: boolean;
  /**
   * True when a vanity cert was requested but the backend (cert-manager) was
   * unavailable and the step was skipped gracefully. The reconciler surfaces this as a
   * status condition; the org still reaches `ready` because the namespace boundary is
   * the attachment gate.
   */
  skipped: boolean;
  /** Human-readable detail, set when skipped or while issuance is in flight. */
  message?: string;
}

/** Backend that materialises an org's (vanity) TLS certificate. */
export interface OrgDomainProvisioner
{
  /**
   * Provision (idempotently) the per-org vanity TLS certificate, if any. Called by the
   * ClusterTenant reconciler on every reconcile; safe to re-invoke. MUST NOT throw on
   * backend-unavailable — return `{ ready: false, skipped: true }`.
   *
   * @param req - Org coordinates, platform base, optional vanity domain.
   * @returns The org host, TLS secret name (if a vanity cert was issued), readiness, skip.
   */
  provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>;

  /**
   * Tear down the per-org vanity certificate when the org is deleted. Idempotent: a
   * missing Certificate / CRD are no-ops.
   *
   * @param orgName - The org (ClusterTenant) name being deprovisioned.
   * @param platformBaseDomain - The platform wildcard base the org hung off.
   * @param boundNamespace - The org's bound namespace the Certificate lives in.
   */
  deprovisionOrgDomain(orgName: string, platformBaseDomain: string, boundNamespace: string): Promise<void>;
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
 * Static config the provisioner needs to author the per-org Certificate, supplied
 * from the chart's `certManager` values (issuerName / issuer kind). Injected so the
 * provisioner carries no environment reads. The bound namespace is NOT here — it
 * arrives per-request (`OrgDomainProvisionRequest.boundNamespace`) so namespace
 * derivation stays in one place (the shared-cluster provisioner).
 */
export interface OrgDomainProvisionerConfig
{
  /** cert-manager issuer name the Certificate references (chart `certManager.issuerName`). */
  issuerName: string;
  /** Issuer kind: a cluster-singleton `ClusterIssuer` (default) or namespaced `Issuer`. */
  issuerKind: "ClusterIssuer" | "Issuer";
}
