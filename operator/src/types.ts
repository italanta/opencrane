import type { KubernetesObject } from "@kubernetes/client-node";

// -- Tenant CRD --

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

// -- AccessPolicy CRD --

/**
 * Specification for an AccessPolicy custom resource, defining network
 * egress rules and domain allowlists for matched tenants.
 */
export interface AccessPolicySpec
{
  /** Human-readable description of the policy purpose. */
  description?: string;

  /** Selector to match tenants this policy applies to. */
  tenantSelector?: {
    /** Label key-value pairs that must match the tenant pod. */
    matchLabels?: Record<string, string>;
    /** Team name to match against the tenant team label. */
    matchTeam?: string;
  };

  /** Domain-based filtering rules (requires Cilium for enforcement). */
  domains?: {
    /** Allowed domain patterns (supports wildcards). */
    allow?: string[];
    /** Denied domain patterns. */
    deny?: string[];
    /** When true, all domains are denied unless explicitly allowed. */
    defaultDeny?: boolean;
  };

  /** IP-based egress rules translated into Kubernetes NetworkPolicy. */
  egressRules?: Array<{
    /** CIDR block to allow egress to. */
    cidr: string;
    /** Destination ports (defaults to [443] if omitted). */
    ports?: number[];
    /** Transport protocol (defaults to "TCP"). */
    protocol?: "TCP" | "UDP";
  }>;

  /** MCP server allowlist/denylist for tenant tool access. */
  mcpServers?: {
    /** Allowed MCP server identifiers. */
    allow?: string[];
    /** Denied MCP server identifiers. */
    deny?: string[];
  };
}

/**
 * Full AccessPolicy custom resource, extending the base KubernetesObject
 * with a typed spec.
 */
export interface AccessPolicy extends KubernetesObject
{
  /** Policy specification. */
  spec: AccessPolicySpec;
}

// -- Operator config (from env) --

/**
 * Runtime configuration for the operator, loaded from environment variables.
 */
export interface OperatorConfig
{
  /** Namespace to watch for CRDs (empty string watches all namespaces). */
  watchNamespace: string;

  /** Default container image used for tenant deployments. */
  tenantDefaultImage: string;

  /** Base domain for tenant ingress hostnames. */
  ingressDomain: string;

  /** Kubernetes ingress class to annotate on tenant ingresses. */
  ingressClassName: string;

  /** Name of the shared PVC mounted read-only into every tenant pod. */
  sharedSkillsPvcName: string;

  /** Port number exposed by the OpenClaw gateway inside tenant pods. */
  gatewayPort: number;
}

/**
 * Load the operator configuration from environment variables, falling back
 * to sensible defaults for local development.
 */
export function loadOperatorConfig(): OperatorConfig
{
  return {
    watchNamespace: process.env.WATCH_NAMESPACE ?? "",
    tenantDefaultImage: process.env.TENANT_DEFAULT_IMAGE ?? "ghcr.io/opencrane/tenant:latest",
    ingressDomain: process.env.INGRESS_DOMAIN ?? "opencrane.local",
    ingressClassName: process.env.INGRESS_CLASS_NAME ?? "nginx",
    sharedSkillsPvcName: process.env.SHARED_SKILLS_PVC_NAME ?? "opencrane-shared-skills",
    gatewayPort: Number(process.env.GATEWAY_PORT ?? "18789"),
  };
}
