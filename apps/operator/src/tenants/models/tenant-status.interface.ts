/**
 * Observed status of a Tenant custom resource, written by the operator
 * after each reconciliation loop.
 */
export interface TenantStatus
{
  /** Current lifecycle phase of the tenant. */
  phase: "Pending" | "Running" | "Suspended" | "Error";

  /** Name of the tenant pod managed by the deployment. */
  podName?: string;

  /** Hostname assigned to the tenant ingress. */
  ingressHost?: string;

  /** Human-readable message describing the current phase. */
  message?: string;

  /** ISO-8601 timestamp of the last successful reconciliation. */
  lastReconciled?: string;
}
