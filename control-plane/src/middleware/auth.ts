import type { MiddlewareHandler } from "hono";

/**
 * Simple bearer token auth middleware.
 * Validates against the OPENCRANE_API_TOKEN env var.
 */
export function authMiddleware(): MiddlewareHandler {
  const token = process.env.OPENCRANE_API_TOKEN;

  return async (c, next) => {
    // Skip auth for health check
    if (c.req.path === "/healthz") {
      return next();
    }

    if (!token) {
      // No token configured — allow all (dev mode)
      return next();
    }

    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const provided = header.slice(7);
    if (provided !== token) {
      return c.json({ error: "Invalid token" }, 403);
    }

    return next();
  };
}
