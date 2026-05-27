/** Supported payload types compiled from the generic Grant table. */
export type GrantCompilerPayloadType = "awareness" | "mcp-server" | "skill-bundle";

/** Allow/deny access result returned by the compiler. */
export type GrantCompilerAccess = "allow" | "deny";

/** Subject types recognized by the compiler. */
export type GrantCompilerSubjectType = "group" | "tenant" | "user";

/** Organizational scope attached to a grant. */
export type GrantCompilerScope = "org" | "department" | "project" | "personal";

/** Final compiler decision for a single payload target. */
export interface CompiledGrantDecision
{
  /** Stable grant identifier that won evaluation for the payload. */
  grantId: string;
  /** Payload family compiled by the caller. */
  payloadType: GrantCompilerPayloadType;
  /** Specific payload identifier inside the family. */
  payloadId: string;
  /** Final allow/deny result after precedence rules are applied. */
  access: GrantCompilerAccess;
  /** Winning grant priority. */
  priority: number;
  /** Scope attached to the winning grant. */
  scope: GrantCompilerScope;
  /** Subject family that matched the principal. */
  subjectType: GrantCompilerSubjectType;
  /** Concrete subject identifier that matched the principal. */
  subjectId: string;
  /** Creation time of the winning grant in ISO-8601 format. */
  createdAt: string;
}
