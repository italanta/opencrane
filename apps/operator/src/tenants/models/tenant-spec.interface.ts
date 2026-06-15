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

  /**
   * Durable per-tenant skill name allowlist.
   * When present, only skills in this list are linked at startup.
   */
  skillAllowlist?: string[];

  /**
   * Per-tenant MCP server allow/deny policy applied at invocation level.
   * Complements the AccessPolicy mcpServers field with tenant-specific overrides.
   */
  mcpPolicy?: {
    /** MCP server names explicitly allowed for this tenant. */
    allow?: string[];
    /** MCP server names explicitly denied for this tenant. */
    deny?: string[];
  };

  /** Channel adapter configuration for tenant communication integrations. */
  channels?: Array<{
    /** Adapter identifier (e.g. "slack", "whatsapp", "teams", "sharepoint"). */
    adapter: string;
    /** Adapter configuration payload understood by the selected adapter implementation. */
    config?: Record<string, unknown>;
    /** Optional Kubernetes Secret name containing adapter credentials. */
    credentialsSecretName?: string;
  }>;

  /** Arbitrary OpenClaw config overrides merged into the base config. */
  configOverrides?: Record<string, unknown>;

  /** Name of an AccessPolicy CR to bind to this tenant. */
  policyRef?: string;

  /**
   * Optional name of the parent ClusterTenant (the first-class customer /
   * isolation unit this openclaw belongs to). When set, the operator resolves
   * the parent's bound namespace and compute/quota policy and deploys the
   * openclaw there. When absent, the openclaw attaches to the implicit default
   * cluster tenant bound to the install namespace — single-install behaviour is
   * unchanged and multi-tenancy stays opt-in.
   */
  clusterTenantRef?: string;

  /** When true, the tenant deployment is scaled to zero. */
  suspended?: boolean;
}
