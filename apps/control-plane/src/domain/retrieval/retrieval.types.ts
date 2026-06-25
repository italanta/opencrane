/**
 * Types for the org knowledge retrieval API.
 * Shared between the retrieval route and conformance tests.
 */

/** Dataset scopes supported by retrieval authorization and dataset partitioning. */
export enum DatasetScope
{
  Org = "org",
  Team = "team",
  Department = "department",
  Project = "project",
  Personal = "personal",
}

/** Request body for a retrieval query. */
export interface RetrievalQueryRequest
{
  /** Full-text search query string. */
  query: string;

  /** Tenant name used to resolve the AccessPolicy for authorization. */
  tenantName: string;

  /** Optional team scope to restrict results to documents owned by a team. */
  teamScope?: string;

  /** Dataset scope used for AccessPolicy-compatible dataset authorization (defaults to "org"). */
  datasetScope?: DatasetScope;

  /** Dataset identifier inside the selected scope (defaults to "default" for org scope). */
  datasetId?: string;

  /** Maximum number of results to return (default: 20, max: 100). */
  limit?: number;
}

/** A single document result returned from the org index. */
export interface RetrievalResult
{
  /** Unique document identifier. */
  id: string;

  /** Source system that produced this document (e.g. "slack", "confluence"). */
  source: string;

  /** Source-system native identifier for deduplication. */
  sourceId: string;

  /** Owner identifier (team name or user email). */
  owner: string;

  /** Optional team scope the document belongs to. */
  teamScope?: string;

  /** Sensitivity classification tags applied during ingestion. */
  sensitivityTags: string[];

  /** Document title, if available. */
  title?: string;

  /** Plain-text content excerpt (may be truncated for large documents). */
  contentExcerpt: string;

  /** ISO-8601 ingestion timestamp. */
  ingestedAt: string;
}

/** Successful retrieval response. */
export interface RetrievalQueryResponse
{
  /** Documents that matched the query and passed authorization checks. */
  results: RetrievalResult[];

  /** Total number of results returned (may be less than total matching). */
  count: number;

  /** Authorization outcome written to the audit log. */
  authOutcome: "allowed" | "denied";

  /** ISO-8601 timestamp of when this query was evaluated. */
  queriedAt: string;

  /** Effective dataset scope used for this query. */
  datasetScope: DatasetScope;

  /** Effective dataset identifier used for this query. */
  datasetId: string;
}

/** Retrieval error response body. */
export interface RetrievalErrorResponse
{
  /** Machine-readable error code. */
  code: "UNAUTHORIZED" | "TENANT_NOT_FOUND" | "POLICY_DENIED" | "INTERNAL_ERROR";

  /** Human-readable error description. */
  error: string;
}
