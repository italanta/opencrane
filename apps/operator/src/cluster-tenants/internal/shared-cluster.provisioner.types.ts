/**
 * Types for the operator-local shared-cluster boundary provisioner. Split from
 * `shared-cluster.provisioner.ts` so that file carries only behaviour (the namespace
 * derivation + the boundary resolution), mirroring the `*.types.ts` convention used by
 * `org-domain-provisioner.types.ts`.
 */

/** Lifecycle phase the reconciler stamps onto a ClusterTenant's status. */
export enum ClusterTenantReconcilePhase
{
  /** Accepted but not yet acted on. */
  Pending = "pending",
  /** A provisioner is building the customer's boundary. */
  Provisioning = "provisioning",
  /** The boundary exists and openclaws can attach. */
  Ready = "ready",
  /** Provisioning failed; see `message`. */
  Failed = "failed",
}

/** The outcome of resolving an org's isolation boundary. */
export interface BoundaryProvisionResult
{
  /** Resulting lifecycle phase. */
  phase: ClusterTenantReconcilePhase;
  /** The namespace bound to the customer, when provisioned. */
  boundNamespace?: string;
  /** Identifier of the provisioner that owns the boundary. */
  provisioner?: string;
  /** Human-readable detail, set on failure. */
  message?: string;
}
