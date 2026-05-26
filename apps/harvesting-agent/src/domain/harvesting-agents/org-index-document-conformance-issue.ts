/** Single schema-conformance issue found while validating an org index document. */
export interface OrgIndexDocumentConformanceIssue
{
  /** Field name that failed validation. */
  field: string;

  /** Human-readable explanation of why the field is invalid. */
  message: string;
}
