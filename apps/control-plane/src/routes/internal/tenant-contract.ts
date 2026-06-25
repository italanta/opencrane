import { Router } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { compileForPrincipals } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../../core/grants/grant-compiler.types.js";
import { _RenderToolsMarkdown } from "../../core/contract/tools-markdown.js";
import { _LoadAwarenessRollout } from "../../core/awareness/rollout-store.js";
import { _ResolveAwarenessVersion } from "../../core/awareness/rollout.js";
import { _ResolveContractSkillModels } from "../../core/model-routing/resolve-contract-skill-models.js";
import { _SyncDerivedDatasetMembership } from "../tenants.js";
import { _log } from "../../log.js";

/** Expected audience on the projected token the tenant pod uses to call this endpoint. */
const _EXPECTED_AUDIENCE = "control-plane";

/**
 * Extract the tenant name from a `system:serviceaccount:<ns>:<name>` subject string.
 *
 * @param subject - Full Kubernetes ServiceAccount subject string.
 * @returns Tenant name segment, or null when the subject does not match the expected format.
 */
function _ParseTenantNameFromSubject(subject: string): string | null
{
  const parts = subject.split(":");
  if (parts.length !== 4 || parts[0] !== "system" || parts[1] !== "serviceaccount")
  {
    return null;
  }
  return parts[3] ?? null;
}

/**
 * Internal endpoint that allows tenant pods to re-pull their effective runtime
 * contract.
 *
 * Tenant pods call this endpoint from the background contract-polling loop
 * (see `apps/tenant/deploy/entrypoint.sh`) using the projected ServiceAccount
 * token for the `control-plane` audience.  The operator injects
 * `OPENCRANE_CONTROL_PLANE_URL` and `OPENCRANE_CONTRACT_TOKEN_PATH` into every
 * tenant Deployment so the loop can reach this endpoint.
 *
 * **Identity enforcement:** the caller must present a valid projected
 * ServiceAccount token (audience `control-plane`) in the `Authorization: Bearer`
 * header.  The token is validated via the Kubernetes TokenReview API.  The
 * authenticated ServiceAccount name is then compared to the `:name` path param
 * so a tenant pod cannot read another tenant's contract.
 *
 * **This router is NOT behind `___AuthMiddleware`.**
 * Authentication is handled inline via TokenReview.  NetworkPolicy further limits
 * which pods can reach this path, providing defence in depth.
 *
 * @see platform/helm/templates/networkpolicy-planes.yaml — NetworkPolicy.
 * @see apps/operator/src/tenants/deploy/3-deployment.ts — token injection.
 *
 * @param prisma   - Prisma client for database access.
 * @param authApi  - Kubernetes authentication API for TokenReview calls.
 */
export function _RegisterInternalTenantContract(prisma: PrismaClient, authApi: k8s.AuthenticationV1Api): Router
{
  const router = Router();

  /**
   * Return the compiled effective contract for a named tenant.
   *
   * Validates the caller's projected token, checks the authenticated tenant
   * matches `:name`, then compiles and returns the contract.
   *
   * Route parameters:
   *   - `:name` — the tenant name whose contract should be returned.
   */
  router.get("/:name", async function _getInternalContract(req, res, next)
  {
    try
    {
      const { name } = req.params;

      // 1. Extract the Bearer token from the Authorization header.
      const authHeader = req.headers["authorization"] ?? "";
      const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;

      if (!token)
      {
        res.status(401).json({ error: "Missing Authorization header", code: "UNAUTHORIZED" });
        return;
      }

      // 2. Validate the token via TokenReview and verify audience.
      //    The control-plane uses @kubernetes/client-node v1.x where createTokenReview
      //    accepts { body: V1TokenReview } and returns Promise<V1TokenReview> directly.
      const reviewBody = new k8s.V1TokenReview();
      reviewBody.spec = new k8s.V1TokenReviewSpec();
      reviewBody.spec.token = token;
      reviewBody.spec.audiences = [_EXPECTED_AUDIENCE];

      const reviewResult = await authApi.createTokenReview({ body: reviewBody });
      const status = reviewResult.status;

      if (!status?.authenticated)
      {
        res.status(401).json({ error: "Token not authenticated", code: "UNAUTHORIZED" });
        return;
      }

      if (!status.audiences?.includes(_EXPECTED_AUDIENCE))
      {
        res.status(401).json({ error: "Token audience mismatch", code: "UNAUTHORIZED" });
        return;
      }

      // 3. Verify the authenticated ServiceAccount name matches the requested tenant.
      //    This prevents tenant A from reading tenant B's contract.
      const subject = status.user?.username ?? "";
      const authenticatedTenant = _ParseTenantNameFromSubject(subject);
      if (authenticatedTenant !== name)
      {
        res.status(403).json({ error: "Token does not authorise access to this tenant's contract", code: "FORBIDDEN" });
        return;
      }

      // 4. Verify the tenant exists before compiling grants.
      const tenant = await prisma.tenant.findUnique({
        where: { name },
        select: { name: true, team: true, awarenessWave: true, clusterTenantRef: true, subject: true },
      });

      if (!tenant)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      // 4b. Re-derive this tenant's Cognee dataset memberships from its group expansion and sync
      //     them when they changed (S4c). Fire-and-forget + diff-gated: it must not delay or fail
      //     the contract response (the pod polls frequently and the contract does not depend on
      //     the dataset sync), and an unchanged derivation writes nothing. Errors are logged, not
      //     propagated. `_SyncDerivedDatasetMembership` is internally transactional (Cognee last).
      void _SyncDerivedDatasetMembership(prisma, name, tenant.subject ?? null)
        .catch(function _syncFailed(err) { _log.warn({ err, tenant: name }, "derived dataset membership sync failed on contract poll; will retry next poll"); });

      // 5. Compile MCP server and skill grants over the tenant's principal SET (S4 inheritance):
      //    the openclaw Tenant inherits the rights of its 1:1 ClusterTenant user, so we compile
      //    over { tenant-name, bound subject } — the union of both principals' direct + group
      //    grants. A user-level Deny still beats a tenant-level Allow (Deny>Allow precedence).
      //    The subject is absent for legacy/unbound tenants, which collapses to tenant-only.
      const principals = [name, ...(tenant.subject ? [tenant.subject] : [])];
      const mcpDecisions = await compileForPrincipals(principals, GrantCompilerPayloadType.McpServer, prisma);
      const skillDecisions = await compileForPrincipals(principals, GrantCompilerPayloadType.SkillBundle, prisma);

      const allowedMcp = mcpDecisions
        .filter(function _isAllow(d) { return d.access === GrantCompilerAccess.Allow; })
        .map(function _id(d) { return d.payloadId; });

      const deniedMcp = mcpDecisions
        .filter(function _isDeny(d) { return d.access === GrantCompilerAccess.Deny; })
        .map(function _id(d) { return d.payloadId; });

      const allowedSkills = skillDecisions
        .filter(function _isAllow(d) { return d.access === GrantCompilerAccess.Allow; })
        .map(function _id(d) { return d.payloadId; });

      // 6. Resolve display metadata for the entitled tools so the rendered TOOLS.md is
      //    human-readable (the grant compiler only yields opaque ids). Skip the query
      //    entirely when nothing is entitled to avoid a pointless empty-IN lookup.
      const mcpServers = allowedMcp.length > 0
        ? await prisma.mcpServer.findMany({ where: { id: { in: allowedMcp } }, select: { id: true, name: true, description: true } })
        : [];
      const skillBundles = allowedSkills.length > 0
        ? await prisma.skillBundle.findMany({ where: { id: { in: allowedSkills } }, select: { id: true, name: true, description: true, digest: true } })
        : [];

      // 6b. Resolve the effective model for each entitled skill by the locked precedence chain
      //     (AIR.2): explicit-request (honoured at runtime, not here) > skill-pinned > skill-auto >
      //     scope default (this tenant's ClusterTenant default, else Global). Pure resolution over
      //     DB rows — no LiteLLM call. Skills with no resolvable model are returned with model null
      //     so the pod falls back to its own configured default.
      const resolvedSkillModels = await _ResolveContractSkillModels(prisma, skillBundles, tenant.clusterTenantRef ?? null);

      // 7. Render the contract-derived TOOLS.md (L1 workspace doc). The entrypoint
      //    poll loop writes this over the workspace file and SIGHUPs OpenClaw, so a
      //    grant/deny reflects in the agent's tool list within one poll interval.
      const toolsMarkdown = _RenderToolsMarkdown(mcpServers, skillBundles);

      // 7b. Resolve approved L2 personalisation docs (P4C.5). Unlike TOOLS.md
      //     (platform-owned, re-applied every poll), these are tenant-editable, so
      //     they are delivered as *version-gated* `managedDocs`: the entrypoint
      //     writes a doc only when its version increases, preserving the tenant's
      //     live in-pod edits between company reconciliations.
      const workspaceDocs = await prisma.tenantWorkspaceDoc.findMany({
        where: { tenant: name },
        select: { docName: true, content: true, lastReconciledVersion: true },
      });
      const managedDocs = workspaceDocs.map(function _toManagedDoc(doc)
      {
        return { file: `${doc.docName}.md`, content: doc.content, version: doc.lastReconciledVersion };
      });

      // 7c. Resolve this tenant's awareness contract version from the fleet rollout
      //     (P4B.3): the tenant's wave determines target-vs-stable, delivered via
      //     this re-pull so a fleet promotion/rollback reflects with no pod restart.
      //     The pod's awareness SDK refuses an incompatible major (see @opencrane/awareness).
      const rollout = await _LoadAwarenessRollout(prisma);
      const awareness = _ResolveAwarenessVersion(rollout, tenant.awarenessWave);

      // 8. Return a contract that the polling loop writes over the ConfigMap-mounted file.
      res.json({
        version: "opencrane-runtime/v1alpha1",
        contractVersion: "2.1.0",
        platform: "opencrane",
        mode: "managed",
        tenant: {
          name: tenant.name,
          team: tenant.team ?? null,
        },
        policy: {
          mcpServers: {
            allow: allowedMcp,
            deny: deniedMcp,
          },
        },
        skills: {
          // Entitled bundles carry the digest + name the pod needs to PULL each skill
          // from the skill-registry (`GET /bundles/:digest`) and lay it down on disk as
          // `<skills-dir>/<name>/SKILL.md` (see apps/tenant/deploy/entrypoint.sh).
          // Bundles whose row no longer exists are dropped here — they cannot be pulled.
          entitled: skillBundles.map(function _toEntitledSkill(bundle)
          {
            return { id: bundle.id, name: bundle.name, digest: bundle.digest };
          }),
          // Per-skill resolved model (AIR.2). One entry per entitled skill: `{ skillId, model, auto }`.
          // `model` is null when nothing in the precedence chain resolves, in which case the pod
          // falls back to its own configured default. `auto` flags an auto-routing posture.
          models: resolvedSkillModels,
        },
        capabilities: {
          mcpPolicyEnforced: allowedMcp.length > 0 || deniedMcp.length > 0,
        },
        workspace: {
          // Platform-managed, contract-derived doc; the entrypoint writes this to the
          // workspace TOOLS.md when the contract changes, then SIGHUPs OpenClaw
          // (see apps/tenant/deploy/entrypoint.sh).
          "TOOLS.md": toolsMarkdown,
        },
        // Version-gated tenant-editable L2 docs (P4C.5). Delivered once per version
        // bump so approved company reconciliations land without a restart while the
        // tenant's between-bump in-pod edits are preserved.
        managedDocs,
        // Awareness contract version this tenant runs under the fleet rollout (P4B.3).
        awareness: {
          contractVersion: awareness.version,
          shadow: awareness.shadow,
          wave: awareness.wave,
        },
      });
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
