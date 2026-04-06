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

  /** Optional monthly budget for the tenant's LiteLLM virtual key (USD). */
  monthlyBudgetUsd?: number;

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
