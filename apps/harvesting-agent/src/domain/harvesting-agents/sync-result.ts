/** Result summary returned after a connector sync cycle. */
export interface SyncResult
{
  /** Logical source name. */
  source: string;

  /** Number of documents upserted into the org index. */
  upsertedCount: number;

  /** Number of documents skipped because content had not changed. */
  skippedCount: number;

  /** Number of documents that failed to ingest. */
  failedCount: number;

  /** Updated cursor value to persist for the next cycle, or null if no progress. */
  nextCursor: string | null;

  /** Whether this sync cycle completed without errors. */
  success: boolean;

  /** Error message if the sync cycle failed entirely. */
  error?: string;
}
