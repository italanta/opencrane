/**
 * Types shared across harvesting-agent connectors and ingestion pipeline flows.
 * Each type is defined in its own file; this module re-exports them all for
 * backward-compatible single-import access.
 */

export type { DocumentScope, NormalizedDocument } from "./normalized-document.js";
export type { OrgIndexDocumentConformanceIssue } from "./org-index-document-conformance-issue.js";
export type { OrgIndexDocumentConformanceResult } from "./org-index-document-conformance-result.js";
export type { SyncCursor } from "./sync-cursor.js";
export type { SyncResult } from "./sync-result.js";
export type { IngestMetrics } from "./ingest-metrics.js";
export type { SourceMetrics } from "./source-metrics.js";
export type { SlackConnectorConfig } from "./slack-connector-config.js";
