import { createHash, randomBytes } from "crypto";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { OidcAuthService } from "./oidc.service.js";
import { _AuthorizeDeviceGrant, _CreateDeviceGrant, _FindGrantByUserCode, _PollDeviceGrant } from "./device-grant.js";

/**
 * Build the auth router covering:
 *  - Session introspection (GET /me)
 *  - OIDC browser flow (GET /login, GET /callback, POST /logout)
 *  - Device authorization grant for CLI (POST /device, GET /device/activate, GET /device/token)
 *
 * All routes in this router are mounted before `___AuthMiddleware` and are
 * therefore public — authentication is enforced per-handler where required.
 *
 * @param authService - OIDC auth service instance.
 * @param prisma      - Prisma client used to persist device-issued access tokens.
 */
export function ___AuthRouter(authService: OidcAuthService, prisma: PrismaClient): Router
{
  const router = Router();

  // --------------------------------------------------------------------------
  // Session introspection
  // --------------------------------------------------------------------------

  /** Report the current auth mode and authenticated user session, if any. */
  router.get("/me", function _me(req, res)
  {
    res.json(authService.getStatus(req));
  });

  // --------------------------------------------------------------------------
  // OIDC browser flow
  // --------------------------------------------------------------------------

  /** Start the browser-based OIDC login flow. */
  router.get("/login", async function _login(req, res, next)
  {
    try
    {
      if (!authService.isEnabled())
      {
        res.status(503).json({ error: "OIDC is not configured for this control-plane instance" });
        return;
      }

      const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";

      // 1. Discover the provider and store the PKCE replay-protection values.
      const loginUrl = await authService.buildLoginUrl(req, returnTo);

      // 2. Redirect the browser to the external identity provider.
      res.redirect(302, loginUrl);
    }
    catch (err)
    {
      next(err);
    }
  });

  /** Complete the OIDC callback and redirect back into the SPA. */
  router.get("/callback", async function _callback(req, res, next)
  {
    try
    {
      if (!authService.isEnabled())
      {
        res.status(503).json({ error: "OIDC is not configured for this control-plane instance" });
        return;
      }

      // 1. Validate the authorization response and establish the local session.
      const returnTo = await authService.completeLogin(req);

      // 2. Redirect the user back into the control-plane UI.
      res.redirect(302, returnTo);
    }
    catch (err)
    {
      next(err);
    }
  });

  /** Destroy the local session without requiring a provider-specific logout endpoint. */
  router.post("/logout", async function _logout(req, res, next)
  {
    try
    {
      await authService.logout(req);
      res.status(204).send();
    }
    catch (err)
    {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // Device authorization grant (CLI login — RFC 8628-style)
  // --------------------------------------------------------------------------

  /**
   * Step 1 — CLI initiates: create a device grant and return the codes.
   *
   * The CLI uses the returned deviceCode for polling and opens verificationUri
   * in the operator's browser so they can authenticate and approve the grant.
   */
  router.post("/device", function _deviceRequest(req, res)
  {
    // 1. Allocate a new pending grant with a 5-minute TTL.
    const grant = _CreateDeviceGrant();

    // 2. Build the browser URL the CLI will print for the user to open.
    const verificationUri = `/api/v1/auth/device/activate?userCode=${encodeURIComponent(grant.userCode)}`;

    // 3. Return codes and metadata so the CLI can start polling.
    res.status(200).json({
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      verificationUri,
      expiresIn: 300,
      interval: 5,
    });
  });

  /**
   * Step 2 — Browser activates: the user opens this URL in a browser after OIDC login.
   *
   * If the user has no OIDC session yet, this endpoint redirects to the login flow
   * with a `returnTo` pointing back here — `_sanitizeReturnTo` in the OIDC service
   * allows relative paths, so the redirect-back survives the callback intact.
   */
  router.get("/device/activate", async function _deviceActivate(req, res, next)
  {
    try
    {
      const userCode = typeof req.query.userCode === "string" ? req.query.userCode.trim() : "";

      // 1. Redirect to OIDC login when the operator has no active session.
      if (!req.session?.authUser)
      {
        if (!authService.isEnabled())
        {
          res.status(503).json({ error: "OIDC is not configured — cannot activate device grant" });
          return;
        }

        const returnTo = `/api/v1/auth/device/activate?userCode=${encodeURIComponent(userCode)}`;
        const loginUrl = await authService.buildLoginUrl(req, returnTo);
        res.redirect(302, loginUrl);
        return;
      }

      // 2. Look up the grant; reject unknown or expired user codes immediately.
      const grant = _FindGrantByUserCode(userCode);
      if (!grant)
      {
        res.status(404).json({ error: "Device code not found or expired. Run `oc auth login` again." });
        return;
      }

      // 3. Create a named access token in the database on behalf of the authenticated user.
      const plainText = `ocp_${randomBytes(24).toString("hex")}`;
      const tokenHash = createHash("sha256").update(plainText).digest("hex");
      const owner = (req.session.authUser as { sub?: string; email?: string }).sub
        ?? (req.session.authUser as { sub?: string; email?: string }).email
        ?? "unknown";

      await prisma.accessToken.create({
        data: {
          name: `cli-device-${grant.userCode}`,
          owner,
          tokenHash,
          expiresAt: null,
        },
      });

      // 4. Mark the in-memory grant as authorized so the polling CLI can collect the token.
      _AuthorizeDeviceGrant(grant.deviceCode, plainText);

      // 5. Return a plain success page — the CLI picks up the token via polling.
      res.status(200).send(
        "<!DOCTYPE html><html><body><h1>Login successful</h1>"
        + "<p>You may close this tab. The CLI has been authenticated.</p>"
        + "</body></html>",
      );
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Step 3 — CLI polls: returns the token once the operator has activated in the browser.
   *
   * Returns one of three states:
   *   - pending   → the operator has not yet opened the activation URL
   *   - authorized → token is present; the CLI stores it and stops polling
   *   - expired   → the grant timed out; the CLI must restart the login flow
   *
   * The token is delivered exactly once: after "authorized" is returned the
   * grant is deleted from the store.
   */
  router.get("/device/token", function _deviceToken(req, res)
  {
    const deviceCode = typeof req.query.deviceCode === "string" ? req.query.deviceCode.trim() : "";

    const result = _PollDeviceGrant(deviceCode);

    if (result.status === "authorized")
    {
      res.status(200).json({ status: "authorized", token: result.accessToken });
      return;
    }

    if (result.status === "expired")
    {
      res.status(410).json({ status: "expired", error: "Grant expired. Run `oc auth login` again." });
      return;
    }

    res.status(202).json({ status: "pending" });
  });

  return router;
}
