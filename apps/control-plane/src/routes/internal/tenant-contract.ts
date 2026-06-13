import { Router } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../../core/grants/grant-compiler.types.js";
import { _RenderToolsMarkdown } from "../../core/contract/tools-markdown.js";

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
        select: { name: true, team: true },
      });

      if (!tenant)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      // 5. Compile MCP server and skill grants for this tenant.
      const mcpDecisions = await compile(name, GrantCompilerPayloadType.McpServer, prisma);
      const skillDecisions = await compile(name, GrantCompilerPayloadType.SkillBundle, prisma);

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
        ? await prisma.skillBundle.findMany({ where: { id: { in: allowedSkills } }, select: { id: true, name: true, description: true } })
        : [];

      // 7. Render the contract-derived TOOLS.md (L1 workspace doc). The entrypoint
      //    poll loop writes this over the workspace file and SIGHUPs OpenClaw, so a
      //    grant/deny reflects in the agent's tool list within one poll interval.
      const toolsMarkdown = _RenderToolsMarkdown(mcpServers, skillBundles);

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
          entitled: allowedSkills,
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
      });
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
