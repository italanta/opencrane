/**
 * Observed status of a Tenant custom resource, written by the operator
 * after each reconciliation loop.
 */
export enum TenantStatusPhase
{
  /** Tenant has been created but workloads are not fully reconciled yet. */
  Pending = "Pending",

  /** Tenant workloads are provisioned and serving traffic. */
  Running = "Running",

  /** Tenant workload is intentionally scaled down to zero replicas. */
  Suspended = "Suspended",

  /** Reconciliation failed and operator recorded the latest error message. */
  Error = "Error",
}

/** Resolution state for how tenant policy assignment was computed. */
export enum TenantPolicyResolutionState
{
  /** Effective policy was resolved successfully. */
  Resolved = "Resolved",

  /** No policy applies and no default policy is configured. */
  NoPolicy = "NoPolicy",

  /** Tenant references a policy that does not exist. */
  PolicyNotFound = "PolicyNotFound",

  /** More than one selector-based policy matched the tenant. */
  PolicyConflict = "PolicyConflict",

  /** Configured default policy name was not found. */
  DefaultPolicyNotFound = "DefaultPolicyNotFound",
}

/** Source that produced the effective policy assignment. */
export type TenantPolicyResolutionSource = "policyRef" | "selector" | "default" | "none";

/**
 * Observed status of a Tenant custom resource, written by the operator
 * after each reconciliation loop.
 */
export interface TenantStatus
{
  /** Current lifecycle phase of the tenant. */
  phase: TenantStatusPhase;

  /** Name of the tenant pod managed by the deployment. */
  podName?: string;

  /** Hostname assigned to the tenant ingress. */
  ingressHost?: string;

  /** Human-readable message describing the current phase. */
  message?: string;

  /** Name of the policy currently resolved as effective for this tenant. */
  effectivePolicyRef?: string;

  /** Source used to resolve the effective policy. */
  policyResolutionSource?: TenantPolicyResolutionSource;

  /** Resolution state of tenant policy assignment. */
  policyResolutionState?: TenantPolicyResolutionState;

  /** ISO-8601 timestamp of the last successful reconciliation. */
  lastReconciled?: string;
}
