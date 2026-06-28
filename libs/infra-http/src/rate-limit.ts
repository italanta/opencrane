import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/** Tuning for {@link _RateLimit}. */
export interface RateLimitOptions
{
  /** Sliding window length in ms (default 60_000 = 1 minute). */
  windowMs?: number;
  /** Max requests per window per client IP (default 1000 — a DoS backstop, not a functional cap). */
  max?: number;
}

/**
 * Per-IP request rate limiter shared by both managers' API servers. Mounted once, early, in each
 * app's middleware chain (before the routes) so every authz-gated / DB-backed endpoint is covered
 * — a DoS backstop that also satisfies the `js/missing-rate-limiting` scanning rule.
 *
 * The default cap is deliberately generous (1000/min/IP): real control-plane traffic stays well
 * under it, so this never shapes normal use — it only sheds a flood. Health probes (`/healthz`,
 * `/readyz`) and the high-frequency trusted internal pod-poll surface (`/api/internal/*`) are
 * exempt so liveness checks and operator loops are never throttled.
 *
 * @param opts - Optional window/max overrides.
 * @returns An Express middleware enforcing the per-IP limit.
 */
export function _RateLimit(opts?: RateLimitOptions): RequestHandler
{
  return rateLimit({
    windowMs: opts?.windowMs ?? 60_000,
    limit: opts?.max ?? 1000,
    standardHeaders: true,
    legacyHeaders: false,
    // Both managers set `trust proxy` deliberately (single ingress fronts every request) so
    // `req.ip` is the forwarded client. Silence express-rate-limit's permissive-trust-proxy
    // validation — it would otherwise log a non-JSON console warning on first request, which
    // pollutes the stdout-scraped log stream.
    validate: { trustProxy: false },
    skip: function _skip(req): boolean
    {
      return req.path === "/healthz"
        || req.path === "/readyz"
        || req.path.startsWith("/api/internal");
    },
  });
}
