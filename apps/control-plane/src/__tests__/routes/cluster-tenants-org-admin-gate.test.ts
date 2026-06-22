import express from "express";
import type { Express } from "express";
import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import type { ClusterTenantProvisionerRegistry } from "@opencrane/contracts";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clusterTenantsRouter } from "../../routes/cluster-tenants.js";

/**
 * Security-critical guard matrix for the org-admin model (ORG-ADMIN.3/4):
 *   - CREATE requires an authenticated session WITH a billing account (NOT pre-existing
 *     org-admin); anonymous/billing-less is rejected; the creator is recorded as owner.
 *   - Destructive mutations + fleet list/get require platform-operator OR the caller's
 *     owner/admin membership of that org; a non-member is rejected; an operator manages any.
 */

type Row = Record<string, unknown>;

/** Seed shape for the in-memory fixtures. */
interface Seed
{
  orgs?: string[];
  billing?: string[];                                   // subjects WITH a billing account
  memberships?: { clusterTenant: string; subject: string; role: "Owner" | "Admin" | "Member" }[];
}

/** Build a Prisma stub backed by in-memory arrays for the org-admin tables. */
function _mockPrisma(seed: Seed = {}): { prisma: PrismaClient; orgs: Map<string, Row>; memberships: Row[] }
{
  const orgs = new Map<string, Row>((seed.orgs ?? []).map(n => [n, { name: n, displayName: n, phase: "pending" }]));
  const billing = new Set(seed.billing ?? []);
  const memberships: Row[] = (seed.memberships ?? []).map(m => ({ ...m }));

  const prisma = {
    clusterTenant: {
      findMany: vi.fn(async function _findMany() { return Array.from(orgs.values()); }),
      findUnique: vi.fn(async function _findUnique(args: { where: { name: string } }) { return orgs.get(args.where.name) ?? null; }),
      create: vi.fn(async function _create(args: { data: Row })
      {
        const row = { nodePool: null, message: null, boundNamespace: null, provisioner: null, ...args.data };
        orgs.set(args.data.name as string, row);
        return row;
      }),
      update: vi.fn(async function _update(args: { where: { name: string }; data: Row }) { const row = { ...(orgs.get(args.where.name) as Row), ...args.data }; orgs.set(args.where.name, row); return row; }),
      delete: vi.fn(async function _delete(args: { where: { name: string } }) { orgs.delete(args.where.name); return {}; }),
    },
    billingAccount: {
      findUnique: vi.fn(async function _findUnique(args: { where: { subject: string } }) { return billing.has(args.where.subject) ? { id: `ba_${args.where.subject}` } : null; }),
    },
    orgMembership: {
      findUnique: vi.fn(async function _findUnique(args: { where: { clusterTenant_subject: { clusterTenant: string; subject: string } } })
      {
        const { clusterTenant, subject } = args.where.clusterTenant_subject;
        return memberships.find(m => m.clusterTenant === clusterTenant && m.subject === subject) ?? null;
      }),
      create: vi.fn(async function _create(args: { data: Row }) { memberships.push(args.data); return args.data; }),
    },
    $transaction: vi.fn(async function _tx(fn: (tx: PrismaClient) => Promise<unknown>) { return fn(prisma); }),
  } as unknown as PrismaClient;

  return { prisma, orgs, memberships };
}

/** Registry stub: every tier available (tier-gating is covered elsewhere). */
function _mockRegistry(): ClusterTenantProvisionerRegistry
{
  return { isTierAvailable(_tier: ClusterTenantIsolationTier) { return true; }, capabilities() { return []; } } as unknown as ClusterTenantProvisionerRegistry;
}

/** Session user shape (subset of the OIDC session user). */
interface User { sub: string; isPlatformOperator: boolean; email?: string }

/** Mount the router, optionally seeding a session user. */
function _buildApp(prisma: PrismaClient, user?: User): Express
{
  const app = express();
  app.use(express.json());
  if (user)
  {
    app.use(function _seedSession(req, _res, next) { (req as unknown as { session: { authUser: User } }).session = { authUser: user }; next(); });
  }
  app.use("/api/v1/cluster-tenants", clusterTenantsRouter(prisma, _mockRegistry()));
  return app;
}

/** A valid shared-tier create body. */
function _body(name = "acme"): Row
{
  return { name, displayName: "Acme Corp", isolationTier: "shared", compute: { mode: "shared" }, resources: { quota: { cpu: "4", memory: "8Gi" } } };
}

describe("clusterTenantsRouter — org-admin guard matrix (ORG-ADMIN.3/4)", function _suite()
{
  const _AUTH_ENV = ["OPENCRANE_API_TOKEN", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET"] as const;
  const _saved: Record<string, string | undefined> = {};

  /** Force REAL-auth mode so every case exercises the fail-closed posture. */
  beforeEach(function _enableAuth()
  {
    for (const key of _AUTH_ENV) { _saved[key] = process.env[key]; delete process.env[key]; }
    process.env.OPENCRANE_API_TOKEN = "ci-token";
  });

  afterEach(function _restoreEnv()
  {
    for (const key of _AUTH_ENV) { if (_saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = _saved[key]; } }
  });

  // --- CREATE gate ---------------------------------------------------------

  it("rejects an anonymous create with 401 (fail-closed, never reaches the DB)", async function _anonCreate()
  {
    const { prisma, orgs } = _mockPrisma();
    const res = await request(_buildApp(prisma)).post("/api/v1/cluster-tenants").send(_body());

    expect(res.status).toBe(401);
    expect(orgs.size).toBe(0);
  });

  it("rejects a create from a user with NO billing account (403 BILLING_ACCOUNT_REQUIRED)", async function _noBilling()
  {
    const { prisma, orgs } = _mockPrisma({ billing: [] });
    const res = await request(_buildApp(prisma, { sub: "user-1", isPlatformOperator: false })).post("/api/v1/cluster-tenants").send(_body());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BILLING_ACCOUNT_REQUIRED");
    expect(orgs.size).toBe(0);
  });

  it("allows the platform operator (superadmin) to create WITHOUT a billing account", async function _operatorNoBilling()
  {
    const { prisma, orgs } = _mockPrisma({ billing: [] });
    const res = await request(_buildApp(prisma, { sub: "op", isPlatformOperator: true })).post("/api/v1/cluster-tenants").send(_body());

    expect(res.status).toBe(201);
    expect(orgs.has("acme")).toBe(true);
    // The billing lookup must be bypassed entirely for the operator.
    expect(prisma.billingAccount.findUnique).not.toHaveBeenCalled();
  });

  it("allows a create from a billing-account holder and records the caller as owner", async function _createRecordsOwner()
  {
    const { prisma, orgs, memberships } = _mockPrisma({ billing: ["user-1"] });
    const res = await request(_buildApp(prisma, { sub: "user-1", isPlatformOperator: false })).post("/api/v1/cluster-tenants").send(_body());

    expect(res.status).toBe(201);
    expect(orgs.has("acme")).toBe(true);
    // The creator is written as the org's single owner, in the same transaction.
    expect(memberships).toContainEqual(expect.objectContaining({ clusterTenant: "acme", subject: "user-1", role: "Owner" }));
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  // --- MANAGE gate (PUT/DELETE/:name + list/get) ---------------------------

  it("lets an owner manage (PUT/DELETE) their own org", async function _ownerManages()
  {
    const { prisma } = _mockPrisma({ orgs: ["acme"], memberships: [{ clusterTenant: "acme", subject: "user-1", role: "Owner" }] });
    const app = _buildApp(prisma, { sub: "user-1", isPlatformOperator: false });

    const put = await request(app).put("/api/v1/cluster-tenants/acme").send({ displayName: "Acme Inc" });
    expect(put.status).toBe(200);
    const del = await request(app).delete("/api/v1/cluster-tenants/acme");
    expect(del.status).toBe(200);
  });

  it("lets an admin member read their own org via GET /:name", async function _adminReads()
  {
    const { prisma } = _mockPrisma({ orgs: ["acme"], memberships: [{ clusterTenant: "acme", subject: "user-2", role: "Admin" }] });
    const res = await request(_buildApp(prisma, { sub: "user-2", isPlatformOperator: false })).get("/api/v1/cluster-tenants/acme");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("acme");
  });

  it("denies a non-member managing or reading someone else's org (403)", async function _nonMember()
  {
    const { prisma, orgs } = _mockPrisma({ orgs: ["acme"], memberships: [{ clusterTenant: "acme", subject: "owner", role: "Owner" }] });
    const app = _buildApp(prisma, { sub: "stranger", isPlatformOperator: false });

    const get = await request(app).get("/api/v1/cluster-tenants/acme");
    expect(get.status).toBe(403);
    expect(get.body.code).toBe("FORBIDDEN_ORG_SCOPE");

    const del = await request(app).delete("/api/v1/cluster-tenants/acme");
    expect(del.status).toBe(403);
    // The org must still exist — the denied delete never reached the handler.
    expect(orgs.has("acme")).toBe(true);
  });

  it("denies a plain member (role=member) managing the org — member confers no admin authority", async function _memberDenied()
  {
    const { prisma } = _mockPrisma({ orgs: ["acme"], memberships: [{ clusterTenant: "acme", subject: "user-3", role: "Member" }] });
    const res = await request(_buildApp(prisma, { sub: "user-3", isPlatformOperator: false })).put("/api/v1/cluster-tenants/acme").send({ displayName: "x" });

    expect(res.status).toBe(403);
  });

  it("lets a platform operator manage ANY org and list the fleet", async function _operatorAny()
  {
    const { prisma } = _mockPrisma({ orgs: ["acme", "globex"] });
    const app = _buildApp(prisma, { sub: "op", isPlatformOperator: true });

    const list = await request(app).get("/api/v1/cluster-tenants");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const del = await request(app).delete("/api/v1/cluster-tenants/globex");
    expect(del.status).toBe(200);
  });

  it("denies a per-org owner the fleet list — collection routes are operator-only", async function _ownerNoFleet()
  {
    const { prisma } = _mockPrisma({ orgs: ["acme"], memberships: [{ clusterTenant: "acme", subject: "user-1", role: "Owner" }] });
    const res = await request(_buildApp(prisma, { sub: "user-1", isPlatformOperator: false })).get("/api/v1/cluster-tenants");

    expect(res.status).toBe(403);
  });
});
