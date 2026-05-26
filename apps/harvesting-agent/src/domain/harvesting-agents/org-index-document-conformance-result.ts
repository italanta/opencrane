import type { OrgIndexDocumentConformanceIssue } from "./org-index-document-conformance-issue.js";

/** Result returned after validating an org index schema v2 document. */
export interface OrgIndexDocumentConformanceResult
{
  /** Whether the document satisfies the schema contract. */
  valid: boolean;

  /** Field-level issues that explain any validation failures. */
  issues: OrgIndexDocumentConformanceIssue[];
}
