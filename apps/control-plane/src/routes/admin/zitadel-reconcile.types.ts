/**
 * Types for the idempotent Zitadel reconcile/backfill (S3d).
 *
 * A ClusterTenant can carry a missing or partial Zitadel org — `zitadelOrgId`,
 * `zitadelClientId`, `zitadelAppId`, or `zitadelProjectId` null — when it was created
 * before Zitadel was configured, or when a provision half-failed. The reconcile route
 * re-runs `provisionOrg` for the gaps and heals the drift. These shapes describe its
 * request body and its per-CT outcome summary.
 */

/** Optional request body for the reconcile route: scope the run to a single ClusterTenant. */
export interface ZitadelReconcileRequest
{
  /** When set, reconcile ONLY this ClusterTenant (by name); when absent, scan the whole fleet. */
  name?: string;
}

/** A single skipped ClusterTenant and the reason it was not reconciled. */
export interface ZitadelReconcileSkip
{
  /** The ClusterTenant name. */
  name: string;
  /** Why it was skipped (`already-provisioned` or `no-owner`). */
  reason: ZitadelReconcileSkipReason;
}

/** The reasons a ClusterTenant is skipped during reconcile. */
export type ZitadelReconcileSkipReason = "already-provisioned" | "no-owner";

/** A single ClusterTenant whose reconcile FAILED, with the error detail. */
export interface ZitadelReconcileFailure
{
  /** The ClusterTenant name. */
  name: string;
  /** Human-readable error detail (never key material). */
  error: string;
}

/**
 * Summary of a reconcile run. Each ClusterTenant lands in exactly one bucket:
 * `reconciled` (provisionOrg ran + ids persisted), `skipped` (already complete, or no
 * Owner membership), or `failed` (provisionOrg or the persist threw — collected, not fatal).
 */
export interface ZitadelReconcileSummary
{
  /** Names of ClusterTenants whose Zitadel ids were (re-)provisioned and persisted. */
  reconciled: string[];
  /** ClusterTenants left untouched, with the reason. */
  skipped: ZitadelReconcileSkip[];
  /** ClusterTenants whose reconcile threw (a per-CT failure never aborts the run). */
  failed: ZitadelReconcileFailure[];
}
