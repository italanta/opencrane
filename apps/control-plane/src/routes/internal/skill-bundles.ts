import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _log } from "../../log.js";
import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../../core/grants/grant-compiler.types.js";
import type { OciBundleStore } from "../../core/oci/oci-bundle-store.js";

/**
 * Resolve a bundle's content during the P4D.2 cutover: prefer the OCI store
 * (content is digest-verified inside `pullBundle`), and fall back to the DB
 * `content` column when the store is absent, has no such blob, or errors —
 * the DB remains the trusted original until the destructive column drop lands.
 *
 * @param ociStore  - The OCI store, or null when unconfigured.
 * @param digest    - The bundle's content-addressable digest.
 * @param dbContent - The DB-stored content fallback (may be null).
 * @returns The bundle content, or null when neither source has it.
 */
export async function _ResolveBundleContent(ociStore: OciBundleStore | null, digest: string, dbContent: string | null): Promise<string | null>
{
  // 1. Try the OCI store first when configured; a thrown error (registry down or a
  //    digest mismatch) must never be served — fall through to the trusted DB copy.
  if (ociStore)
  {
    try
    {
      const fromOci = await ociStore.pullBundle(digest);
      if (fromOci !== null)
      {
        return fromOci;
      }
    }
    catch (err)
    {
      // Fall back to DB content during the dual-write window, but log so a registry
      // outage or a digest mismatch (never served — see OciBundleStore) is visible.
      _log.warn({ digest, err }, "OCI pull failed; falling back to DB content");
    }
  }

  // 2. Fall back to the DB content column.
  return dbContent;
}

/**
 * Internal router for skill-bundle content delivery to the skill-registry service.
 *
 * The skill-registry validates the caller's projected ServiceAccount token,
 * extracts the tenant name, then calls this endpoint to:
 *   1. Verify the tenant is entitled to the requested digest.
 *   2. Return the bundle content if entitled.
 *
 * **Existence-hiding:** non-existent and non-entitled digests both return 404.
 * Scan-failed bundles return 422 `SCAN_FAILED` so the skill-registry can surface
 * a meaningful reason to the tenant rather than treating it as a missing bundle.
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
 * @param prisma   - Prisma client for database access.
 * @param ociStore - Optional OCI store; when set, content is served from it
 *   (digest-verified) with a DB-`content` fallback (P4D.2). Null → DB-only.
 */
export function _RegisterInternalBundles(prisma: PrismaClient, ociStore: OciBundleStore | null = null): Router
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

      // 2. Fetch the bundle by digest. Including scanStatus in the select
      //    lets us gate delivery without a second round-trip.
      const bundle = await prisma.skillBundle.findFirst({
        where: { digest },
        select: { id: true, content: true, contentType: true, name: true, scanStatus: true },
      });

      // 3. Gate 1 — bundle must exist.
      if (!bundle)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      // Gate 2 — bundle must have passed its vulnerability scan.
      //    This route is NetworkPolicy-restricted to the skill-registry only, so
      //    the distinction is meaningful: the registry can surface a clear reason
      //    to the tenant rather than treating a scan failure as a missing bundle.
      if (String(bundle.scanStatus) !== "passed")
      {
        res.status(422).json({ error: "Bundle has not passed vulnerability scan", code: "SCAN_FAILED" });
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

      // 4. Resolve content: OCI store first (digest-verified), DB content as fallback.
      //    Guard against bundles recorded in the database but never uploaded anywhere.
      const content = await _ResolveBundleContent(ociStore, digest, bundle.content);
      if (!content)
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
      res.send(content);
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
