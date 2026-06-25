import type { PrismaClient } from "@prisma/client";

import type { TenantDatasetMembership } from "../../routes/internal/tenant-datasets.types.js";

/**
 * Dataset-membership key for each group scope. The vocabularies are 1:1 since S4c.1, so the
 * map is the identity except for `Org`: the org dataset is the `["default"]` singleton (every
 * member of the org shares it), so it is never enumerated from a group's member list. A
 * `Personal`-scoped group is a resource-scoped share-group (created around a shared file/chat),
 * so its members populate the recipient's `personal` dataset — Personal is NOT self-only.
 */
const _DATASET_KEY_BY_GROUP_SCOPE: Record<string, keyof TenantDatasetMembership | null> = {
  Org: null,
  Department: "department",
  Team: "team",
  Project: "project",
  Personal: "personal",
};

/**
 * The non-org dataset tiers enumerated from group membership. Listed in retrieval relevance
 * order (most → least relevant; see DATASET_SCOPE_RETRIEVAL_PRECEDENCE) for readability, but
 * the order here is cosmetic — it only drives the per-tier normalisation loop below. Org is
 * excluded (it is the `["default"]` singleton, never enumerated from members).
 */
const _ENUMERATED_KEYS = ["personal", "project", "team", "department"] as const;

/**
 * Derive a tenant's Cognee dataset memberships from the IAM groups its principal set belongs to
 * (S4c). In the unified model every dataset tier IS a scope-typed `Group`; a tenant's membership
 * at a scope is the union of the members of every group (of that scope) that contains the
 * tenant's `{tenant-name, subject}`. The org tier is the `["default"]` singleton (not enumerated);
 * every other tier — including Personal, which is populated by per-resource share-groups — is the
 * union of the matching groups' members. This is the source of truth that replaces the manual
 * dataset path and is synced to Cognee.
 *
 * Pure read over the `Group` table — no Cognee or external call — so it is safe to run on every
 * contract compile and diff against the persisted membership before writing.
 *
 * @param prisma - Prisma client used to read the group mirror.
 * @param tenantName - The openclaw Tenant whose memberships are derived.
 * @param subject - The tenant's bound IdP subject, or null for a legacy/unbound tenant.
 * @returns The derived dataset membership ({org,team,department,project,personal}).
 */
export async function _DeriveTenantDatasetMembership(prisma: PrismaClient, tenantName: string, subject: string | null): Promise<TenantDatasetMembership>
{
  // 1. The principal set is the tenant name plus its bound subject (the same set the contract
  //    compiler inherits over). A group matches when it contains ANY principal.
  const principals = new Set<string>([tenantName]);
  if (subject)
  {
    principals.add(subject);
  }

  // 2. Read the group mirror and seed the membership with the org singleton.
  const groups = await prisma.group.findMany({ select: { scope: true, members: true } });
  const membership: TenantDatasetMembership = { org: ["default"], team: [], department: [], project: [], personal: [] };

  // 3. For every group the principal set is in, add the group's members to that group's scope tier
  //    (org is the singleton and is never enumerated from members).
  for (const group of groups)
  {
    const members = Array.isArray(group.members) ? group.members.filter(function _isString(m): m is string { return typeof m === "string"; }) : [];
    if (!members.some(function _contains(m) { return principals.has(m); }))
    {
      continue;
    }
    const key = _DATASET_KEY_BY_GROUP_SCOPE[group.scope as string];
    if (!key)
    {
      continue;
    }
    membership[key].push(...members);
  }

  // 4. Canonicalise the SUBJECTS within each tier — dedupe + alphabetical sort — purely so the
  //    derived membership diffs cleanly (byte-identical arrays) against the persisted projection
  //    and Cognee, keeping the diff-gate stable. This sorts subjects inside a tier; it is NOT a
  //    relevance ordering of the scope tiers (that is DATASET_SCOPE_RETRIEVAL_PRECEDENCE, consumed
  //    by the retrieval chain, not here).
  for (const key of _ENUMERATED_KEYS)
  {
    membership[key] = Array.from(new Set(membership[key])).sort();
  }
  return membership;
}
