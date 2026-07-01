import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _EnsureOwnerDefaultTenant } from "../../core/cluster-tenants/default-tenant.js";

/**
 * Onboarding precondition (LiteLLM `replace` mode): a silo with zero registered models would
 * provision a pod with an empty allowlist and no usable models, so the default-workspace seed is
 * refused until at least one model exists at the org's scope. These tests pin both branches.
 */

/** Minimal Prisma stub for the no-cluster (customApi=null) seed path; `count` drives the gate. */
function _mockPrisma(modelCount: number, onCreate: () => void): PrismaClient
{
  return {
    tenant: {
      findUnique: async function _findUnique() { return null; },
      create: async function _create(args: { data: Record<string, unknown> }) { onCreate(); return args.data; },
    },
    modelDefinition: {
      count: async function _count() { return modelCount; },
    },
    auditEntry: {
      create: async function _create() { return {}; },
    },
  } as unknown as PrismaClient;
}

describe("_EnsureOwnerDefaultTenant — onboarding ≥1-model gate", function _suite()
{
  it("skips the default-tenant seed when no models are registered", async function _gated()
  {
    const createSpy = vi.fn();
    const res = await _EnsureOwnerDefaultTenant({
      customApi: null, prisma: _mockPrisma(0, createSpy), namespace: "ns", orgName: "acme", orgDisplayName: "Acme", ownerEmail: "owner@acme.com",
    });

    expect(res.created).toBe(false);
    expect(res.skippedReason).toMatch(/no models registered/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("seeds the default tenant once at least one model exists", async function _proceeds()
  {
    const createSpy = vi.fn();
    const res = await _EnsureOwnerDefaultTenant({
      customApi: null, prisma: _mockPrisma(1, createSpy), namespace: "ns", orgName: "acme", orgDisplayName: "Acme", ownerEmail: "owner@acme.com",
    });

    expect(res.created).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();
  });
});
