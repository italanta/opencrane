/**
 * Per-org domain provisioning seam (fixed-wildcard topology).
 *
 * When an org (ClusterTenant) is created, it becomes addressable at its derived apex
 * `<name>.<platformBaseDomain>` and its users at `<user>.<name>.<base>`. Two
 * cluster-side side effects must follow:
 *   1. DNS — a per-org wildcard record `*.<name>.<base>` → the cluster ingress IP, so
 *      every UserTenant gateway host under the org resolves with no per-user record.
 *   2. TLS — a per-org wildcard Certificate `*.<name>.<base>` (cert-manager DNS-01),
 *      because the platform `*.<base>` cert does NOT cover the extra label
 *      `<user>.<name>.<base>` (DNS wildcards match exactly one label).
 *
 * This module defines the interface. The concrete implementation is
 * `DefaultOrgDomainProvisioner` (org-domain.provisioner.js), wired from env via
 * `_BuildOrgDomainProvisioner`: it applies the per-org wildcard Certificate through
 * cert-manager (DNS-01) and the per-org A records through the terraform-managed
 * Cloud DNS zone. The ClusterTenant operator/CR watcher that CALLS it on the
 * `pending → ready` reconcile lands with that reconciler. The control-plane create
 * flow (`routes/cluster-tenants.ts → _createClusterTenant`) persists desired state
 * and hands off to that reconciler; the reconciler invokes `provisionOrgDomain(...)`.
 *
 * Keeping the create path free of live cert-manager / Cloud DNS calls (they run only
 * from the reconciler, behind this interface) preserves the API-first, fail-closed
 * posture: a malformed or unauthorised create never reaches DNS or TLS issuance, and
 * the side effects are idempotent and separately ownable.
 */

/** Inputs the reconciler passes when provisioning an org's domain + TLS. */
export interface OrgDomainProvisionRequest
{
  /** Org (ClusterTenant) name — the single DNS label, e.g. `acme`. */
  orgName: string;
  /** Platform wildcard base the org hangs off, e.g. `weownai.eu`. */
  platformBaseDomain: string;
  /**
   * Optional customer-vanity domain CNAMEd onto the org apex (`<name>.<base>`). When
   * present, the implementation SHOULD add it to the issued certificate's SANs so the
   * org is browser-trusted under the vanity name too. DNS for the vanity name itself
   * is the customer's CNAME at their own provider — never created here.
   */
  vanityDomain?: string;
  /** Cluster ingress external IP the per-org wildcard A record must point at. */
  ingressIp: string;
}

/** Result reported back to the reconciler so it can stamp the org's status. */
export interface OrgDomainProvisionResult
{
  /** Canonical org apex the record + cert were provisioned for (`<name>.<base>`). */
  orgDomain: string;
  /** The per-org wildcard DNS name created (`*.<name>.<base>`). */
  wildcardDnsName: string;
  /** Name of the cert-manager-managed TLS Secret holding the issued wildcard cert. */
  tlsSecretName: string;
  /** Whether issuance has completed (false while DNS-01 is still in flight). */
  ready: boolean;
}

/**
 * Backend that materialises an org's DNS record + wildcard TLS certificate. The
 * concrete implementation is `DefaultOrgDomainProvisioner`; callers depend only on
 * this signature so the provisioner and the reconciler that drives it can be built
 * and tested independently (mirrors the `ClusterTenantProvisioner` seam).
 */
export interface OrgDomainProvisioner
{
  /**
   * Provision (idempotently) the per-org wildcard DNS record and TLS certificate.
   * Called by the ClusterTenant reconciler on the `pending → ready` transition; safe
   * to re-invoke on every reconcile.
   *
   * @param req - The org coordinates, platform base, optional vanity domain, ingress IP.
   * @returns The provisioned apex, wildcard name, TLS Secret name, and readiness.
   */
  provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>;

  /**
   * Tear down the per-org DNS record + certificate when the org is deleted.
   *
   * @param orgName - The org (ClusterTenant) name being deprovisioned.
   * @param platformBaseDomain - The platform wildcard base the org hung off.
   */
  deprovisionOrgDomain(orgName: string, platformBaseDomain: string): Promise<void>;
}
