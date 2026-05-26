/**
 * Types shared across harvesting-agent connectors and ingestion pipeline flows.
 */

/** Normalized document produced by a source connector before writing to the org index. */
export interface NormalizedDocument
{
  /** Logical source name (e.g. "slack", "confluence"). */
  source: string;

  /** Source-system native identifier for deduplication (e.g. channel/ts for Slack). */
  sourceId: string;

  /** Owner identifier — team name or user email. */
  owner: string;

  /** Optional team scope for RBAC filtering. */
  teamScope?: string;

  /** Optional department scope for organization-aware retrieval. */
  departmentScope?: string;

  /** Optional project scope for project-aware retrieval. */
  projectScope?: string;

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

/** Single schema-conformance issue found while validating an org index document. */
export interface OrgIndexDocumentConformanceIssue
{
  /** Field name that failed validation. */
  field: string;

  /** Human-readable explanation of why the field is invalid. */
  message: string;
}

/** Result returned after validating an org index schema v2 document. */
export interface OrgIndexDocumentConformanceResult
{
  /** Whether the document satisfies the schema contract. */
  valid: boolean;

  /** Field-level issues that explain any validation failures. */
  issues: OrgIndexDocumentConformanceIssue[];
}

/** Stored org document fields needed to detect metadata drift without re-embedding. */
export interface StoredOrgDocumentSnapshot
{
  /** Stored content hash representing the last embedded document body. */
  contentHash: string | null;

  /** Stored owner identifier. */
  owner: string;

  /** Stored team scope. */
  teamScope: string | null;

  /** Stored department scope. */
  departmentScope: string | null;

  /** Stored project scope. */
  projectScope: string | null;

  /** Stored sensitivity tags. */
  sensitivityTags: string[];

  /** Stored title. */
  title: string | null;

  /** Stored confidentiality marker. */
  confidentiality: string | null;

  /** Stored jurisdiction marker. */
  jurisdiction: string | null;

  /** Stored retention class. */
  retentionClass: string | null;

  /** Stored ACL origin marker. */
  aclOrigin: string;

  /** Stored source update time. */
  sourceUpdatedAt: Date;

  /** Stored ingest cursor. */
  ingestCursor: string;

  /** Stored embedding-ready flag. */
  embeddingReady: boolean;
}

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

/** Ingest lag/error metrics exposed by the metrics endpoint. */
export interface IngestMetrics
{
  /** ISO-8601 timestamp when these metrics were sampled. */
  sampledAt: string;

  /** Per-source metrics records. */
  sources: SourceMetrics[];
}

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

/** Configuration for the Slack source connector. */
export interface SlackConnectorConfig
{
  /** Slack Bot OAuth token (xoxb-...). */
  botToken: string;

  /** List of Slack channel IDs to harvest. */
  channelIds: string[];

  /** Maximum messages to fetch per channel per sync cycle. */
  maxMessagesPerCycle: number;

  /** How long to wait between full sync cycles (milliseconds). */
  syncIntervalMs: number;
}
