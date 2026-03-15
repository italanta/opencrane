import type { KubernetesObject } from "@kubernetes/client-node";

/**
 * Specification for a Tenant custom resource, defining the desired state
 * of an OpenCrane tenant deployment.
 */
export interface TenantSpec
{
  /** Human-readable name for the tenant. */
  displayName: string;

  /** Contact email for the tenant owner. */
  email: string;

  /** Optional team identifier for grouping tenants. */
  team?: string;

  /** Custom container image override for the tenant pod. */
  openclawImage?: string;

  /** OpenClaw version to install (e.g. "latest", "2026.3.15"). Defaults to "latest". */
  openclawVersion?: string;

  /** Resource requests for the tenant container. */
  resources?: {
    /** CPU resource request (e.g. "500m"). */
    cpu?: string;
    /** Memory resource request (e.g. "256Mi"). */
    memory?: string;
  };

  /** List of skill names to enable for this tenant. */
  skills?: string[];

  /** Arbitrary OpenClaw config overrides merged into the base config. */
  configOverrides?: Record<string, unknown>;

  /** Name of an AccessPolicy CR to bind to this tenant. */
  policyRef?: string;

  /** When true, the tenant deployment is scaled to zero. */
  suspended?: boolean;
}

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

/**
 * Full Tenant custom resource, extending the base KubernetesObject
 * with a typed spec and optional status.
 */
export interface Tenant extends KubernetesObject
{
  /** Desired state of the tenant. */
  spec: TenantSpec;

  /** Observed state of the tenant, managed by the operator. */
  status?: TenantStatus;
}
