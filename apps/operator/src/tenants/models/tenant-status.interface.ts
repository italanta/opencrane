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

  /** ISO-8601 timestamp of the last successful reconciliation. */
  lastReconciled?: string;
}
