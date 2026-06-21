import type { RequestHandler } from "express";

import { _IsDevAuthMode } from "../auth/auth-mode.js";

/**
 * Reusable authorization guard restricting a route to organisation admins — the role
 * allowed to curate the MCP catalogue and approve servers (P0.5). The catalogue-approval
 * feature requires org-admin-only actions, but the control-plane enforced no per-route
 * roles before this guard.
 *
 * IAM-first: the decision is derived purely from the caller's IdP-verified identity
 * (`session.authUser.isOrgAdmin`, set from `OPENCRANE_ORG_ADMIN_GROUPS`), never from
 * request input. It aligns with the Obot Admin role mapping (P0.1).
 *
 * Posture, mirroring `_ClusterTenantScopeGuard` / `_IsDevAuthMode`:
 *   1. No established session — FAIL OPEN under dev mode (no OIDC and no
 *      `OPENCRANE_API_TOKEN`, so a fresh local install / the OPEN dev backend isn't
 *      locked out); FAIL CLOSED otherwise (a real auth deployment must never let an
 *      unauthenticated or token-only caller reach an org-admin action).
 *   2. Session present — allow iff `isOrgAdmin` (platform operators are org admins by
 *      derivation, being the broader role).
 *
 * Apply to org-admin-only mutations (e.g. the P1 catalogue publish / access-policy routes).
 *
 * @returns An Express middleware that continues for org admins and rejects others with 403.
 */
export function _RequireOrgAdmin(): RequestHandler
{
  /** Express handler: allow verified org admins (or the dev-mode bypass), else 403. */
  return function _orgAdminHandler(req, res, next)
  {
    const authUser = req.session?.authUser;

    // 1. No session — honour the auth posture: dev-mode opens the bypass, otherwise deny.
    if (!authUser)
    {
      if (_IsDevAuthMode())
      {
        next();
        return;
      }

      _deny(res);
      return;
    }

    // 2. Established session — allow only callers the IdP marked as org admins.
    if (authUser.isOrgAdmin)
    {
      next();
      return;
    }

    _deny(res);
  };
}

/** Emit the canonical 403 envelope; never leak which specific check failed. */
function _deny(res: Parameters<RequestHandler>[1]): void
{
  res.status(403).json({ error: "Organisation admin role required.", code: "FORBIDDEN_NOT_ORG_ADMIN" });
}
