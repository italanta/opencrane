import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _BindSessionScope, _ClearSessionScope, _GetSessionScope } from "../core/sessions/session-scope-store.js";
import type { ScopeSelector } from "../core/sessions/session-scope.types.js";
import type { SetSessionScopeRequest } from "./sessions.types.js";

/**
 * Session→scope binding router (P4B.7).
 *
 * Binds an awareness scope to an OpenClaw chat-window `sessionKey` so one
 * project's context cannot spill into another window (a window is a `sessionKey`
 * multiplexed over one wss connection / device / pod principal, so nothing in the
 * transport distinguishes windows). The control plane is the source of truth: the
 * frontend/CLI *propose* a scope and the CP *authorises* it by intersecting with
 * the principal's compiled awareness entitlements — a client can never over-scope.
 * CLI-first: `oc sessions scope …` and the WeOwnAI frontend are both clients of
 * these endpoints. Mounted under `/api/v1/sessions` behind `___AuthMiddleware`.
 *
 * @param prisma - Prisma client for the session-scope registry + grant compilation.
 * @returns Configured Express router.
 */
export function sessionsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Bind (or rebind) a session's scope; the CP intersects it with entitlements. */
  router.put("/:sessionKey/scope", async function _setScope(req, res, next)
  {
    try
    {
      const sessionKey = req.params.sessionKey;
      const body = (req.body ?? {}) as SetSessionScopeRequest;

      // 1. Validate the proposal shape — principal identity and a scope list are required.
      if (typeof body.principal !== "string" || body.principal.trim().length === 0)
      {
        res.status(400).json({ error: "principal is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (!Array.isArray(body.scopes) || body.scopes.length === 0)
      {
        res.status(400).json({ error: "scopes must be a non-empty array", code: "VALIDATION_ERROR" });
        return;
      }

      // 2. Authorise against entitlements: persist only the granted intersection.
      const requested = body.scopes as ScopeSelector[];
      const result = await _BindSessionScope(prisma, sessionKey, body.principal.trim(), requested);

      // 3. Nothing entitled → 403; the proposal over-scoped beyond the principal's grants.
      if (!result.binding)
      {
        res.status(403).json({
          error: "none of the requested scopes are entitled for this principal",
          code: "OVER_SCOPE",
          rejected: result.rejected,
        });
        return;
      }

      // 4. Return the authorised binding plus any rejected over-scope (200 even with
      //    partial rejects — the stored binding is always a safe subset).
      res.json({ ...result.binding, rejected: result.rejected });
    }
    catch (err) { next(err); }
  });

  /** Inspect a session's current scope binding. */
  router.get("/:sessionKey/scope", async function _getScope(req, res, next)
  {
    try
    {
      const binding = await _GetSessionScope(prisma, req.params.sessionKey);
      if (!binding)
      {
        res.status(404).json({ error: "Session scope not found", code: "NOT_FOUND" });
        return;
      }
      res.json(binding);
    }
    catch (err) { next(err); }
  });

  /** Clear a session's scope binding (idempotent). */
  router.delete("/:sessionKey/scope", async function _clearScope(req, res, next)
  {
    try
    {
      const cleared = await _ClearSessionScope(prisma, req.params.sessionKey);
      res.status(cleared ? 200 : 404).json({ sessionKey: req.params.sessionKey, cleared });
    }
    catch (err) { next(err); }
  });

  return router;
}
