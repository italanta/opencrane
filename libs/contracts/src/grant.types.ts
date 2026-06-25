/**
 * Access outcome attached to a compiled authorization grant.
 *
 * The control-plane persists these values, returns them through its HTTP APIs,
 * and the operator UI renders the same values without redefining them locally.
 */
export enum GrantAccess
{
  Allow = "allow",
  Deny = "deny",
}

/**
 * Organizational scope carried by a grant or entitlement target.
 *
 * These values describe the logical domain boundary where a decision applies.
 * They are part of the shared API contract consumed by both the backend and UI.
 */
export enum GrantScope
{
  Org = "org",
  Department = "department",
  Team = "team",
  Project = "project",
  Personal = "personal",
}

/**
 * Principal family referenced by a grant.
 *
 * A grant may target a reusable group, a tenant identity, or an individual user.
 */
export enum GrantSubjectType
{
  Group = "group",
  Tenant = "tenant",
  User = "user",
}

/**
 * Shared transport contract for an evaluated grant row.
 *
 * This type is intentionally defined outside the UI because it is not a
 * presentation-only concern: the control-plane emits it and the UI consumes it
 * as-is when rendering effective entitlements.
 */
export interface Grant
{
  /** Stable grant identifier. */
  id: string;
  /** Organizational scope where the grant applies. */
  scope: GrantScope;
  /** Principal family receiving the decision. */
  subjectType: GrantSubjectType;
  /** Stable principal identifier used by the compiler. */
  subjectId: string;
  /** Human-readable principal label shown to operators. */
  subjectName: string;
  /** Allow or deny decision. */
  access: GrantAccess;
  /** Optional precedence value surfaced when the API includes it. */
  priority?: number;
  /** Optional inline operator note. */
  note?: string;
}
