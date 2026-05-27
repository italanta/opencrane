/** Supported organizational scopes for groups and grants. */
export type GroupRouteScope = "org" | "department" | "project" | "personal";

/** Supported subject types when writing grants. */
export type GroupRouteSubjectType = "group" | "tenant" | "user";

/** Supported access outcomes for group-linked grants. */
export type GroupRouteAccess = "allow" | "deny";

/** Request body used to create or update a group-linked awareness grant. */
export interface GroupGrantInput
{
  /** Optional explicit payload identifier for awareness contract rules. */
  payloadId?: string;
  /** Organizational scope carried by the grant. */
  scope: GroupRouteScope;
  /** Subject family receiving the grant. */
  subjectType: GroupRouteSubjectType;
  /** Subject identifier used by the compiler. */
  subjectId?: string;
  /** Human-friendly subject label accepted for group lookups. */
  subjectName: string;
  /** Allow or deny outcome. */
  access: GroupRouteAccess;
  /** Higher values override lower-priority grants. */
  priority?: number;
  /** Optional operator note. */
  note?: string;
}

/** Request body used to create or update a group. */
export interface GroupWriteRequest
{
  /** Stable operator-facing group name. */
  name: string;
  /** Organizational scope represented by the group. */
  scope: GroupRouteScope;
  /** Optional operator-facing description. */
  description?: string;
  /** JSON membership list stored on the group record. */
  members?: unknown[];
  /** Optional default awareness grants linked to the group. */
  grants?: GroupGrantInput[];
}
