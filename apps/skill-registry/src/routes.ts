import { Router } from "express";
import type * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { _ReviewToken } from "./token-review.js";

/**
 * Build the Express router for the skill-registry delivery service.
 *
 * Delivery contract:
 *   GET /bundles/:digest  — Returns skill content when the caller is entitled.
 *   GET /healthz          — Liveness/readiness probe endpoint.
 *
 * Security:
 *   - Every /bundles request must carry a projected ServiceAccount token
 *     (Authorization: Bearer <token>) bound to audience "skill-registry".
 *   - The control-plane's internal /api/internal/bundles/:digest/content endpoint
 *     performs entitlement checks and returns the content; this service validates
 *     the token and proxies the call.
 *   - Non-entitled AND non-existent digests both return 404 (existence-hiding).
 *
 * @param authApi         - Kubernetes Authentication API client for TokenReview.
 * @param controlPlaneUrl - Base URL of the control-plane (in-cluster).
 * @param log             - Pino logger instance.
 * @returns Configured Express router.
 */
export function _BuildRouter(authApi: k8s.AuthenticationV1Api, controlPlaneUrl: string, log: Logger): Router
{
  const router = Router();

  router.get("/healthz", function _healthz(_req, res)
  {
    res.json({ status: "ok" });
  });

  router.get("/bundles/:digest", async function _getBundle(req, res)
  {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer "))
    {
      res.status(401).json({ error: "Missing or invalid Authorization header", code: "UNAUTHORIZED" });
      return;
    }

    const token = authHeader.slice(7);
    const reviewResult = await _ReviewToken(authApi, token);
    if (!reviewResult.ok)
    {
      log.warn({ reason: reviewResult.reason }, "token review rejected");
      res.status(401).json({ error: "Token rejected", code: "UNAUTHORIZED" });
      return;
    }

    const { tenantName } = reviewResult;
    const { digest } = req.params;

    // Delegate entitlement check and content retrieval to the control-plane internal endpoint.
    const url = `${controlPlaneUrl}/api/internal/bundles/${encodeURIComponent(digest)}/content?tenantName=${encodeURIComponent(tenantName)}`;
    let upstream: Response;
    try
    {
      upstream = await fetch(url);
    }
    catch (err)
    {
      const message = err instanceof Error ? err.message : "unknown error";
      log.error({ digest, tenantName, err: message }, "failed to reach control-plane internal endpoint");
      res.status(502).json({ error: "Upstream unavailable", code: "UPSTREAM_ERROR" });
      return;
    }

    if (upstream.status === 404)
    {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      return;
    }

    if (!upstream.ok)
    {
      log.error({ digest, tenantName, status: upstream.status }, "unexpected response from control-plane internal endpoint");
      res.status(502).json({ error: "Upstream error", code: "UPSTREAM_ERROR" });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "text/markdown";
    const skillName = upstream.headers.get("x-skill-name") ?? "";
    const body = await upstream.text();

    res.setHeader("Content-Type", contentType);
    if (skillName)
    {
      res.setHeader("X-Skill-Name", skillName);
    }
    res.setHeader("X-Skill-Digest", digest);
    res.send(body);
  });

  return router;
}
