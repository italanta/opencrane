import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import * as k8s from "@kubernetes/client-node";
import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import type { ClusterTenantProvisionerRegistry } from "@opencrane/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { clusterTenantsRouter } from "../../routes/cluster-tenants.js";
import type { ZitadelManagementClient } from "../../infra/zitadel/zitadel-client.types.js";

/** Test double: a Zitadel client that records provisions and returns deterministic ids. */
function _fakeZitadel(): ZitadelManagementClient
{
  return {
    async provisionOrg(input) { return { orgId: "zorg-test", appId: "zapp-test", clientId: "zclient-test", redirectUri: input.redirectUri }; },
    async teardownOrg() { /* no-op */ },
  };
}

/** In-memory cluster_tenants store backing the mock Prisma client. */
type Row = Record<string, unknown>;

/** Build a Prisma stub over in-memory maps keyed by name (cluster_tenants + tenants). */
function _mockPrisma(store: Map<string, Row>, tenants: Map<string, Row> = new Map()): PrismaClient
{
  const memberships: Row[] = [];
  const prisma = {
    clusterTenant: {
      findMany: vi.fn(async function _findMany() { return Array.from(store.values()); }),
      findUnique: vi.fn(async function _findUnique(args: { where: { name: string } }) { return store.get(args.where.name) ?? null; }),
      create: vi.fn(async function _create(args: { data: Row })
      {
        // Faithful to the DB unique constraint on `name`: a duplicate throws Prisma P2002,
        // which the route maps to 409 CONFLICT.
        if (store.has(args.data.name as string))
        {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`name`)", { code: "P2002", clientVersion: "test" });
        }
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
    tenant: {
      findUnique: vi.fn(async function _tFindUnique(args: { where: { name: string } }) { return tenants.get(args.where.name) ?? null; }),
      create: vi.fn(async function _tCreate(args: { data: Row })
      {
        if (tenants.has(args.data.name as string))
        {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`name`)", { code: "P2002", clientVersion: "test" });
        }
        tenants.set(args.data.name as string, args.data);
        return args.data;
      }),
    },
    auditEntry: {
      create: vi.fn(async function _aCreate(args: { data: Row }) { return args.data; }),
    },
    // The org-create billing gate requires the caller to already have a billing account.
    billingAccount: {
      findUnique: vi.fn(async function _baFindUnique() { return { id: "ba_test" }; }),
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

/**
 * Minimal CustomObjectsApi stub for the default-tenant seam: serves a cluster-scoped
 * ClusterTenant status (for the observed-phase read), the namespaced Tenant CRD lookup
 * (email recovery), and a create spy. `crdEmail` undefined → the Tenant CRD is absent (404).
 */
function _mockCustomApi(opts: { phase: string; crdEmail?: string }): { api: k8s.CustomObjectsApi; created: Row[] }
{
  const created: Row[] = [];
  const notFound = Object.assign(new Error("not found"), { code: 404 });
  const api = {
    getClusterCustomObject: vi.fn(async function _getCluster() { return { status: { phase: opts.phase, boundNamespace: "opencrane-acme" } }; }),
    getNamespacedCustomObject: vi.fn(async function _getNs()
    {
      if (opts.crdEmail === undefined) throw notFound;
      return { spec: { email: opts.crdEmail, clusterTenantRef: "acme" } };
    }),
    createNamespacedCustomObject: vi.fn(async function _createNs(args: { body: Row }) { created.push(args.body); return args.body; }),
    // ClusterTenant CR dual-write seam used by the create path (_ApplyClusterTenantCr).
    patchClusterCustomObject: vi.fn(async function _patchCluster(args: { body: Row }) { return args.body; }),
    createClusterCustomObject: vi.fn(async function _createCluster(args: { body: Row }) { return args.body; }),
  } as unknown as k8s.CustomObjectsApi;
  return { api, created };
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
function _buildApp(prisma: PrismaClient, registry: ClusterTenantProvisionerRegistry,
                   customApi: k8s.CustomObjectsApi | null = null, session?: { sub: string; email?: string },
                   zitadelClient?: ZitadelManagementClient): Express
{
  const app = express();
  app.use(express.json());
  // Inject an authenticated session when provided, so the create path can attribute the
  // org's owner + default tenant (mirrors what the auth middleware would set upstream).
  if (session)
  {
    app.use(function _injectSession(req: Request, _res: Response, next: NextFunction)
    {
      // Stamp a partial authUser; the route only reads `sub`/`email`, so the full session
      // shape is not needed for these unit tests.
      (req as unknown as { session: { authUser: unknown } }).session = { authUser: session };
      next();
    });
  }
  // The router hard-requires a Zitadel client; default to a benign fake so tests that
  // don't care about provisioning still construct it (the real client is built only on
  // the manager-enabled boot path).
  app.use("/api/v1/cluster-tenants", clusterTenantsRouter(prisma, registry, customApi, zitadelClient ?? _fakeZitadel()));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(function _err(err: Error, _req: Request, res: Response, _next: NextFunction)
  {
    // Surface the thrown error in test output instead of an opaque 500.
    // eslint-disable-next-line no-console
    console.error("TEST_ROUTE_ERROR:", err?.stack ?? err);
    res.status(500).json({ error: String(err?.message ?? err) });
  });
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

  it("returns 409 CONFLICT on a duplicate workspace name (Prisma P2002 → domain message)", async function _duplicateName()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));

    const first = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());
    expect(first.status).toBe(201);

    const dup = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CONFLICT");
    // The raw Prisma message must never leak to the client.
    expect(JSON.stringify(dup.body)).not.toMatch(/Unique constraint|P2002/);
  });

  it("returns 404 for an unknown cluster tenant", async function _notFound()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));
    const res = await request(app).get("/api/v1/cluster-tenants/missing");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLUSTER_TENANT_NOT_FOUND");
  });
});

describe("clusterTenantsRouter — owner default tenant (create-time seed + refresh)", function _seedSuite()
{
  it("seeds the owner's <org>-default tenant (CRD + DB row) as part of create", async function _seedOnCreate()
  {
    const tenants = new Map<string, Row>();
    const { api, created } = _mockCustomApi({ phase: "pending" }); // CRD absent → helper creates it
    const app = _buildApp(_mockPrisma(new Map(), tenants), _mockRegistry(false), api, { sub: "owner-sub", email: "owner@acme.com" });

    const res = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());
    expect(res.status).toBe(201);

    // DB projection row written for the owner's workspace (the bit the operator-only path missed).
    const row = tenants.get("acme-default");
    expect(row).toMatchObject({ name: "acme-default", email: "owner@acme.com", clusterTenantRef: "acme", displayName: "Acme Corp workspace", subject: "owner-sub" });
    // CRD dual-written too.
    expect(created.some((c) => (c.metadata as Row)?.name === "acme-default")).toBe(true);
  });

  it("does not fail org create when no owner email is available (dev-auth path)", async function _noEmail()
  {
    const tenants = new Map<string, Row>();
    const { api } = _mockCustomApi({ phase: "pending" });
    // Session carries only a subject (no email) and the CRD is absent → seed is skipped, org still created.
    const app = _buildApp(_mockPrisma(new Map(), tenants), _mockRegistry(false), api, { sub: "dev-sub" });

    const res = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());
    expect(res.status).toBe(201);
    expect(tenants.has("acme-default")).toBe(false);
  });

  it("refresh on a ready org with no tenant row seeds it, recovering the email from the CRD", async function _refreshSeeds()
  {
    const store = new Map<string, Row>([["acme", { name: "acme", displayName: "Acme Corp", isolationTier: "Shared", computeMode: "Shared", phase: "ready", nodePool: null, message: null, boundNamespace: "opencrane-acme", provisioner: "shared" }]]);
    const tenants = new Map<string, Row>(); // no tenant row yet — the broken state we are repairing
    const { api, created } = _mockCustomApi({ phase: "ready", crdEmail: "owner@acme.com" }); // CRD already exists

    const app = _buildApp(_mockPrisma(store, tenants), _mockRegistry(false), api);
    const res = await request(app).post("/api/v1/cluster-tenants/acme/refresh");

    expect(res.status).toBe(200);
    expect(res.body.status.phase).toBe("ready");
    expect(res.body.defaultTenant).toMatchObject({ tenantName: "acme-default", created: true });
    // DB row created from the existing CRD's email; the CRD is NOT recreated (AlreadyExists path).
    expect(tenants.get("acme-default")).toMatchObject({ name: "acme-default", email: "owner@acme.com", clusterTenantRef: "acme" });
    expect(created.length).toBe(0);
  });

  it("refresh is idempotent: a ready org that already has its tenant creates nothing", async function _refreshIdempotent()
  {
    const store = new Map<string, Row>([["acme", { name: "acme", displayName: "Acme Corp", isolationTier: "Shared", computeMode: "Shared", phase: "ready", nodePool: null, message: null, boundNamespace: "opencrane-acme", provisioner: "shared" }]]);
    const tenants = new Map<string, Row>([["acme-default", { name: "acme-default", email: "owner@acme.com", clusterTenantRef: "acme" }]]);
    const { api } = _mockCustomApi({ phase: "ready", crdEmail: "owner@acme.com" });

    const app = _buildApp(_mockPrisma(store, tenants), _mockRegistry(false), api);
    const res = await request(app).post("/api/v1/cluster-tenants/acme/refresh");

    expect(res.status).toBe(200);
    expect(res.body.defaultTenant).toMatchObject({ tenantName: "acme-default", created: false });
  });

  it("refresh does not seed a tenant while the org is not yet ready", async function _refreshNotReady()
  {
    const store = new Map<string, Row>([["acme", { name: "acme", displayName: "Acme Corp", isolationTier: "Shared", computeMode: "Shared", phase: "pending", nodePool: null, message: null, boundNamespace: null, provisioner: null }]]);
    const tenants = new Map<string, Row>();
    const { api } = _mockCustomApi({ phase: "provisioning", crdEmail: "owner@acme.com" });

    const app = _buildApp(_mockPrisma(store, tenants), _mockRegistry(false), api);
    const res = await request(app).post("/api/v1/cluster-tenants/acme/refresh");

    expect(res.status).toBe(200);
    expect(res.body.defaultTenant).toBeNull();
    expect(tenants.has("acme-default")).toBe(false);
  });

  it("returns 404 when refreshing an unknown org", async function _refreshNotFound()
  {
    const app = _buildApp(_mockPrisma(new Map()), _mockRegistry(false));
    const res = await request(app).post("/api/v1/cluster-tenants/missing/refresh");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLUSTER_TENANT_NOT_FOUND");
  });
});

describe("clusterTenantsRouter — Zitadel org provisioning (S3 / Phase 2a)", function _zitadelSuite()
{
  /** A live-ish fake that records the provision call and returns deterministic ids. */
  function _fakeProvisioner(): { client: ZitadelManagementClient; calls: unknown[] }
  {
    const calls: unknown[] = [];
    const client: ZitadelManagementClient = {
      async provisionOrg(input)
      {
        calls.push(input);
        return { orgId: "zorg-123", appId: "zapp-456", clientId: "zclient-789", redirectUri: input.redirectUri };
      },
      async teardownOrg() { /* no-op */ },
    };
    return { client, calls };
  }

  it("persists the Zitadel org/app ids on the ClusterTenant when provisioning succeeds", async function _persists()
  {
    const store = new Map<string, Record<string, unknown>>();
    const { client, calls } = _fakeProvisioner();
    const app = _buildApp(_mockPrisma(store), _mockRegistry(false), null, { sub: "owner-1", email: "owner@acme.test" }, client);

    const res = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    // The master subject + derived redirect URI are passed to the provisioner.
    expect(calls[0]).toMatchObject({ orgName: "acme", masterSubject: "owner-1" });
    // The returned ids are persisted on the org row (same transaction).
    const row = store.get("acme");
    expect(row?.zitadelOrgId).toBe("zorg-123");
    expect(row?.zitadelAppId).toBe("zapp-456");
    // S3b: the OIDC client_id is persisted so login can resolve the per-org client by host.
    expect(row?.zitadelClientId).toBe("zclient-789");
  });

  it("fails the create (no 201) when Zitadel provisioning throws — the tx is the rollback boundary", async function _rollsBack()
  {
    const store = new Map<string, Record<string, unknown>>();
    const throwing: ZitadelManagementClient = {
      async provisionOrg() { throw new Error("zitadel rejected: org name taken"); },
      async teardownOrg() { /* no-op */ },
    };
    const app = _buildApp(_mockPrisma(store), _mockRegistry(false), null, { sub: "owner-1", email: "owner@acme.test" }, throwing);

    const res = await request(app).post("/api/v1/cluster-tenants").send(_sharedBody());

    // The provisioning call is the last fallible step inside prisma.$transaction, so a
    // throw propagates out as a failed create (real Prisma rolls the org+membership back;
    // the inline test stub has no rollback, so we assert the handler surfaces the failure
    // rather than committing and returning 201).
    expect(res.status).not.toBe(201);
  });

});
