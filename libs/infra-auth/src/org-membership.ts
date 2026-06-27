/**
 * Minimal structural view of the rows {@link _ResolveOrgMembershipFacts} reads. Both managers'
 * Prisma clients expose an `OrgMembership` model with these fields, so each can pass its own
 * (otherwise divergent) client without the lib depending on a concrete generated client.
 */
export interface OrgMembershipRow
{
  /** The organisation (ClusterTenant) key. */
  clusterTenant: string;

  /** The membership role as stored (`Owner` | `Admin` | `Member`). */
  role: string;
}

/**
 * The minimal `OrgMembership` read surface the membership resolver needs. The `findMany`
 * argument is typed `unknown` so each manager's full (and otherwise divergent) Prisma client
 * is assignable here — the lib supplies the concrete query object at the call site, and the
 * narrowed `OrgMembershipRow[]` return is what the resolver relies on.
 */
export interface OrgMembershipReader
{
  orgMembership: {
    findMany(args: unknown): Promise<OrgMembershipRow[]>;
  };
}

/** One organisation the caller administers, with the role they hold there. */
export interface OwnedOrg
{
  /** The organisation (ClusterTenant) key. */
  clusterTenant: string;

  /** The administering role the caller holds — `owner` or `admin`. */
  role: "owner" | "admin";
}

/**
 * The caller's membership-derived org-admin facts. Authority is derived purely
 * from `OrgMembership` rows, never from a global flag or a self-asserted claim.
 */
export interface OrgMembershipFacts
{
  /**
   * True iff the caller owns or administers ≥1 organisation — i.e. {@link ownedOrgs}
   * is non-empty. The membership-derived half of a session's `isOrgAdmin`.
   */
  isOrgAdmin: boolean;

  /**
   * The organisations the caller owns or administers (the org scope). Members
   * (role `member`) confer no admin authority and are excluded. Empty when the
   * caller administers no org.
   */
  ownedOrgs: OwnedOrg[];
}

/** Empty (fail-closed) facts: no admin authority, no org scope. */
const _EMPTY: OrgMembershipFacts = { isOrgAdmin: false, ownedOrgs: [] };

/**
 * Resolve the caller's org-admin facts from their `OrgMembership` rows, fail-closed.
 *
 * The single source of truth for membership-derived authority, so the rule cannot
 * drift between `/auth/me` (introspection) and the cluster-tenant guard (enforcement):
 *
 *   - A subject who holds `owner` or `admin` on ≥1 org IS an org admin, scoped to
 *     exactly those orgs.
 *   - `member` rows confer no admin authority and are excluded from the scope.
 *   - A missing subject, no rows, or any lookup failure ⇒ empty facts (no authority).
 *
 * Keyed on the IdP-verified subject (OIDC `sub`), never request input.
 *
 * @param reader  - A client exposing the minimal `OrgMembership` read surface.
 * @param subject - The caller's IdP-verified subject; empty/undefined ⇒ empty facts.
 * @returns The derived org-admin flag and the owned/administered org set.
 */
export async function _ResolveOrgMembershipFacts(reader: OrgMembershipReader, subject: string | undefined): Promise<OrgMembershipFacts>
{
  const normalized = typeof subject === "string" ? subject.trim() : "";
  if (!normalized)
  {
    return _EMPTY;
  }

  try
  {
    const rows = await reader.orgMembership.findMany({
      where: { subject: normalized, role: { in: ["Owner", "Admin"] } },
      select: { clusterTenant: true, role: true },
      orderBy: { clusterTenant: "asc" },
    });

    const ownedOrgs: OwnedOrg[] = rows.map(function _toOwned(row)
    {
      return { clusterTenant: row.clusterTenant, role: row.role === "Owner" ? "owner" : "admin" };
    });

    return { isOrgAdmin: ownedOrgs.length > 0, ownedOrgs };
  }
  catch
  {
    // Fail closed: a lookup failure must never silently grant org-admin authority.
    return _EMPTY;
  }
}
