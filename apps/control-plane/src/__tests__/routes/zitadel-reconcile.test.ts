import express from "express";
import type { Express } from "express";
import { type PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { zitadelReconcileRouter } from "../../routes/admin/zitadel-reconcile.js";
import type { ZitadelManagementClient } from "../../infra/zitadel/zitadel-client.types.js";

/**
 * Matrix for the idempotent Zitadel reconcile/backfill (S3d). The invariants under test:
 *   - an incomplete CT (null ids) is re-provisioned and its ids persisted (transactionally);
 *   - a fully-provisioned CT is skipped with NO Zitadel call (idempotency);
 *   - a CT with no Owner membership is skipped:no-owner;
 *   - a provisionOrg throw for one CT is collected as `failed` while others still reconcile;
 *   - the route is platform-operator gated (403 for a non-operator).
 */

/** An in-memory cluster_tenants row. */
type Row = Record<string, unknown>;

/** A spyable Zitadel client double; `provisionThrowsFor` forces a per-org failure by name. */
function _fakeZitadel(opts: { provisionThrowsFor?: Set<string> } = {}): {
  client: ZitadelManagementClient;
  provisionOrg: ReturnType<typeof vi.fn>;
}
{
  const provisionOrg = vi.fn(async function _provision(input: { orgName: string; redirectUri: string })
  {
    if (opts.provisionThrowsFor?.has(input.orgName)) { throw new Error(`zitadel boom for ${input.orgName}`); }
    return { orgId: `zorg-${input.orgName}`, projectId: `zproj-${input.orgName}`, appId: `zapp-${input.orgName}`, clientId: `zclient-${input.orgName}`, redirectUri: input.redirectUri };
  });
  const client = {
    provisionOrg,
    async setAppRedirectUris() { /* unused */ },
    async teardownOrg() { /* unused */ },
    async validateCandidateKey() { return { tokenExchangeOk: true, instanceScopeOk: true, keyId: "k", detail: "ok" }; },
    currentKeyId() { return "k"; },
    reloadKey() { /* unused */ },
  } as unknown as ZitadelManagementClient;
  return { client, provisionOrg };
}

/**
 * Build a Prisma stub over in-memory maps. `owners` maps a CT name → the Owner subject (absent
 * → no Owner membership). The `update` mutates the backing row so the persisted ids are visible.
 */
function _mockPrisma(store: Map<string, Row>, owners: Map<string, string>): { prisma: PrismaClient; update: ReturnType<typeof vi.fn>; tx: ReturnType<typeof vi.fn> }
{
  const update = vi.fn(async function _update(args: { where: { name: string }; data: Row })
  {
    const row = { ...(store.get(args.where.name) as Row), ...args.data };
    store.set(args.where.name, row);
    return row;
  });
  const tx = vi.fn(async function _tx(fn: (t: PrismaClient) => Promise<unknown>) { return fn(prisma); });
  const prisma = {
    clusterTenant: {
      findMany: vi.fn(async function _findMany() { return Array.from(store.values()); }),
      findUnique: vi.fn(async function _findUnique(args: { where: { name: string } }) { return store.get(args.where.name) ?? null; }),
      update,
    },
    orgMembership: {
      findFirst: vi.fn(async function _findFirst(args: { where: { clusterTenant: string; role: string } })
      {
        const subject = owners.get(args.where.clusterTenant);
        return subject ? { clusterTenant: args.where.clusterTenant, subject, role: "Owner" } : null;
      }),
    },
    $transaction: tx,
  } as unknown as PrismaClient;
  return { prisma, update, tx };
}

/** A complete (already-provisioned) CT row. */
function _complete(name: string): Row
{
  return { name, displayName: name, vanityDomain: null, zitadelOrgId: "o", zitadelClientId: "c", zitadelAppId: "a", zitadelProjectId: "p", zitadelRedirectUri: "r", createdAt: new Date() };
}

/** An incomplete CT row (all Zitadel ids null). */
function _incomplete(name: string, vanityDomain: string | null = null): Row
{
  return { name, displayName: name, vanityDomain, zitadelOrgId: null, zitadelClientId: null, zitadelAppId: null, zitadelProjectId: null, zitadelRedirectUri: null, createdAt: new Date() };
}

/** Session user shape (subset of the OIDC session user). */
interface User { sub: string; isPlatformOperator: boolean }

/** Mount the router, optionally seeding a session user. */
function _buildApp(prisma: PrismaClient, client: ZitadelManagementClient, user?: User): Express
{
  const app = express();
  app.use(express.json());
  if (user)
  {
    app.use(function _seedSession(req, _res, next) { (req as unknown as { session: { authUser: User } }).session = { authUser: user }; next(); });
  }
  app.use("/api/v1/admin/zitadel", zitadelReconcileRouter(prisma, client));
  return app;
}

/** The platform-operator session used by the happy-path tests. */
const _OP: User = { sub: "op", isPlatformOperator: true };

describe("zitadelReconcileRouter — POST /reconcile (idempotent backfill)", function _suite()
{
  // Force REAL-auth mode so the platform-operator gate fail-closes for non-operators.
  const _AUTH_ENV = ["OPENCRANE_API_TOKEN", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET"] as const;
  const _saved: Record<string, string | undefined> = {};

  beforeEach(function _enableAuth()
  {
    for (const key of _AUTH_ENV) { _saved[key] = process.env[key]; delete process.env[key]; }
    process.env.OPENCRANE_API_TOKEN = "ci-token";
    process.env.PLATFORM_BASE_DOMAIN = "example.com";
  });

  afterEach(function _restoreEnv()
  {
    for (const key of _AUTH_ENV) { if (_saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = _saved[key]; } }
    delete process.env.PLATFORM_BASE_DOMAIN;
  });

  it("re-provisions an incomplete CT and persists the ids inside the transaction", async function _reconciles()
  {
    const store = new Map<string, Row>([["acme", _incomplete("acme")]]);
    const { prisma, update, tx } = _mockPrisma(store, new Map([["acme", "subj-owner"]]));
    const { client, provisionOrg } = _fakeZitadel();

    const res = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reconciled: ["acme"], skipped: [], failed: [] });
    // provisionOrg ran with the Owner as the master subject + the derived redirect URI.
    expect(provisionOrg).toHaveBeenCalledOnce();
    expect(provisionOrg.mock.calls[0][0]).toMatchObject({ orgName: "acme", masterSubject: "subj-owner" });
    // The persist ran inside a $transaction and stamped the returned ids.
    expect(tx).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(store.get("acme")).toMatchObject({ zitadelOrgId: "zorg-acme", zitadelClientId: "zclient-acme", zitadelAppId: "zapp-acme", zitadelProjectId: "zproj-acme" });
  });

  it("skips a fully-provisioned CT with NO Zitadel call (idempotency)", async function _idempotent()
  {
    const store = new Map<string, Row>([["acme", _complete("acme")]]);
    const { prisma } = _mockPrisma(store, new Map([["acme", "subj-owner"]]));
    const { client, provisionOrg } = _fakeZitadel();

    const res = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reconciled: [], skipped: [{ name: "acme", reason: "already-provisioned" }], failed: [] });
    expect(provisionOrg).not.toHaveBeenCalled();
  });

  it("skips an incomplete CT with no Owner membership as skipped:no-owner (no call)", async function _noOwner()
  {
    const store = new Map<string, Row>([["acme", _incomplete("acme")]]);
    const { prisma } = _mockPrisma(store, new Map()); // no Owner registered
    const { client, provisionOrg } = _fakeZitadel();

    const res = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reconciled: [], skipped: [{ name: "acme", reason: "no-owner" }], failed: [] });
    expect(provisionOrg).not.toHaveBeenCalled();
  });

  it("collects a per-CT provision failure as `failed` and still reconciles the others", async function _failureIsolation()
  {
    const store = new Map<string, Row>([
      ["bad", _incomplete("bad")],
      ["good", _incomplete("good")],
    ]);
    const { prisma } = _mockPrisma(store, new Map([["bad", "s1"], ["good", "s2"]]));
    const { client, provisionOrg } = _fakeZitadel({ provisionThrowsFor: new Set(["bad"]) });

    const res = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({});

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toEqual(["good"]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0]).toMatchObject({ name: "bad" });
    expect(res.body.failed[0].error).toContain("zitadel boom");
    // Both orgs were attempted — the failure did not abort the run.
    expect(provisionOrg).toHaveBeenCalledTimes(2);
    expect(store.get("good")).toMatchObject({ zitadelOrgId: "zorg-good" });
  });

  it("reconciles a single CT when a { name } body is given (404 when absent)", async function _singleScope()
  {
    const store = new Map<string, Row>([["acme", _incomplete("acme")], ["other", _incomplete("other")]]);
    const { prisma } = _mockPrisma(store, new Map([["acme", "s1"], ["other", "s2"]]));
    const { client, provisionOrg } = _fakeZitadel();

    const ok = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({ name: "acme" });
    expect(ok.status).toBe(200);
    expect(ok.body.reconciled).toEqual(["acme"]);
    expect(provisionOrg).toHaveBeenCalledOnce(); // only the named org

    const missing = await request(_buildApp(prisma, client, _OP)).post("/api/v1/admin/zitadel/reconcile").send({ name: "ghost" });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("CLUSTER_TENANT_NOT_FOUND");
  });

  it("returns 403 for a non-operator (platform-operator gate, fail-closed)", async function _nonOperator()
  {
    const store = new Map<string, Row>([["acme", _incomplete("acme")]]);
    const { prisma } = _mockPrisma(store, new Map([["acme", "s1"]]));
    const { client, provisionOrg } = _fakeZitadel();

    const res = await request(_buildApp(prisma, client, { sub: "user-1", isPlatformOperator: false }))
      .post("/api/v1/admin/zitadel/reconcile").send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_NOT_PLATFORM_OPERATOR");
    expect(provisionOrg).not.toHaveBeenCalled();
  });
});
