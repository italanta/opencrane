/**
 * Session→scope binding types (P4B.7).
 *
 * A chat window is an OpenClaw `sessionKey` multiplexed over one wss connection /
 * one device identity / one pod principal, so nothing in the transport or identity
 * layer distinguishes windows. Binding an awareness scope at the `sessionKey` level
 * is what stops one project's context from spilling into another window. The
 * control plane is the source of truth: the frontend/CLI *propose* a scope, the CP
 * *authorises* it by intersecting with the caller's compiled entitlements.
 */

/** Organizational scope level a session may retrieve from (matches the grant-compiler scope enum values). */
export type ScopeLevel = "org" | "department" | "project" | "personal";

/** A single awareness scope target a session is (or wants to be) bound to. */
export interface ScopeSelector
{
  /** Organizational level of the target. */
  scope: ScopeLevel;
  /** Awareness payload/dataset identifier inside that level (matches the compiled grant `payloadId`). */
  payloadId: string;
}

/** The result of intersecting a requested scope set with a principal's entitlements. */
export interface ScopeIntersection
{
  /** Selectors the principal is entitled to (each carries the *authoritative* scope from the winning grant). */
  granted: ScopeSelector[];
  /** Requested selectors the principal is NOT entitled to (over-scope attempts), as requested. */
  rejected: ScopeSelector[];
}

/** The outcome of binding a session scope: the persisted binding plus any rejected over-scope. */
export interface BindSessionScopeResult
{
  /** The persisted binding (authorised scopes only), or null when nothing was entitled. */
  binding: SessionScopeBinding | null;
  /** Requested selectors that were rejected as over-scope. */
  rejected: ScopeSelector[];
}

/** A persisted session→scope binding as returned to API/CLI callers. */
export interface SessionScopeBinding
{
  /** OpenClaw chat-window session key the binding applies to. */
  sessionKey: string;
  /** Tenant/user principal that owns the session (entitlements are compiled against this). */
  principal: string;
  /** The authorised (post-intersection) scope set the session is restricted to. */
  scopes: ScopeSelector[];
  /** When the binding was first created (ISO-8601). */
  createdAt: string;
  /** When the binding was last updated (ISO-8601). */
  updatedAt: string;
}
