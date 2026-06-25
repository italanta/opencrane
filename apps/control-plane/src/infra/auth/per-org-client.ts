import type { PrismaClient } from "@prisma/client";

import { _ClusterTenantFromHost } from "./request-silo.js";
import type { ResolvedPerOrgClient } from "./per-org-client.types.js";

/**
 * Build the Zitadel org-restriction login scope for an org id. Adding
 * `urn:zitadel:iam:org:id:{orgId}` to the authorization request restricts the login to
 * that organisation's user pool, so only members of the org may authenticate at its host.
 * Centralised so the provisioner-side string and the login-side string can never drift.
 *
 * @param orgId - The Zitadel Organization id of the per-org client.
 * @returns The org-scope string to append to the OIDC `scope` parameter.
 * @see https://zitadel.com/docs/apis/openidoauth/scopes
 */
export function _OrgScope(orgId: string): string
{
  return `urn:zitadel:iam:org:id:${orgId}`;
}

/**
 * Resolve the per-org OIDC client for a request host (S3b). For a host `<org>.<base>` the
 * first DNS label names the silo; we confirm it against a ClusterTenant row and return its
 * `{clientId, orgId, redirectUri}` so login can authorize against that org's isolated user
 * pool. Fail-closed: returns null for
 *  - a host with no derivable silo label (bare host / platform host),
 *  - a label with no matching ClusterTenant, or
 *  - a ClusterTenant whose org is not fully provisioned (no `zitadelClientId`/`zitadelOrgId`).
 * In every null case the caller falls through to the masters client config — never a
 * partial per-org login. The DB read is the single source of truth, so a spoofed host
 * label that names no real, fully-provisioned org cannot pick up an org client.
 *
 * @param prisma - Prisma client used to confirm the silo and read its persisted client ids.
 * @param host   - The request host (typically from `_RequestHost`).
 * @returns The resolved per-org client, or null to fall through to the masters client.
 */
export async function _ResolvePerOrgClient(prisma: PrismaClient, host: string | undefined): Promise<ResolvedPerOrgClient | null>
{
  // 1. Derive the candidate silo from the host's first DNS label. A bare host (no
  //    subdomain — e.g. the platform host or localhost) yields undefined, so the
  //    platform host keeps using the masters client without a DB hit.
  const candidate = _ClusterTenantFromHost(host);
  if (!candidate)
  {
    return null;
  }

  // 2. Confirm the label is a real ClusterTenant and read its persisted Zitadel ids. The
  //    DB row is authoritative: a host label that names no row resolves to null, so a
  //    fabricated host can never select an org client it does not own.
  const row = await prisma.clusterTenant.findUnique({
    where: { name: candidate },
    select: { name: true, zitadelClientId: true, zitadelOrgId: true, zitadelRedirectUri: true },
  });
  if (!row)
  {
    return null;
  }

  // 3. Fail-closed on a half-provisioned org: both the client_id (the credential) and the
  //    org id (the user-pool restriction scope) must exist, else we cannot build a SAFE
  //    org-scoped login and fall through to the masters client rather than logging in
  //    against the wrong / an unrestricted pool.
  if (!row.zitadelClientId || !row.zitadelOrgId)
  {
    return null;
  }

  return {
    clusterTenant: row.name,
    clientId: row.zitadelClientId,
    orgId: row.zitadelOrgId,
    redirectUri: row.zitadelRedirectUri ?? null,
  };
}
