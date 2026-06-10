import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../../core/grants/grant-compiler.types.js";

/**
 * Internal router for skill-registry content delivery.
 *
 * The skill-registry service validates the caller's projected ServiceAccount token,
 * extracts the tenant name, and then calls this endpoint to:
 *   1. Verify the tenant is entitled to the requested digest.
 *   2. Retrieve the content if entitled.
 *
 * Existence-hiding: non-existent AND non-entitled digests both return 404 so
 * callers cannot enumerate the catalog through error-code differences.
 *
 * This route is NOT behind the bearer-token auth middleware — it is internal-only,
 * protected by Kubernetes NetworkPolicy (reachable only from the skill-registry pod).
 *
 * @param prisma - Prisma client for database access.
 * @returns Configured Express router.
 */
export function internalSkillBundlesRouter(prisma: PrismaClient): Router
{
  const router = Router();

  router.get("/:digest/content", async function _getSkillBundleContent(req, res)
  {
    const { digest } = req.params;
    const { tenantName } = req.query;

    if (typeof tenantName !== "string" || tenantName.trim().length === 0)
    {
      res.status(400).json({ error: "tenantName query parameter is required", code: "VALIDATION_ERROR" });
      return;
    }

    // Existence-hiding: look up digest first but do not reveal existence before checking entitlements.
    const bundle = await prisma.skillBundle.findFirst({
      where: { digest },
      select: { id: true, content: true, contentType: true, name: true },
    });

    if (!bundle)
    {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      return;
    }

    // Compile the tenant's skill entitlements and check the requested bundle is allowed.
    const decisions = await compile(tenantName, GrantCompilerPayloadType.SkillBundle, prisma);
    const isAllowed = decisions.some(function _isAllow(decision)
    {
      return decision.payloadId === bundle.id && decision.access === GrantCompilerAccess.Allow;
    });

    // Existence-hiding: return 404 (not 403) for non-entitled bundles.
    if (!isAllowed)
    {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      return;
    }

    if (!bundle.content)
    {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      return;
    }

    res.setHeader("Content-Type", bundle.contentType ?? "text/markdown");
    res.setHeader("X-Skill-Name", bundle.name);
    res.setHeader("X-Skill-Digest", digest);
    res.send(bundle.content);
  });

  return router;
}
