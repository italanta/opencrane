import type { ScopeSelector } from "../core/sessions/session-scope.types.js";

/** Request body for `PUT /api/v1/sessions/:sessionKey/scope`. */
export interface SetSessionScopeRequest
{
  /** Tenant/user principal that owns the session; entitlements are compiled against this. */
  principal: string;
  /** The scope selectors the session proposes to be restricted to. */
  scopes: ScopeSelector[];
}
