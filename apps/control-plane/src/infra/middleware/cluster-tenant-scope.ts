import type { Request, RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";

import type { ClusterTenantScopedResource } from "./cluster-tenant-scope.types.js";

/**
 * Reusable authorization guard for mutations (POST/PUT/DELETE) on ClusterTenant-scoped
 * control-plane resources (Track AIR — provider credentials, model definitions).
 *
 * The rule (AIR.0b), in priority order:
 *   1. A platform operator (session `isPlatformOperator`) may mutate any resource at any scope.
 *   2. A non-operator may mutate only a `clusterTenant`-scoped resource whose owning
 *      ClusterTenant equals the caller's own resolved ClusterTenant. Global-scoped mutations
 *      are operator-only.
 *
 * `clusterTenant` is resolved fresh from the caller's IdP-verified email (email → tenant →
 * `clusterTenantRef`), mirroring `OidcAuthService._resolveClusterTenant` — never taken from a
 * self-asserted claim or request input.
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

  // 1. Dev open-auth fallthrough: no established session means the auth middleware
  //    let the request through under the dev-mode bypass (OIDC disabled, no env token).
  //    Honour that posture here rather than locking out a fresh local install.
  //    TODO(AIR.0b): in production this must hard-fail closed once a first-class
  //    role model / non-dev auth is always present; do not ship open-auth to prod.
  if (!authUser)
  {
    return "allow";
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

  // 5. ClusterTenant-scoped: allow only when the caller's own resolved ClusterTenant
  //    matches the resource owner. Resolve fresh from the verified email (fail-closed).
  const callerClusterTenant = await _ResolveCallerClusterTenant(prisma, authUser.email);
  if (callerClusterTenant && callerClusterTenant === resource.clusterTenant)
  {
    return "allow";
  }

  return "deny";
}

/**
 * Resolve the caller's ClusterTenant from their IdP-verified email, fail-closed.
 * Mirrors `OidcAuthService._resolveClusterTenant`: at most one tenant may match, and
 * its `clusterTenantRef` is returned. Returns null on a missing/ambiguous email or any
 * lookup failure — never an arbitrary pick, never taken from request input.
 *
 * @param prisma - Prisma client for the tenant lookup.
 * @param email  - The session's verified email claim, if any.
 */
async function _ResolveCallerClusterTenant(prisma: PrismaClient, email: string | undefined): Promise<string | null>
{
  const normalized = typeof email === "string" ? email.toLowerCase().trim() : "";
  if (!normalized)
  {
    return null;
  }

  try
  {
    const matches = await prisma.tenant.findMany({
      where: { email: { equals: normalized, mode: "insensitive" } },
      select: { clusterTenantRef: true },
      take: 2,
    });
    if (matches.length !== 1)
    {
      return null;
    }
    return matches[0].clusterTenantRef ?? null;
  }
  catch
  {
    return null;
  }
}
