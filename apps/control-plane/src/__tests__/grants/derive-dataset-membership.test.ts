import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _DeriveTenantDatasetMembership } from "../../core/grants/derive-dataset-membership.js";

/** A group row in the shape the derivation selects. */
interface _GroupRow
{
  scope: string;
  members: unknown;
}

/** Build a Prisma stub whose group.findMany returns the given groups. */
function _prisma(groups: _GroupRow[]): PrismaClient
{
  return { group: { findMany: vi.fn(async function _findMany() { return groups; }) } } as unknown as PrismaClient;
}

describe("_DeriveTenantDatasetMembership — dataset scopes from group membership (S4c)", function _suite()
{
  it("populates each tier from the members of the groups the principal set is in", async function _derives()
  {
    const groups: _GroupRow[] = [
      { scope: "Team", members: ["alice", "bob"] },           // tenant's user is alice → team = members
      { scope: "Department", members: ["alice", "carol"] },   // matches via alice
      { scope: "Project", members: ["dave"] },                // no principal → excluded
      { scope: "Personal", members: ["alice", "erin"] },      // a resource share-group → personal
    ];

    const membership = await _DeriveTenantDatasetMembership(_prisma(groups), "acme-tenant", "alice");

    // Org is always the singleton; group members never enumerate it.
    expect(membership.org).toEqual(["default"]);
    // Matched groups contribute their members (deduped + sorted); the unmatched project group does not.
    expect(membership.team).toEqual(["alice", "bob"]);
    expect(membership.department).toEqual(["alice", "carol"]);
    expect(membership.project).toEqual([]);
    // Personal is NOT self-only — it is the members of the resource share-groups the tenant is in.
    expect(membership.personal).toEqual(["alice", "erin"]);
  });

  it("matches a group via the tenant NAME too, not only the subject", async function _matchesTenantName()
  {
    const groups: _GroupRow[] = [{ scope: "Team", members: ["acme-tenant"] }];
    const membership = await _DeriveTenantDatasetMembership(_prisma(groups), "acme-tenant", "alice");
    expect(membership.team).toEqual(["acme-tenant"]);
  });

  it("unions + dedupes members across multiple groups of the same scope", async function _unions()
  {
    const groups: _GroupRow[] = [
      { scope: "Team", members: ["alice", "bob"] },
      { scope: "Team", members: ["alice", "zoe"] },
    ];
    const membership = await _DeriveTenantDatasetMembership(_prisma(groups), "acme-tenant", "alice");
    expect(membership.team).toEqual(["alice", "bob", "zoe"]);
  });

  it("an unbound tenant (no subject) still matches groups by tenant name; otherwise empty", async function _unbound()
  {
    const groups: _GroupRow[] = [
      { scope: "Team", members: ["alice"] },        // no tenant-name, no subject → excluded
      { scope: "Project", members: ["acme-tenant"] }, // tenant-name → included
    ];
    const membership = await _DeriveTenantDatasetMembership(_prisma(groups), "acme-tenant", null);
    expect(membership.team).toEqual([]);
    expect(membership.project).toEqual(["acme-tenant"]);
    expect(membership.org).toEqual(["default"]);
  });
});
