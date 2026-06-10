import { createHash } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { ___LoadOidcAuthConfig } from "../auth/oidc.config.js";

/**
 * Module-level env-var snapshot read once at startup.
 * Tests that need a different value must call `vi.resetModules()` before
 * re-importing this module so the variable is re-evaluated.
 */
const _envToken = process.env.OPENCRANE_API_TOKEN?.trim() ?? "";
const _oidcConfig = ___LoadOidcAuthConfig();

/**
 * Express authentication middleware.
 *
 * Authentication is resolved in priority order:
 *   1. Public path bypass  — /healthz and /api/v1/auth/* never require a token.
 *   2. OIDC session        — a valid session cookie from the browser login flow.
 *   3. Env-var token       — OPENCRANE_API_TOKEN, for CI automation without a DB.
 *   4. DB access token     — per-user token created via `oc auth login` or POST /access-tokens.
 *   5. Dev-mode bypass     — when neither OIDC nor OPENCRANE_API_TOKEN is configured.
 *
 * @param prisma - Optional Prisma client.  When provided, bearer tokens are also
 *                 validated against the `access_tokens` database table (step 4 above).
 *                 Omit in unit tests that only exercise steps 1–3/5.
 */
export function ___AuthMiddleware(prisma?: PrismaClient): RequestHandler
{
  return function _authHandler(req, res, next)
  {
    // Delegate to an async helper so we can await the DB lookup while still
    // presenting the synchronous `RequestHandler` signature Express expects.
    _resolveAuth(req, res, next, prisma).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Internal async resolution logic
// ---------------------------------------------------------------------------

/**
 * Resolve authentication for a single request.
 * Extracted from the outer closure so it can be an async function cleanly.
 *
 * @param req    - Incoming Express request.
 * @param res    - Express response (used only to send 401/403).
 * @param next   - Express next function (called with no args on success).
 * @param prisma - Optional Prisma client for per-user DB token lookup.
 */
async function _resolveAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  prisma: PrismaClient | undefined,
): Promise<void>
{
  // 1. Public paths bypass all auth checks — /healthz and the auth router
  //    itself are always reachable without credentials.
  if (req.path === "/healthz" || req.path.startsWith("/api/v1/auth"))
  {
    next();
    return;
  }

  // 2. Accept an established OIDC browser session (human operator flow).
  if (_oidcConfig.enabled && req.session?.authUser)
  {
    next();
    return;
  }

  // 3. Extract the bearer token from the Authorization header.
  const authHeader = req.headers.authorization;
  const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // 4. Accept the static env-var token (CI / service-account automation).
  if (_envToken && providedToken === _envToken)
  {
    next();
    return;
  }

  // 5. Validate the presented token against per-user DB records when Prisma
  //    is available.  This covers tokens issued via `oc auth login` and
  //    POST /access-tokens without requiring a shared env var.
  if (prisma && providedToken)
  {
    const tokenHash = createHash("sha256").update(providedToken).digest("hex");
    const dbToken = await prisma.accessToken.findFirst({
      where: {
        tokenHash,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    });

    if (dbToken)
    {
      // Fire-and-forget usage timestamp — failure is non-fatal.
      prisma.accessToken.update({
        where: { id: dbToken.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => undefined);

      next();
      return;
    }
  }

  // 6. Dev-mode bypass — allow unauthenticated access when OIDC is disabled
  //    and no env-var token is set.  This prevents a locked-out state on a
  //    fresh local install with no credentials configured yet.
  if (!_envToken && !_oidcConfig.enabled)
  {
    next();
    return;
  }

  // 7. All checks exhausted — reject the request.
  if (!authHeader)
  {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  res.status(403).json({ error: "Invalid token" });
}
