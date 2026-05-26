import type { NormalizedDocument, OrgIndexDocumentConformanceIssue, OrgIndexDocumentConformanceResult } from "./domain/harvesting-agents/harvesting-agent.types.js";

/** Optional string metadata fields accepted by the org index schema v2 contract. */
const OPTIONAL_STRING_FIELDS = ["scope", "subject", "title", "confidentiality", "jurisdiction", "retentionClass"] as const;

/** Required timestamp metadata fields enforced by the org index schema v2 contract. */
const REQUIRED_TIMESTAMP_FIELDS = ["sourceUpdatedAt", "freshnessRecordedAt"] as const;

/** Strict UTC ISO-8601 timestamp pattern used by fleet awareness freshness metadata. */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Validate a normalized document against the Phase 4 org index schema v2 contract.
 *
 * The contract keeps source-specific enrichment flexible while guaranteeing that
 * every ingested record carries the lineage and freshness markers needed for
 * fleet-wide organizational awareness debugging.
 *
 * @param document - Connector-produced document candidate.
 * @returns Validation result containing any schema conformance issues.
 */
export function _ValidateOrgIndexDocument(document: NormalizedDocument): OrgIndexDocumentConformanceResult
{
  const issues: OrgIndexDocumentConformanceIssue[] = [];

  // 1. Validate required identity and payload fields so every record remains traceable.
  _pushRequiredStringIssue(issues, "source", document.source);
  _pushRequiredStringIssue(issues, "sourceId", document.sourceId);
  _pushRequiredStringIssue(issues, "owner", document.owner);
  _pushRequiredStringIssue(issues, "content", document.content);
  _pushRequiredStringIssue(issues, "aclOrigin", document.aclOrigin);
  _pushRequiredStringIssue(issues, "ingestCursor", document.ingestCursor);

  // 2. Validate optional org-shape metadata so connectors can enrich safely over time.
  for (const field of OPTIONAL_STRING_FIELDS)
  {
    _pushOptionalStringIssue(issues, field, document[field]);
  }

  if (!Array.isArray(document.sensitivityTags) || document.sensitivityTags.length === 0)
  {
    issues.push({
      field: "sensitivityTags",
      message: "must be a non-empty string array",
    });
  }
  else
  {
    for (const tag of document.sensitivityTags)
    {
      if (typeof tag !== "string" || tag.trim() === "")
      {
        issues.push({
          field: "sensitivityTags",
          message: "must contain only non-empty strings",
        });
        break;
      }
    }
  }

  // 3. Validate optional shareList entries when present.
  if (document.shareList !== undefined)
  {
    if (!Array.isArray(document.shareList))
    {
      issues.push({
        field: "shareList",
        message: "must be omitted or provided as an array of non-empty strings",
      });
    }
    else
    {
      for (const entry of document.shareList)
      {
        if (typeof entry !== "string" || entry.trim() === "")
        {
          issues.push({
            field: "shareList",
            message: "must contain only non-empty strings",
          });
          break;
        }
      }
    }
  }

  // 4. Validate freshness markers so later SLO checks can trust timestamp semantics.
  for (const field of REQUIRED_TIMESTAMP_FIELDS)
  {
    _pushRequiredTimestampIssue(issues, field, document[field]);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Append a conformance issue when a required string field is missing or blank.
 *
 * @param issues - Mutable accumulator for validation issues.
 * @param field  - Field name under validation.
 * @param value  - Candidate field value.
 */
function _pushRequiredStringIssue(
  issues: OrgIndexDocumentConformanceIssue[],
  field: string,
  value: unknown,
): void
{
  if (typeof value !== "string" || value.trim() === "")
  {
    issues.push({
      field,
      message: "must be a non-empty string",
    });
  }
}

/**
 * Append a conformance issue when an optional string field is present but invalid.
 *
 * @param issues - Mutable accumulator for validation issues.
 * @param field  - Field name under validation.
 * @param value  - Candidate field value.
 */
function _pushOptionalStringIssue(
  issues: OrgIndexDocumentConformanceIssue[],
  field: string,
  value: unknown,
): void
{
  if (value === undefined)
  {
    return;
  }

  if (typeof value !== "string" || value.trim() === "")
  {
    issues.push({
      field,
      message: "must be omitted or provided as a non-empty string",
    });
  }
}

/**
 * Append a conformance issue when a required timestamp field is missing or invalid.
 *
 * @param issues - Mutable accumulator for validation issues.
 * @param field  - Field name under validation.
 * @param value  - Candidate timestamp value.
 */
function _pushRequiredTimestampIssue(
  issues: OrgIndexDocumentConformanceIssue[],
  field: string,
  value: unknown,
): void
{
  if (typeof value !== "string" || !_isIsoTimestamp(value))
  {
    issues.push({
      field,
      message: "must be an ISO-8601 timestamp string",
    });
  }
}

/**
 * Determine whether a string can be safely interpreted as an ISO-8601 timestamp.
 *
 * @param value - Candidate timestamp string.
 * @returns True when the string round-trips through Date parsing.
 */
function _isIsoTimestamp(value: string): boolean
{
  if (!ISO_8601_UTC_PATTERN.test(value))
  {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}
