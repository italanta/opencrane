import type { RequestHandler } from "express";

import { _IsDevAuthMode } from "./auth-mode.js";

/**
 * Authorization guard restricting a route to the PLATFORM OPERATOR — the fleet-wide
 * superadmin (env-seeded via `OPENCRANE_PLATFORM_OPERATOR_GROUPS` / seed email). This is
 * the strongest gate and the only acceptable one for the master IdP-credential rotation
 * route: a per-org owner/admin must NEVER be able to rotate the platform's Zitadel
 * service-account key.
 *
 * IAM-first: the decision is derived purely from the caller's IdP-verified session
 * (`session.authUser.isPlatformOperator`), never from request input.
 *
 * Posture, mirroring `_RequireOrgAdmin` / `_IsDevAuthMode`:
 *   1. No established session — FAIL OPEN under dev mode (no OIDC and no
 *      `OPENCRANE_API_TOKEN`); FAIL CLOSED otherwise (403) — a real deployment must never
 *      let an unauthenticated or token-only caller reach a superadmin action.
 *   2. Session present — allow iff `isPlatformOperator`; else 403.
 *
 * TODO (S5): `isPlatformOperator` is the config-driven stopgap until OpenCrane has a role
 * model. This MUST tighten to a first-class super-admin role once that model lands.
 *
 * @returns Express middleware that continues for platform operators and rejects others (403).
 */
export function _RequirePlatformOperator(): RequestHandler
{
  /** Express handler: allow the verified platform operator (or dev-mode bypass), else 403. */
  return function _platformOperatorHandler(req, res, next)
  {
    const authUser = req.session?.authUser;

    // 1. No session — honour the auth posture: dev-mode opens the bypass, real auth denies.
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

    // 2. Established session — allow only the platform operator (the fleet superadmin).
    if (authUser.isPlatformOperator === true)
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
  res.status(403).json({ error: "Platform operator role required.", code: "FORBIDDEN_NOT_PLATFORM_OPERATOR" });
}
