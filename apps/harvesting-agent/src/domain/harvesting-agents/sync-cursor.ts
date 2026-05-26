/** Cursor value persisted between sync cycles for incremental ingestion. */
export interface SyncCursor
{
  /** Logical source name that owns this cursor. */
  source: string;

  /** Opaque cursor value (e.g. a timestamp or page token). */
  cursorValue: string;

  /** ISO-8601 timestamp of the last successful sync. */
  lastSyncAt: string;
}
