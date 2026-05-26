/** Metrics for a single source connector. */
export interface SourceMetrics
{
  /** Logical source name. */
  source: string;

  /** Total documents ingested across all time. */
  totalIngested: number;

  /** ISO-8601 timestamp of the last sync for this source. */
  lastSyncAt: string | null;

  /** Lag in seconds between now and the last successful sync. */
  lagSeconds: number | null;

  /** Whether the last sync cycle succeeded. */
  lastSyncSuccess: boolean;

  /** Error message from the last failed sync cycle, if any. */
  lastError?: string;
}
