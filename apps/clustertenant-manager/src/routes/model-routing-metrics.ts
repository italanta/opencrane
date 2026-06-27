import { Router } from "express";
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";

import type { LangfuseConfig, MetricsCallerScope } from "./model-routing-metrics.types.js";
import { _ResolveCallerClusterTenant as _resolveCallerClusterTenant } from "../infra/auth/resolve-caller-cluster-tenant.js";
import { _IsDevAuthMode } from "@opencrane/infra-auth";

/**
 * Default Langfuse v1 Metrics/Public API path. Confirmed against the Langfuse public-API docs
 * (GET /api/public/metrics, `query` JSON param). Overridable via `LANGFUSE_METRICS_PATH` so a v2
 * cutover (`/api/public/v2/metrics`) needs no code change.
 * @see https://langfuse.com/docs/metrics/features/metrics-api
 */
const _DEFAULT_METRICS_PATH = "/api/public/metrics";

/**
 * Langfuse query dimension a non-operator's results are constrained to. Langfuse filters are an
 * array on the `query` JSON param; the exact tenant field is deployment-specific (a custom trace
 * metadata key), so it is configurable here.
 * TODO(AIR.10): confirm the exact Langfuse filter field once the tenant dimension is wired into the
 * gateway's trace metadata — adjust `_DEFAULT_TENANT_FILTER_COLUMN` / `type` to match.
 */
const _DEFAULT_TENANT_FILTER_COLUMN = "metadata.clusterTenant";

/**
 * Resolve the server-side Langfuse config from the environment. Returns null when the host or
 * either key is missing — the proxy answers 503 `unconfigured` in that case so tests (and a fresh
 * install) need no live Langfuse.
 *
 * @returns The resolved config, or null when not fully configured.
 */
function _resolveConfig(): LangfuseConfig | null
{
  const host = process.env.LANGFUSE_HOST?.trim();
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!host || !publicKey || !secretKey)
  {
    return null;
  }
  const metricsPath = process.env.LANGFUSE_METRICS_PATH?.trim() || _DEFAULT_METRICS_PATH;
  return { host: host.replace(/\/+$/, ""), publicKey, secretKey, metricsPath };
}

/**
 * Resolve the caller's scope for query injection (AIR.10). Mirrors the recommendations feed: no
 * session is the dev open-auth fallthrough (treat as operator); an operator forwards unconstrained;
 * a non-operator's own ClusterTenant is resolved fresh from their IdP-verified email (fail-closed).
 *
 * @param prisma - Prisma client for the email→tenant→clusterTenantRef lookup.
 * @param req    - The incoming request carrying the session.
 * @returns The caller's resolved scope.
 */
async function _resolveCallerScope(prisma: PrismaClient, req: Request): Promise<MetricsCallerScope>
{
  const authUser = req.session?.authUser;

  // 1. No session: the dev-mode bypass treats the caller as operator (fresh local install / OPEN
  //    dev backend); a real auth deployment FAILS CLOSED (non-operator, no tenant) so the proxy
  //    403s rather than forwarding unconstrained metrics (AIR.0b).
  if (!authUser)
  {
    return _IsDevAuthMode() ? { isOperator: true, clusterTenant: null } : { isOperator: false, clusterTenant: null };
  }

  // 2. Platform operators forward the query unconstrained (no tenant filter injected).
  if (authUser.isPlatformOperator)
  {
    return { isOperator: true, clusterTenant: null };
  }

  // 3. Non-operator: resolve their own ClusterTenant fresh from the verified email (fail-closed).
  const clusterTenant = await _resolveCallerClusterTenant(prisma, authUser.email);
  return { isOperator: false, clusterTenant };
}

/**
 * Build the upstream URL, injecting a tenant constraint for a non-operator. Langfuse v1 takes a
 * single `query` JSON parameter carrying a `filters` array; for a non-operator we append an
 * equality filter on the tenant dimension so the caller can only see their own ClusterTenant's
 * metrics. An operator's query is forwarded verbatim. A malformed/absent `query` for a non-operator
 * is replaced with a minimal one carrying just the tenant filter (fail-closed: never broaden).
 *
 * @param config - The resolved Langfuse config.
 * @param req    - The incoming request (its query is forwarded).
 * @param scope  - The caller's resolved scope.
 * @returns The fully-qualified upstream URL with auth-free query injected.
 */
function _buildUpstreamUrl(config: LangfuseConfig, req: Request, scope: MetricsCallerScope): URL
{
  const url = new URL(config.host + config.metricsPath);

  // 1. Forward every caller query param verbatim — Langfuse's contract is its own.
  for (const [key, value] of Object.entries(req.query))
  {
    if (typeof value === "string")
    {
      url.searchParams.set(key, value);
    }
  }

  // 2. Operator (and dev fallthrough) — no tenant constraint; forward as-is.
  if (scope.isOperator)
  {
    return url;
  }

  // 3. Non-operator — constrain the `query` JSON to the caller's ClusterTenant by appending a
  //    tenant-dimension equality filter. Parse the caller's query when present; on any parse
  //    failure fall back to a minimal query carrying only the tenant filter (never broaden).
  const tenantFilter = { column: _DEFAULT_TENANT_FILTER_COLUMN, operator: "=", value: scope.clusterTenant, type: "string" };
  let parsed: Record<string, unknown> = {};
  const raw = url.searchParams.get("query");
  if (raw)
  {
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { parsed = {}; }
  }
  const existing = Array.isArray(parsed.filters) ? (parsed.filters as unknown[]) : [];
  parsed.filters = [...existing, tenantFilter];
  url.searchParams.set("query", JSON.stringify(parsed));
  return url;
}

/**
 * Best-effort read-only proxy to a self-hosted Langfuse v1 Metrics/Public API (AIR.10). Mounted
 * under `/api/v1/model-routing/metrics`. Keys stay server-side: the proxy adds HTTP Basic auth
 * (public key = user, secret key = pass) and forwards the caller's query. A non-operator's query is
 * constrained to their own ClusterTenant via a tenant-dimension filter.
 *
 * Failure modes are non-fatal so tests need no live Langfuse: unconfigured → 503
 * `{ status: "unconfigured" }`; any upstream/network error → 502.
 *
 * @param prisma - Prisma client used for the caller's fail-closed ClusterTenant resolution.
 * @returns Configured Express router.
 */
export function modelRoutingMetricsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Proxy a metrics query to upstream Langfuse with server-side auth + scope injection. */
  router.get("/", async function _get(req, res, next)
  {
    try
    {
      // 1. Resolve the server-side connection. Missing host/keys → 503 unconfigured (no live infra).
      const config = _resolveConfig();
      if (!config)
      {
        res.status(503).json({ status: "unconfigured" });
        return;
      }

      // 2. Resolve the caller's scope so a non-operator's query can be constrained to their tenant.
      const scope = await _resolveCallerScope(prisma, req);

      // 3. Fail-closed: a non-operator with no resolved ClusterTenant has nothing to scope the query
      //    to — reject before forwarding rather than inject a null-valued tenant filter upstream.
      if (!scope.isOperator && !scope.clusterTenant)
      {
        res.status(403).json({ error: "Not authorized for any metrics scope.", code: "FORBIDDEN_SCOPE" });
        return;
      }

      // 4. Build the upstream URL with the (optionally tenant-constrained) query.
      const url = _buildUpstreamUrl(config, req, scope);

      // 5. Call upstream with HTTP Basic auth added server-side (keys never reach the client). Any
      //    transport/upstream failure is isolated and surfaced as a 502.
      const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
      let upstream: Response;
      try
      {
        upstream = await fetch(url.toString(), { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
      }
      catch
      {
        res.status(502).json({ status: "upstream_error", error: "Failed to reach the metrics backend." });
        return;
      }

      // 6. A non-2xx upstream is also a 502 (the proxy makes no claim about upstream semantics).
      if (!upstream.ok)
      {
        res.status(502).json({ status: "upstream_error", error: `Metrics backend returned ${upstream.status}.` });
        return;
      }

      // 7. Pass the upstream JSON through verbatim (loosely-typed passthrough).
      const body = await upstream.json();
      res.json(body);
    }
    catch (err) { next(err); }
  });

  return router;
}
