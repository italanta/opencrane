/**
 * API request/response types for the OpenCrane control plane.
 */

import type { PrismaClient } from "@prisma/client";
import type * as k8s from "@kubernetes/client-node";

/** Dependencies injected into the Express app for route handlers. */
export interface AppDependencies
{
  /** Prisma ORM client for PostgreSQL access. */
  prisma: PrismaClient;
  /** Kubernetes Custom Objects API client. */
  customApi: k8s.CustomObjectsApi;
  /** Kubernetes Core V1 API client. */
  coreApi: k8s.CoreV1Api;
}

/** Health check response shape. */
export interface HealthStatus
{
  /** Overall service status. */
  status: string;
  /** Whether the database is reachable. */
  db: boolean;
}

/** Request body for creating a new tenant. */
export interface CreateTenantRequest
{
  /** Unique tenant identifier. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Contact email for the tenant owner. */
  email: string;
  /** Optional team the tenant belongs to. */
  team?: string;
  /** Optional resource limits for the tenant sandbox. */
  resources?: {
    /** CPU limit (e.g. "500m"). */
    cpu?: string;
    /** Memory limit (e.g. "256Mi"). */
    memory?: string;
  };
  /** Optional list of skill names to pre-install. */
  skills?: string[];
  /** Optional reference to an AccessPolicy by name. */
  policyRef?: string;
}

/** Response shape returned when querying tenant details. */
export interface TenantResponse
{
  /** Unique tenant identifier. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Contact email for the tenant owner. */
  email: string;
  /** Optional team the tenant belongs to. */
  team?: string;
  /** Current lifecycle phase (e.g. "Running", "Pending"). */
  phase: string;
  /** Assigned ingress hostname, if provisioned. */
  ingressHost?: string;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
}

/** Metadata entry describing a shared skill. */
export interface SkillEntry
{
  /** Skill directory name. */
  name: string;
  /** Visibility scope of the skill. */
  scope: "org" | "team" | "tenant";
  /** Filesystem path to the skill directory. */
  path: string;
  /** Optional author identifier. */
  author?: string;
}

/** Request body for creating a new access policy. */
export interface CreatePolicyRequest
{
  /** Unique policy name. */
  name: string;
  /** Optional human-readable description. */
  description?: string;
  /** Selector that determines which tenants the policy applies to. */
  tenantSelector?: {
    /** Label key/value pairs to match. */
    matchLabels?: Record<string, string>;
    /** Team name to match. */
    matchTeam?: string;
  };
  /** Domain-level network restrictions. */
  domains?: {
    /** Allowed domain patterns. */
    allow?: string[];
    /** Denied domain patterns. */
    deny?: string[];
    /** Whether to deny all domains not explicitly allowed. */
    defaultDeny?: boolean;
  };
  /** Low-level egress CIDR rules. */
  egressRules?: Array<{
    /** CIDR block (e.g. "10.0.0.0/8"). */
    cidr: string;
    /** Allowed destination ports. */
    ports?: number[];
    /** Transport protocol. */
    protocol?: "TCP" | "UDP";
  }>;
  /** MCP server access restrictions. */
  mcpServers?: {
    /** Allowed MCP server names. */
    allow?: string[];
    /** Denied MCP server names. */
    deny?: string[];
  };
}

/** Single entry in the audit log. */
export interface AuditEntry
{
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Tenant name the event relates to, if applicable. */
  tenant?: string;
  /** Action or reason code (e.g. "Created", "Deleted"). */
  action: string;
  /** Resource reference (e.g. "Tenant/my-tenant"). */
  resource: string;
  /** Human-readable event message. */
  message: string;
}
