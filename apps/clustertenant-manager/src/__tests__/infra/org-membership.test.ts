import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _ResolveOrgMembershipFacts } from "@opencrane/infra-auth";

/**
 * Unit coverage for the membership-derived org-admin facts (ORG-ADMIN.5): authority
 * is derived purely from OrgMembership rows (owner/admin), keyed on the verified
 * subject, and fails closed on a missing subject or a lookup error.
 */
describe("_ResolveOrgMembershipFacts (ORG-ADMIN.5)", function _suite()
{
  it("derives isOrgAdmin + ownedOrgs from owner/admin rows", async function _derives()
  {
    const findMany = vi.fn().mockResolvedValue([
      { clusterTenant: "acme", role: "Owner" },
      { clusterTenant: "globex", role: "Admin" },
    ]);
    const prisma = { orgMembership: { findMany } } as unknown as PrismaClient;

    const facts = await _ResolveOrgMembershipFacts(prisma, "user-1");

    expect(facts.isOrgAdmin).toBe(true);
    expect(facts.ownedOrgs).toEqual([
      { clusterTenant: "acme", role: "owner" },
      { clusterTenant: "globex", role: "admin" },
    ]);
    // Only owner/admin rows are queried — plain members confer no admin authority.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subject: "user-1", role: { in: ["Owner", "Admin"] } } }));
  });

  it("returns empty facts (not an admin) when the caller administers no org", async function _noOrgs()
  {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { orgMembership: { findMany } } as unknown as PrismaClient;

    const facts = await _ResolveOrgMembershipFacts(prisma, "user-2");

    expect(facts.isOrgAdmin).toBe(false);
    expect(facts.ownedOrgs).toEqual([]);
  });

  it("fails closed on a missing subject — never hits the DB", async function _noSubject()
  {
    const findMany = vi.fn();
    const prisma = { orgMembership: { findMany } } as unknown as PrismaClient;

    const facts = await _ResolveOrgMembershipFacts(prisma, undefined);

    expect(facts).toEqual({ isOrgAdmin: false, ownedOrgs: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("fails closed (no authority) on a lookup error", async function _dbError()
  {
    const findMany = vi.fn().mockRejectedValue(new Error("db down"));
    const prisma = { orgMembership: { findMany } } as unknown as PrismaClient;

    const facts = await _ResolveOrgMembershipFacts(prisma, "user-3");

    expect(facts).toEqual({ isOrgAdmin: false, ownedOrgs: [] });
  });
});
