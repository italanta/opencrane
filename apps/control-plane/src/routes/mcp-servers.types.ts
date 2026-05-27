/** Supported organizational scopes for MCP server inventory. */
export type McpServerRouteScope = "org" | "department" | "project" | "personal";

/** Supported access outcomes for MCP grants. */
export type McpServerRouteAccess = "allow" | "deny";

/** Supported subject types for MCP grants. */
export type McpServerRouteSubjectType = "group" | "tenant" | "user";

/** Supported transport modes for MCP endpoints. */
export type McpServerRouteTransport = "streamable-http" | "sse" | "websocket";

/** Supported rollout states for MCP servers. */
export type McpServerRouteStatus = "active" | "degraded" | "draft";

/** Request body used to create or update a dedicated MCP credential record. */
export interface McpServerCredentialInput
{
  /** Operator-facing label for the credential. */
  displayName: string;
  /** Secret reference consumed by the future gateway reconcile path. */
  secretRef: string;
}

/** Request body used to create or update an MCP server grant. */
export interface McpServerGrantInput
{
  /** Organizational scope carried by the grant. */
  scope: McpServerRouteScope;
  /** Subject family receiving the grant. */
  subjectType: McpServerRouteSubjectType;
  /** Subject identifier used by the compiler. */
  subjectId?: string;
  /** Human-friendly subject label accepted for group lookups. */
  subjectName: string;
  /** Allow or deny outcome. */
  access: McpServerRouteAccess;
  /** Higher values override lower-priority grants. */
  priority?: number;
  /** Optional operator note. */
  note?: string;
}

/** Request body used to create or update an MCP server. */
export interface McpServerWriteRequest
{
  /** Display name shown in the MCP catalog. */
  name: string;
  /** Short operator-facing summary. */
  description?: string;
  /** Gateway endpoint or upstream address. */
  endpoint: string;
  /** Primary organizational scope for the server. */
  scope: McpServerRouteScope;
  /** Transport contract used by the server. */
  transport: McpServerRouteTransport;
  /** Current rollout status. */
  status?: McpServerRouteStatus;
  /** Capability labels surfaced in the UI. */
  capabilities?: string[];
  /** Optional upstream source identifier. */
  sourceId?: string;
  /** Optional sync timestamp. */
  lastSyncedAt?: string;
  /** Compiled grants for the server. */
  grants?: McpServerGrantInput[];
  /** Credential metadata owned by the future gateway broker. */
  credentials?: McpServerCredentialInput[];
}
