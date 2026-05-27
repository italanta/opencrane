/** Access decision applied to a scope-aware grant. */
export enum GrantAccess
{
  Allow = "allow",
  Deny = "deny",
}

/** Supported organizational scopes for entitlement rules. */
export enum GrantScope
{
  Org = "org",
  Department = "department",
  Project = "project",
  Personal = "personal",
}

/** Supported principal types for grant targets. */
export type GrantSubjectType = "group" | "tenant" | "user";

/** Permission grant compiled into MCP and skill entitlements. */
export interface Grant
{
  /** Stable grant identifier. */
  id: string;
  /** Organizational scope where the grant applies. */
  scope: GrantScope;
  /** Principal type receiving the grant. */
  subjectType: GrantSubjectType;
  /** Principal name rendered in the UI. */
  subjectName: string;
  /** Allow or deny decision. */
  access: GrantAccess;
  /** Optional inline operator note. */
  note?: string;
}
