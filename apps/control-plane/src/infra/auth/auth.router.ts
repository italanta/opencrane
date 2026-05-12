import { Router } from "express";

import type { OidcAuthService } from "./oidc.service.js";

/** Build the auth router used by the SPA login flow and session bootstrap. */
export function ___AuthRouter(authService: OidcAuthService): Router
{
  const router = Router();

  /** Report the current auth mode and authenticated user session, if any. */
  router.get("/me", async function _me(req, res)
  {
    res.json(authService.getStatus(req));
  });

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

  return router;
}