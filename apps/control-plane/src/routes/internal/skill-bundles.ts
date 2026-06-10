import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../../core/grants/grant-compiler.types.js";

/**
 * Internal router for skill-bundle content delivery to the skill-registry service.
 *
 * The skill-registry validates the caller's projected ServiceAccount token,
 * extracts the tenant name, then calls this endpoint to:
 *   1. Verify the tenant is entitled to the requested digest.
 *   2. Return the bundle content if entitled.
 *
 * **Existence-hiding:** non-existent and non-entitled digests both return 404
 * so callers cannot enumerate the catalog by comparing error codes.
 *
 * **This router is NOT behind `___AuthMiddleware`.**
 * Access is enforced at the network layer: only the skill-registry pod can
 * reach this path because the Kubernetes NetworkPolicy restricts ingress to
 * the control-plane from known platform components only.
 *
 * @see platform/helm/templates/networkpolicy-planes.yaml — NetworkPolicy
 *   template that governs pod-to-pod reachability for the runtime planes.
 * @see platform/helm/templates/skill-registry-deployment.yaml — where the
 *   skill-registry's `CONTROL_PLANE_URL` is wired to this endpoint.
 *
 * @param prisma - Prisma client for database access.
 */
export function _RegisterInternalBundles(prisma: PrismaClient): Router
{
  const router = Router();

  /**
   * Deliver the raw content of a skill bundle to an entitled tenant.
   *
   * Query parameters:
   *   - `tenantName` (required) — the tenant whose entitlements are checked.
   *
   * Route parameters:
   *   - `:digest` — the content-addressable digest of the bundle to fetch.
   */
  router.get("/:digest/content", async function _getSkillBundleContent(req, res, next)
  {
    try
    {
      const { digest } = req.params;
      const { tenantName } = req.query;

      // 1. Reject requests that omit the tenant identifier — the grant compiler
      //    requires a tenant name to evaluate entitlements.
      if (typeof tenantName !== "string" || tenantName.trim().length === 0)
      {
        res.status(400).json({ error: "tenantName query parameter is required", code: "VALIDATION_ERROR" });
        return;
      }

      // 2. Fetch the bundle by digest without revealing whether it exists yet —
      //    the entitlement check must come first to prevent catalog enumeration.
      const bundle = await prisma.skillBundle.findFirst({
        where: { digest },
        select: { id: true, content: true, contentType: true, name: true },
      });

      // 3. Run the grant compiler to determine whether this tenant is entitled
      //    to the requested bundle.  Existence-hiding: missing and non-entitled
      //    bundles are both reported as 404.
      if (!bundle)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      const decisions = await compile(tenantName, GrantCompilerPayloadType.SkillBundle, prisma);
      const isAllowed = decisions.some(function _isAllow(decision)
      {
        return decision.payloadId === bundle.id && decision.access === GrantCompilerAccess.Allow;
      });

      if (!isAllowed)
      {
        // Existence-hiding: return 404 rather than 403 for non-entitled bundles.
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      // 4. Guard against bundles recorded in the database but not yet uploaded.
      if (!bundle.content)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      // 5. Send the bundle content with metadata headers that allow the
      //    skill-registry to cache and serve it without a second round-trip.
      //
      //    Content-Type: standard HTTP header (RFC 9110 §8.3) — tells the
      //      consumer how to interpret the body.  Defaults to text/markdown
      //      because skill bundles are almost always Markdown prompt files.
      //      @see https://www.rfc-editor.org/rfc/rfc9110#section-8.3
      //
      //    X-Skill-Name / X-Skill-Digest: proprietary identification headers
      //      following the informal X- prefix convention (RFC 6648 deprecated
      //      the prefix for IANA registration but it remains standard practice
      //      for private/internal headers).  These allow the receiver to log,
      //      cache-key, and forward skill identity without parsing the URL.
      //      @see https://www.rfc-editor.org/rfc/rfc6648
      res.setHeader("Content-Type", bundle.contentType ?? "text/markdown");
      res.setHeader("X-Skill-Name", bundle.name);
      res.setHeader("X-Skill-Digest", digest);
      res.send(bundle.content);
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
