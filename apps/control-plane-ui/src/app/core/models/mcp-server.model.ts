import { GrantScope, type Grant } from "./grant.model";

/** Supported transport modes for MCP endpoints. */
export enum McpServerTransport
{
  StreamableHttp = "streamable-http",
  ServerSentEvents = "sse",
  WebSocket = "websocket",
}

/** Rollout state shown for a registered MCP server. */
export enum McpServerStatus
{
  Active = "active",
  Degraded = "degraded",
  Draft = "draft",
}

/** Phase 4 MCP server record returned to the UI. */
export interface McpServer
{
  /** Stable server identifier. */
  id: string;
  /** Display name used in the admin catalog. */
  name: string;
  /** Short operator-facing summary. */
  description: string;
  /** Gateway endpoint or upstream address. */
  endpoint: string;
  /** Primary organizational scope for the server. */
  scope: GrantScope;
  /** Transport contract used by the server. */
  transport: McpServerTransport;
  /** Current rollout status. */
  status: McpServerStatus;
  /** Capability labels surfaced in the UI. */
  capabilities: string[];
  /** Compiled grants for the server. */
  grants: Grant[];
  /** Optional upstream source label. */
  sourceName?: string;
  /** Last successful sync timestamp. */
  lastSyncedAt?: string;
}
