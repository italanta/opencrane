import type { Request, RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";

import type { ClusterTenantScopedResource } from "./cluster-tenant-scope.types.js";
import { _ResolveCallerClusterTenant } from "../auth/resolve-caller-cluster-tenant.js";
import { _IsDevAuthMode } from "@opencrane/infra-auth";

/**
 * Reusable authorization guard for mutations (POST/PUT/DELETE) on ClusterTenant-scoped
 * control-plane resources (Track AIR — provider credentials, model definitions).
 *
 * The rule (AIR.0b), in priority order:
 *   1. A platform operator (session `isPlatformOperator`) may mutate any resource at any scope.
 *   2. A non-operator may mutate only a `clusterTenant`-scoped resource in a silo they own a
 *      workspace in. Global-scoped mutations are operator-only.
 *
 * Ownership is resolved fresh from the caller's IdP-verified email via the shared
 * `_ResolveCallerClusterTenant`, scoped to the resource's own silo so a human who owns workspaces
 * in more than one ClusterTenant is authorised for each — never taken from a self-asserted claim
 * or request input. `/auth/me` uses the same resolver (scoped by request host instead).
 *
 * The guard is applied per-router and reads the *resource* scope/clusterTenant from the request
 * via the supplied `resolveResource` callback, which is run after the request body / params are
 * available. Reads (GET) are intentionally NOT guarded — any authenticated caller may list/read.
 *
 * @param prisma          - Prisma client used for the fail-closed email→tenant→clusterTenantRef lookup.
 * @param resolveResource - Resolves the scope + owning clusterTenant of the resource the request targets.
 * @returns An Express middleware enforcing the rule above (403 on denial).
 */
export function _ClusterTenantScopeGuard(
  prisma: PrismaClient,
  resolveResource: (req: Request) => Promise<ClusterTenantScopedResource | null>,
): RequestHandler
{
  /** Express handler: resolve the allow/deny decision then continue or reject with 403. */
  return function _scopeHandler(req, res, next)
  {
    _enforce(req, prisma, resolveResource).then(function _onResolved(decision)
    {
      // 1. Denied → 403 with the standard `{ error, code }` envelope; never leak which check failed.
      if (decision === "deny")
      {
        res.status(403).json({ error: "Not authorized for this resource scope.", code: "FORBIDDEN_SCOPE" });
        return;
      }

      // 2. Allowed (or open-auth fallthrough) → continue to the route handler.
      next();
    }).catch(next);
  };
}

/**
 * Resolve the allow/deny decision for a single mutation request.
 * Extracted from the closure so the async DB lookup can be awaited cleanly.
 *
 * @param req             - Incoming request (carries the session and the body/params).
 * @param prisma          - Prisma client for the email→tenant→clusterTenantRef lookup.
 * @param resolveResource - Resolves the targeted resource's scope + owning clusterTenant.
 */
async function _enforce(
  req: Request,
  prisma: PrismaClient,
  resolveResource: (req: Request) => Promise<ClusterTenantScopedResource | null>,
): Promise<"allow" | "deny">
{
  const authUser = req.session?.authUser;

  // 1. No established session. Honour the auth posture: under the dev-mode bypass (no OIDC, no env
  //    token) allow it so a fresh local install / the OPEN dev backend isn't locked out; otherwise
  //    FAIL CLOSED — a missing session in a real auth deployment must never reach a scoped mutation (AIR.0b).
  if (!authUser)
  {
    return _IsDevAuthMode() ? "allow" : "deny";
  }

  // 2. Platform operators may mutate any resource at any scope.
  if (authUser.isPlatformOperator)
  {
    return "allow";
  }

  // 3. Resolve the targeted resource. A missing resource (e.g. 404-bound request) is
  //    allowed through so the route handler can emit the canonical 404, not a 403.
  const resource = await resolveResource(req);
  if (!resource)
  {
    return "allow";
  }

  // 4. Global-scoped mutations are operator-only — a non-operator reaching here is denied.
  if (resource.scope !== "clusterTenant" || !resource.clusterTenant)
  {
    return "deny";
  }

  // 5. ClusterTenant-scoped: allow only when the caller owns a workspace in the resource's
  //    silo. Scope the fail-closed lookup to that silo so a human who owns workspaces in more
  //    than one ClusterTenant is authorised for each (an unscoped email match would be ambiguous
  //    and deny them everywhere). A non-owner yields zero rows → null → deny.
  const callerClusterTenant = await _ResolveCallerClusterTenant(prisma, authUser.email, resource.clusterTenant);
  if (callerClusterTenant && callerClusterTenant === resource.clusterTenant)
  {
    return "allow";
  }

  return "deny";
}
