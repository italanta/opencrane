/** Supported source kinds for Phase 4 discovery. */
export type ThirdPartySourceRouteKind = "mcp-registry" | "anthropic-skills" | "git-repository" | "manual-upload";

/** Supported sync and approval states for third-party sources. */
export type ThirdPartySourceRouteStatus = "healthy" | "syncing" | "error" | "pending-approval";

/** Supported discovered item kinds linked to a source. */
export type ThirdPartySourceItemRouteKind = "mcp-server" | "skill-bundle";

/** Request body used to create or update a source item. */
export interface ThirdPartySourceItemInput
{
  /** Upstream item kind. */
  kind: ThirdPartySourceItemRouteKind;
  /** Human-readable item name. */
  name: string;
  /** Stable upstream identifier. */
  upstreamId: string;
  /** Optional upstream version label. */
  version?: string;
  /** Optional OCI digest or content digest. */
  digest?: string;
  /** Optional raw metadata preserved for later install steps. */
  metadata?: Record<string, unknown>;
}

/** Request body used to create or update a third-party source. */
export interface ThirdPartySourceWriteRequest
{
  /** Human-readable source name. */
  name: string;
  /** Source integration kind. */
  kind: ThirdPartySourceRouteKind;
  /** Current sync or approval state. */
  status?: ThirdPartySourceRouteStatus;
  /** Source origin URL. */
  originUrl: string;
  /** Whether synchronization is scheduled or manual. */
  syncMode: "scheduled" | "manual";
  /** Optional last successful sync timestamp. */
  lastSyncedAt?: string;
  /** Optional next scheduler execution time. */
  nextRunAt?: string;
  /** Optional operator note. */
  notes?: string;
  /** Discovered items currently tracked for the source. */
  items?: ThirdPartySourceItemInput[];
}
