/**
 * The minimum required citation for any awareness result (locked decision P4B.0):
 * a source title, a URI/link to the system of record, and a freshness timestamp.
 * The SDK guarantees every returned hit carries a complete citation.
 */
export interface Citation
{
  /** Source title (e.g. the document or message title). */
  title: string;
  /** URI/link to the system of record where the source can be opened. */
  uri: string;
  /** ISO-8601 freshness timestamp (when the source was last known current). */
  freshnessTimestamp: string;
}

/**
 * The raw, possibly-incomplete source metadata a Cognee hit carries, from which
 * a {@link Citation} is built. Field names mirror the org-index ingest metadata.
 */
export interface CitableSource
{
  /** Source title, if the connector captured one. */
  title?: string;
  /** Explicit URI to the system of record. */
  uri?: string;
  /** Alternate URL field some connectors use. */
  url?: string;
  /** Source-system update time (preferred freshness signal). */
  sourceUpdatedAt?: string;
  /** When the connector recorded freshness (freshness fallback). */
  freshnessRecordedAt?: string;
}
