import type { RequestHandler } from "express";

import { ___LoadOidcAuthConfig } from "../auth/oidc.config.js";

const token = process.env.OPENCRANE_API_TOKEN?.trim() ?? "";
const oidcConfig = ___LoadOidcAuthConfig();

/**
 * Simple bearer token auth middleware.
 * Validates against the OPENCRANE_API_TOKEN env var.
 * 
 * Skips auth for the public endpoints or when no token is configured (dev mode).
 */
export function ___AuthMiddleware(): RequestHandler
{
  return function _authHandler(req, res, next)
  {
    if (req.path === "/healthz" || req.path.startsWith("/api/auth"))
    {
      next();
      return;
    }

    if (oidcConfig.enabled && req.session.authUser)
    {
      next();
      return;
    }

    if (!token)
    {
      if (!oidcConfig.enabled)
      {
        next();
        return;
      }

      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
    {
      if (oidcConfig.enabled)
      {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      res.status(401).json({ error: "Missing Authorization header" });
      return;
    }

    const provided = header.slice(7);
    if (provided !== token)
    {
      res.status(403).json({ error: "Invalid token" });
      return;
    }

    next();
  };
}
