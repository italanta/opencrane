import type { PrismaClient } from "@prisma/client";

import { _NamespaceForOrg } from "../../shared/org-namespace.js";

/**
 * The authoritative routing decision the identity-routing gateway proxy needs to
 * forward one user's gateway WebSocket to their own OpenClaw pod:
 *  - `user`        — the IdP-verified identity the proxy logs / rate-limits on.
 *  - `tenant`      — the resolved per-user OpenClaw tenant (one pod per user).
 *  - `podService`  — the in-cluster Service the proxy reverse-proxies to. The proxy
 *                    composes the FQDN + port itself (`<name>.<namespace>.svc:<port>`),
 *                    so transport details never leak into the control plane.
 */
export interface GatewayResolveResult
{
  user: { email: string; sub: string };
  tenant: { name: string; clusterTenantRef: string | null };
  podService: { name: string; namespace: string };
}

/** Fail-closed reasons a gateway target cannot be resolved (all map to 403 at the edge). */
export type GatewayResolveFailure = "NO_EMAIL" | "NO_TENANT" | "AMBIGUOUS_TENANT";

/** Resolution outcome: a forward target, or a fail-closed reason. */
export type GatewayResolveOutcome =
  | { ok: true; resolved: GatewayResolveResult }
  | { ok: false; code: GatewayResolveFailure };

/**
 * Resolve the OpenClaw pod a session may reach, **solely** from the IdP-verified
 * email — there is no request-supplied tenant input, and the resolution is the same
 * fail-closed email→tenant rule used by `/pod-token` (see
 * {@link _ResolveCallerClusterTenant}): zero matches or an ambiguous (>1) match
 * resolves to a forbidden outcome, never an arbitrary pick. This is the routing-level
 * half of cross-tenant safety; the pod-level half is per-pod owner pinning (CONN.10).
 *
 * The pod's namespace is re-derived from the tenant's owning org
 * (`opencrane-<clusterTenantRef>`); a tenant with no org ref (legacy single-namespace
 * install) falls back to the control plane's own namespace.
 *
 * @param prisma           - Prisma client for the email→tenant lookup.
 * @param defaultNamespace - Namespace for tenants with no org ref (the CP's own ns).
 * @param email            - The session's verified email claim.
 * @param sub              - The session subject (logged identity); falls back to email.
 * @returns A forward target, or a fail-closed reason.
 */
export async function _ResolveGatewayTarget(
  prisma: PrismaClient,
  defaultNamespace: string,
  email: string | undefined,
  sub: string,
): Promise<GatewayResolveOutcome>
{
  const normalized = typeof email === "string" ? email.toLowerCase().trim() : "";
  if (!normalized)
  {
    return { ok: false, code: "NO_EMAIL" };
  }

  // Fail closed: at most one tenant may match. `take: 2` is enough to detect ambiguity
  // without scanning the whole table — an ambiguous email must never silently route the
  // caller to one of several pods (which could be another user's).
  const matches = await prisma.tenant.findMany({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { name: true, clusterTenantRef: true },
    take: 2,
  });

  if (matches.length === 0)
  {
    return { ok: false, code: "NO_TENANT" };
  }
  if (matches.length > 1)
  {
    return { ok: false, code: "AMBIGUOUS_TENANT" };
  }

  const tenant = matches[0];
  const namespace = tenant.clusterTenantRef ? _NamespaceForOrg(tenant.clusterTenantRef) : defaultNamespace;

  return {
    ok: true,
    resolved: {
      user: { email: normalized, sub: sub.length > 0 ? sub : normalized },
      tenant: { name: tenant.name, clusterTenantRef: tenant.clusterTenantRef },
      podService: { name: `openclaw-${tenant.name}`, namespace },
    },
  };
}
