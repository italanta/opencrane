import type { RequestHandler } from "express";

const token = process.env.OPENCRANE_API_TOKEN;

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
    if (req.path === "/healthz")
    {
      next();
      return;
    }

    if (!token)
    {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
    {
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
