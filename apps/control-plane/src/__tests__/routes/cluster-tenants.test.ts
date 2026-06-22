import express from "express";
import type { Express } from "express";
import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import type { ClusterTenantProvisionerRegistry } from "@opencrane/contracts";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { clusterTenantsRouter } from "../../routes/cluster-tenants.js";

/** In-memory cluster_tenants store backing the mock Prisma client. */
type Row = Record<string, unknown>;

/** Build a Prisma stub over an in-memory map keyed by tenant name. */
function _mockPrisma(store: Map<string, Row>): PrismaClient
{
  const memberships: Row[] = [];
  const prisma = {
    clusterTenant: {
      findMany: vi.fn(async function _findMany() { return Array.from(store.values()); }),
      findUnique: vi.fn(async function _findUnique(args: { where: { name: string } }) { return store.get(args.where.name) ?? null; }),
      create: vi.fn(async function _create(args: { data: Row })
      {
        const row = { nodePool: null, message: null, boundNamespace: null, provisioner: null, ...args.data };
        store.set(args.data.name as string, row);
        return row;
      }),
      update: vi.fn(async function _update(args: { where: { name: string }; data: Row })
      {
        const row = { ...(store.get(args.where.name) as Row), ...args.data };
        store.set(args.where.name, row);
        return row;
      }),
      delete: vi.fn(async function _delete(args: { where: { name: string } }) { store.delete(args.where.name); return {}; }),
    },
    orgMembership: {
      create: vi.fn(async function _createMembership(args: { data: Row }) { memberships.push(args.data); return args.data; }),
    },
    // Run the callback inline against the same stub — the in-memory store has no real
    // transaction boundary, which is fine for these unit tests.
    $transaction: vi.fn(async function _tx(fn: (tx: PrismaClient) => Promise<unknown>) { return fn(prisma); }),
  } as unknown as PrismaClient;
  return prisma;
}

/** Registry stub: serves shared + dedicatedNodes; dedicatedCluster gated by flag. */
function _mockRegistry(dedicatedClusterAvailable: boolean): ClusterTenantProvisionerRegistry
{
  return {
    isTierAvailable(tier: ClusterTenantIsolationTier): boolean
    {
      if (tier === ClusterTenantIsolationTier.DedicatedCluster)
      {
        return dedicatedClusterAvailable;
      }
      return true;
    },
    capabilities() { return []; },
  };
}

/** Build a minimal app mounting only the cluster-tenants router. */
function _buildApp(prisma: PrismaClient, registry: ClusterTenantProvisionerRegistry): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/cluster-tenants", clusterTenantsRouter(prisma, registry));
  return app;
}

/** A valid shared-tier create body. */
function _sharedBody()
{
  return {
    name: "acme",
    displayName: "Acme Corp",
    isolationTier: "shared",
    compute: { mode: "shared" },
    resources: { quota: { cpu: "4", memory: "8Gi" } },
  };
}

describe("clusterTenantsRouter (CT.2 management API)", function _suite()
{
  it("creates, lists, gets, updates, and deletes a shared cluster tenant", async function _crud()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));

    // 1. Create.
    const createRes = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());
    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({ name: "acme", isolationTier: "shared", status: { phase: "pending" } });

    // 2. List + get.
    const listRes = await request(app).get("/api/v1/cluster-tenants");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    const getRes = await request(app).get("/api/v1/cluster-tenants/acme");
    expect(getRes.status).toBe(200);
    expect(getRes.body.displayName).toBe("Acme Corp");

    // 3. Status read.
    const statusRes = await request(app).get("/api/v1/cluster-tenants/acme/status");
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.phase).toBe("pending");

    // 4. Update + delete.
    const updateRes = await request(app).put("/api/v1/cluster-tenants/acme").send({ displayName: "Acme Inc" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("Acme Inc");
    const deleteRes = await request(app).delete("/api/v1/cluster-tenants/acme");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ name: "acme", status: "deleted" });
  });

  it("rejects a dedicatedCluster request with 422 TIER_UNAVAILABLE when no backend is registered", async function _overTier()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));
    const res = await request(app).post("/api/v1/cluster-tenants").send({ ..._sharedBody(), isolationTier: "dedicatedCluster" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("TIER_UNAVAILABLE");
  });

  it("accepts a dedicatedCluster request when the external backend is registered", async function _tierAvailable()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(true));
    const res = await request(app).post("/api/v1/cluster-tenants").send({
      ..._sharedBody(),
      isolationTier: "dedicatedCluster",
      compute: { mode: "dedicated", nodePool: "acme-pool" },
    });

    expect(res.status).toBe(201);
    expect(res.body.isolationTier).toBe("dedicatedCluster");
    expect(res.body.compute.nodePool).toBe("acme-pool");
  });

  it("returns 400 when a dedicated compute mode omits a node pool", async function _missingPool()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(true));
    const res = await request(app).post("/api/v1/cluster-tenants").send({ ..._sharedBody(), compute: { mode: "dedicated" } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("persists and returns a valid vanityDomain, and rejects a malformed one", async function _vanityDomain()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));

    // 1. A valid customer-vanity domain round-trips on create.
    const okRes = await request(app).post("/api/v1/cluster-tenants").send({ ..._sharedBody(), vanityDomain: "ai.client-company.com" });
    expect(okRes.status).toBe(201);
    expect(okRes.body.vanityDomain).toBe("ai.client-company.com");

    // 2. A malformed domain is rejected before persistence.
    const badRes = await request(app).post("/api/v1/cluster-tenants").send({ ..._sharedBody(), name: "bad", vanityDomain: "not a domain" });
    expect(badRes.status).toBe(400);
    expect(badRes.body.code).toBe("VALIDATION_ERROR");

    // 3. Update can clear the vanity domain with an empty string (back to the derived apex only).
    const clrRes = await request(app).put("/api/v1/cluster-tenants/acme").send({ vanityDomain: "" });
    expect(clrRes.status).toBe(200);
    expect(clrRes.body.vanityDomain).toBeUndefined();
  });

  it("returns 404 for an unknown cluster tenant", async function _notFound()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));
    const res = await request(app).get("/api/v1/cluster-tenants/missing");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLUSTER_TENANT_NOT_FOUND");
  });
});
