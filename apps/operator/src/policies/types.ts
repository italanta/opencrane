import type { KubernetesObject } from "@kubernetes/client-node";

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
 * Observed status of an AccessPolicy custom resource, written by the
 * operator after each reconciliation.
 */
export interface AccessPolicyStatus
{
  /** ISO-8601 timestamp of the last successful reconciliation. */
  lastReconciled?: string;
}

/**
 * Full AccessPolicy custom resource, extending the base KubernetesObject
 * with a typed spec and optional status.
 */
export interface AccessPolicy extends KubernetesObject
{
  /** Policy specification. */
  spec: AccessPolicySpec;

  /** Observed state, managed by the operator. */
  status?: AccessPolicyStatus;
}
