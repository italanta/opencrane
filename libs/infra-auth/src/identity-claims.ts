/**
 * Project the IdP's group/role claims into the introspection-only authorization
 * facts a manager surfaces: the caller's `groups` and the derived `isPlatformOperator`
 * / `isOrgAdmin`. Pure (no I/O) so it is unit-testable and so the rule "operator iff a
 * group matches a configured operator group, OR the verified email matches the per-cluster
 * seed" is verified independently of the OIDC flow.
 *
 * `clusterTenant` is intentionally NOT derived here — when a consumer needs it (the
 * clustertenant-manager), it is resolved server-side from the verified email, never from
 * a self-asserted claim.
 *
 * TODO: this is the non-presumptuous stopgap until OpenCrane has a first-class
 * role model; a real RBAC model supersedes `isPlatformOperator`.
 *
 * @param claims        - The merged ID-token + UserInfo claims for the caller.
 * @param config        - OIDC config supplying the claim names, operator group set, and seed email.
 * @param verifiedEmail - The caller's email when it is verified (lowercased/trimmed); empty/undefined
 *                        when absent or NOT verified, so an unverified email can never match the seed.
 */
export function _ResolveIdentityClaims(
  claims: Record<string, unknown>,
  config: { groupsClaim: string; rolesClaim: string; platformOperatorGroups: string[]; orgAdminGroups: string[]; platformOperatorSeedEmail: string },
  verifiedEmail?: string,
): { groups: string[]; isPlatformOperator: boolean; isOrgAdmin: boolean }
{
  // 1. Collect the raw values from both the groups and roles claims — Zitadel emits
  //    group memberships under the configured `groups` claim and project/app roles
  //    under `roles`; either may grant operator status, so the union is what we
  //    authorize against. Claim names are install-configurable via OIDC_GROUPS_CLAIM
  //    / OIDC_ROLES_CLAIM.
  const groups = [..._ReadStringArrayClaim(claims[config.groupsClaim]), ..._ReadStringArrayClaim(claims[config.rolesClaim])];
  const lowered = groups.map(value => value.toLowerCase());

  // 2. Operator via group: an empty operator set means nobody qualifies — fail-closed.
  const operatorSet = new Set(config.platformOperatorGroups);
  const operatorViaGroup = operatorSet.size > 0 && lowered.some(value => operatorSet.has(value));

  // 3. Operator via seed: the per-cluster bootstrap. True iff a non-empty seed equals the
  //    caller's VERIFIED email (already lowercased/trimmed). An empty seed grants operator
  //    to nobody (fail-closed); an unverified email never reaches `verifiedEmail`, so it can
  //    never match. This is ADDITIVE to the group check — seed OR group ⇒ operator.
  const seed = config.platformOperatorSeedEmail.trim().toLowerCase();
  const operatorViaSeed = seed !== "" && typeof verifiedEmail === "string" && verifiedEmail.trim().toLowerCase() === seed;

  const isPlatformOperator = operatorViaGroup || operatorViaSeed;

  // 4. Org admin (login-time component) iff a group matches the org-admin set
  //    (fail-closed when unset). Platform operators are always org admins — operator
  //    is the broader role. NOTE: this is only the GROUP-derived half; `/auth/me`
  //    OR-s it with the MEMBERSHIP-derived half (owner/admin of ≥1 org via
  //    `OrgMembership`, resolved fresh at read time), so a user who creates an org is
  //    an org admin even with no org-admin group claim.
  const orgAdminSet = new Set(config.orgAdminGroups);
  const isOrgAdmin = isPlatformOperator || (orgAdminSet.size > 0 && lowered.some(value => orgAdminSet.has(value)));

  return { groups, isPlatformOperator, isOrgAdmin };
}

/**
 * Normalize a claim value into a list of non-empty strings. Identity providers
 * emit group/role claims as either an array or a single string, so both shapes are
 * accepted; anything else yields an empty list.
 *
 * @param value - The raw claim value.
 */
export function _ReadStringArrayClaim(value: unknown): string[]
{
  if (Array.isArray(value))
  {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  }

  if (typeof value === "string" && value.trim() !== "")
  {
    return [value.trim()];
  }

  return [];
}
