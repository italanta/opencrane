/** Source kinds supported by the external ingestion surface. */
export enum ThirdPartySourceKind
{
  McpRegistry = "mcp-registry",
  AnthropicSkills = "anthropic-skills",
  GitRepository = "git-repository",
  ManualUpload = "manual-upload",
}

/** Sync health states shown for upstream sources. */
export enum ThirdPartySourceStatus
{
  Healthy = "healthy",
  Syncing = "syncing",
  Error = "error",
  PendingApproval = "pending-approval",
}

/** External source registered for MCP or skill discovery. */
export interface ThirdPartySource
{
  /** Stable source identifier. */
  id: string;
  /** Human-readable source name. */
  name: string;
  /** Source integration kind. */
  kind: ThirdPartySourceKind;
  /** Current sync or approval state. */
  status: ThirdPartySourceStatus;
  /** Source origin URL. */
  originUrl: string;
  /** Number of managed items discovered from the source. */
  managedItemCount: number;
  /** Whether synchronization is scheduled or manual. */
  syncMode: "scheduled" | "manual";
  /** Last successful sync timestamp. */
  lastSyncedAt?: string;
  /** Next scheduler execution time when applicable. */
  nextRunAt?: string;
  /** Optional operator note. */
  notes?: string;
}
