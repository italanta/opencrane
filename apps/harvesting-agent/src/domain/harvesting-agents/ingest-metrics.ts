import type { SourceMetrics } from "./source-metrics.js";

/** Ingest lag/error metrics exposed by the metrics endpoint. */
export interface IngestMetrics
{
  /** ISO-8601 timestamp when these metrics were sampled. */
  sampledAt: string;

  /** Per-source metrics records. */
  sources: SourceMetrics[];
}
