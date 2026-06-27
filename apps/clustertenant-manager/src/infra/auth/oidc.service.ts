import type { Request } from "express";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";

import { OidcAuthServiceBase, _RequestHost } from "@opencrane/infra-auth";
import type { AuthUser, LoginClient } from "@opencrane/infra-auth";

import { _ResolveCallerClusterTenant } from "./resolve-caller-cluster-tenant.js";
import { _ClusterTenantFromHost } from "./request-silo.js";
import { _OrgScope, _ResolvePerOrgClient } from "./per-org-client.js";

/**
 * The clustertenant-manager's OIDC auth service. Extends the shared
 * {@link OidcAuthServiceBase} (provider discovery, PKCE login, token exchange, claim
 * validation, session lifecycle, membership-derived org-admin facts) with the two
 * silo-specific seams:
 *
 *   - {@link resolveLoginClient} — per-org login. A host `<org>.<base>` (or a customer
 *     vanity domain) that maps to a fully-provisioned ClusterTenant authorizes against THAT
 *     org's Zitadel client + org-restriction scope, so only its user pool may log in. The
 *     platform host / any unknown/unprovisioned host falls through to the masters client.
 *   - {@link enrichStatusUser} — `/auth/me` adds the caller's `clusterTenant`, resolved
 *     server-side from their verified email (scoped to the silo whose host they are on),
 *     never from a self-asserted claim.
 */
export class OidcAuthService extends OidcAuthServiceBase
{
  /** Prisma client for per-org client resolution and the email→tenant→clusterTenant lookup. */
  private prisma: PrismaClient;

  /**
   * @param log    - Parent logger; a child scoped to `oidc-auth` is derived by the base.
   * @param prisma - Prisma client (also the base's `OrgMembership` read surface).
   */
  constructor(log: Logger, prisma: PrismaClient)
  {
    super(log, prisma);
    this.prisma = prisma;
  }

  /**
   * Resolve the per-org OIDC client for this request host; fall through to the masters
   * client when the host maps to no fully-provisioned org.
   */
  protected override async resolveLoginClient(req: Request): Promise<LoginClient>
  {
    const perOrg = await _ResolvePerOrgClient(this.prisma, _RequestHost(req));
    if (!perOrg)
    {
      return super.resolveLoginClient(req);
    }
    const config = await this.discoverForClient(perOrg.clientId);
    return { config, scope: `${this.config.scopes} ${_OrgScope(perOrg.orgId)}`, clientId: perOrg.clientId };
  }

  /**
   * Add the caller's `clusterTenant` to `/auth/me`, resolved fresh from their verified email
   * scoped to the silo derived from the request host. Null when unresolved/ambiguous (a
   * multi-silo owner viewing a host they own no workspace on, or "No tenant yet").
   */
  protected override async enrichStatusUser(req: Request, authUser: AuthUser): Promise<Record<string, unknown>>
  {
    const clusterTenant = await _ResolveCallerClusterTenant(this.prisma, authUser.email, _ClusterTenantFromHost(_RequestHost(req)));
    return { clusterTenant };
  }
}

/**
 * Create the OIDC auth service used by the clustertenant-manager Express app.
 * @param log    - Parent logger.
 * @param prisma - Prisma client for per-org resolution + the email→tenant lookup.
 */
export function ___CreateOidcAuthService(log: Logger, prisma: PrismaClient): OidcAuthService
{
  return new OidcAuthService(log, prisma);
}
