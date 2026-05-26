/** Scope category for a normalized document used for RBAC filtering and dataset routing. */
export type DocumentScope = "team" | "department" | "project";

/** Normalized document produced by a source connector before writing to the org index. */
export interface NormalizedDocument
{
  /** Logical source name (e.g. "slack", "confluence"). */
  source: string;

  /** Source-system native identifier for deduplication (e.g. channel/ts for Slack). */
  sourceId: string;

  /** Owner identifier — team name or user email. */
  owner: string;

  /** Scope category for RBAC filtering and dataset routing (team, department, or project). */
  scope?: DocumentScope;

  /** Subject identifier associated with the scope (e.g. team ID, department ID, project ID). */
  subject?: string;

  /**
   * List of individual user identifiers this document is explicitly shared with.
   * Always evaluated in addition to scope + subject during access checks.
   */
  shareList?: string[];

  /** Sensitivity classification tags applied by the connector. */
  sensitivityTags: string[];

  /** Document title, if available. */
  title?: string;

  /** Full plain-text content of the document. */
  content: string;

  /** Optional confidentiality marker carried from the source system. */
  confidentiality?: string;

  /** Optional jurisdiction marker carried from the source system. */
  jurisdiction?: string;

  /** Optional retention class marker carried from the source system. */
  retentionClass?: string;

  /** ACL lineage marker describing which source ACL model produced this record. */
  aclOrigin: string;

  /** Source-system update time used for freshness evaluation. */
  sourceUpdatedAt: string;

  /** Timestamp when the connector captured freshness metadata for this record. */
  freshnessRecordedAt: string;

  /** Connector cursor value associated with this document during ingestion. */
  ingestCursor: string;
}
