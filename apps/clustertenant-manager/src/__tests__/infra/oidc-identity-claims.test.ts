import { describe, expect, it } from "vitest";

import { _ResolveIdentityClaims } from "@opencrane/infra-auth";

/** Default claim names with one configured operator + one org-admin group, mirroring the loader. */
const _CONFIG = {
  groupsClaim: "groups",
  rolesClaim: "roles",
  platformOperatorGroups: ["opencrane-operators"],
  orgAdminGroups: ["opencrane-org-admins"],
  // Empty seed by default — the seed must grant operator to nobody unless a test opts in.
  platformOperatorSeedEmail: "",
};

describe("_ResolveIdentityClaims — groups + isPlatformOperator projection (WOI.1)", function _suite()
{
  it("marks the caller a platform operator when a groups-claim value matches a configured operator group", function _operatorViaGroups()
  {
    const result = _ResolveIdentityClaims({ groups: ["Acme-Users", "OpenCrane-Operators"] }, _CONFIG);

    expect(result.isPlatformOperator).toBe(true);
    // Platform operators are always org admins (operator is the broader role).
    expect(result.isOrgAdmin).toBe(true);
    expect(result.groups).toEqual(["Acme-Users", "OpenCrane-Operators"]);
  });

  it("matches operator groups case-insensitively and also reads the roles claim", function _operatorViaRoles()
  {
    const result = _ResolveIdentityClaims({ roles: "opencrane-operators" }, _CONFIG);

    expect(result.isPlatformOperator).toBe(true);
    expect(result.groups).toEqual(["opencrane-operators"]);
  });

  it("is not a platform operator when no group matches", function _notOperator()
  {
    const result = _ResolveIdentityClaims({ groups: ["acme-admins"] }, _CONFIG);

    expect(result.isPlatformOperator).toBe(false);
  });

  it("nobody is a platform operator when no operator groups are configured (fail-closed)", function _emptyOperatorSet()
  {
    const result = _ResolveIdentityClaims({ groups: ["opencrane-operators"] }, { ..._CONFIG, platformOperatorGroups: [] });

    expect(result.isPlatformOperator).toBe(false);
  });

  it("returns an empty group list and is not an operator when neither claim is present", function _noGroups()
  {
    const result = _ResolveIdentityClaims({}, _CONFIG);

    expect(result.groups).toEqual([]);
    expect(result.isPlatformOperator).toBe(false);
    expect(result.isOrgAdmin).toBe(false);
  });

  it("marks a non-operator an org admin when a group matches the org-admin set (P0.5)", function _orgAdminViaGroups()
  {
    const result = _ResolveIdentityClaims({ groups: ["Acme-Users", "OpenCrane-Org-Admins"] }, _CONFIG);

    expect(result.isOrgAdmin).toBe(true);
    expect(result.isPlatformOperator).toBe(false);
  });

  it("is not an org admin when no group matches the org-admin set", function _notOrgAdmin()
  {
    const result = _ResolveIdentityClaims({ groups: ["acme-admins"] }, _CONFIG);

    expect(result.isOrgAdmin).toBe(false);
  });

  it("nobody is an org admin when no org-admin groups are configured (fail-closed)", function _emptyOrgAdminSet()
  {
    const result = _ResolveIdentityClaims({ groups: ["opencrane-org-admins"] }, { ..._CONFIG, orgAdminGroups: [] });

    expect(result.isOrgAdmin).toBe(false);
  });
});

describe("_ResolveIdentityClaims — platform-operator seed email (per-cluster bootstrap)", function _seedSuite()
{
  /** A config with one configured seed email and NO operator groups, so only the seed can grant operator. */
  const _SEED_CONFIG = {
    ..._CONFIG,
    platformOperatorGroups: [],
    platformOperatorSeedEmail: "owner@cluster.example",
  };

  it("an empty seed never grants platform operator, even when the verified email is non-empty (fail-closed)", function _emptySeed()
  {
    const result = _ResolveIdentityClaims({ groups: ["acme-users"] }, { ..._CONFIG, platformOperatorGroups: [] }, "owner@cluster.example");

    expect(result.isPlatformOperator).toBe(false);
    expect(result.isOrgAdmin).toBe(false);
  });

  it("a verified email equal to the seed grants platform operator (and therefore org admin)", function _seedMatch()
  {
    const result = _ResolveIdentityClaims({ groups: ["acme-users"] }, _SEED_CONFIG, "owner@cluster.example");

    expect(result.isPlatformOperator).toBe(true);
    expect(result.isOrgAdmin).toBe(true);
  });

  it("matches the seed case-insensitively and ignores surrounding whitespace", function _seedCaseWhitespace()
  {
    const result = _ResolveIdentityClaims({}, { ..._SEED_CONFIG, platformOperatorSeedEmail: "  Owner@Cluster.Example  " }, "owner@cluster.example");

    expect(result.isPlatformOperator).toBe(true);
  });

  it("a verified email that does not match the seed is not a platform operator", function _seedNoMatch()
  {
    const result = _ResolveIdentityClaims({}, _SEED_CONFIG, "someone-else@cluster.example");

    expect(result.isPlatformOperator).toBe(false);
  });

  it("an UNVERIFIED email equal to the seed is NOT a platform operator (verifiedEmail must be supplied)", function _seedUnverified()
  {
    // The caller projects only a verified email into `verifiedEmail`; an unverified email
    // arrives as undefined, so it can never match the seed — fail-closed.
    const result = _ResolveIdentityClaims({}, _SEED_CONFIG, undefined);

    expect(result.isPlatformOperator).toBe(false);
  });

  it("seed is ADDITIVE to groups — a group match still grants operator when the email does not match the seed", function _seedAdditive()
  {
    const result = _ResolveIdentityClaims(
      { groups: ["opencrane-operators"] },
      { ..._CONFIG, platformOperatorSeedEmail: "owner@cluster.example" },
      "not-the-seed@cluster.example",
    );

    expect(result.isPlatformOperator).toBe(true);
  });
});
