import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { routingEvalCasesRouter } from "../../routes/routing-eval-cases.js";

/** In-memory eval-case row. */
type Row = Record<string, unknown>;

/** A session-bearing user used to exercise the ClusterTenant scope guard. */
interface SessionUser
{
  /** Verified email used by the guard's fail-closed tenant lookup. */
  email: string;
  /** Whether the caller is a platform operator. */
  isPlatformOperator: boolean;
}

/** Build a Prisma stub over an in-memory map keyed by row id. */
function _mockPrisma(store: Map<string, Row>, tenantClusterTenant: string | null = null): PrismaClient
{
  let seq = 0;
  return {
    tenant: { findMany: async function _fm() { return tenantClusterTenant ? [{ clusterTenantRef: tenantClusterTenant }] : []; } },
    routingEvalCase: {
      findMany: async function _list(args?: { where?: Record<string, unknown> })
      {
        const where = args?.where ?? {};
        return Array.from(store.values()).filter(function _match(r)
        {
          return Object.entries(where).every(function _eq([k, v]) { return r[k] === v; });
        });
      },
      findUnique: async function _fu(args: { where: { id: string }; select?: Record<string, boolean> })
      {
        return store.get(args.where.id) ?? null;
      },
      create: async function _create(args: { data: Row })
      {
        const now = new Date("2026-06-18T00:00:00.000Z");
        const row: Row = { id: `ec-${++seq}`, createdAt: now, updatedAt: now, qualityBar: 0.8, ...args.data };
        store.set(row.id as string, row);
        return row;
      },
      update: async function _update(args: { where: { id: string }; data: Row })
      {
        const row = { ...store.get(args.where.id), ...args.data, updatedAt: new Date("2026-06-18T00:00:00.000Z") };
        store.set(args.where.id, row);
        return row;
      },
      delete: async function _delete(args: { where: { id: string } }) { store.delete(args.where.id); return {}; },
    },
  } as unknown as PrismaClient;
}

/** Build a minimal app mounting the router, optionally seeding a session user. */
function _buildApp(prisma: PrismaClient, user?: SessionUser): Express
{
  const app = express();
  app.use(express.json());
  if (user)
  {
    app.use(function _seed(req, _res, next) { (req as unknown as { session: { authUser: SessionUser } }).session = { authUser: user }; next(); });
  }
  app.use("/api/v1/model-routing/eval-cases", routingEvalCasesRouter(prisma));
  return app;
}

describe("routingEvalCasesRouter", function _suite()
{
  it("creates, gets, lists, updates and deletes an eval case", async function _crud()
  {
    const store = new Map<string, Row>();
    const app = _buildApp(_mockPrisma(store));

    const create = await request(app).post("/api/v1/model-routing/eval-cases").send({ skillName: "summarise", skillScope: "org", input: { q: "x" }, qualityBar: 0.9 });
    expect(create.status).toBe(201);
    expect(create.body.qualityBar).toBe(0.9);
    const id = create.body.id;

    const get = await request(app).get(`/api/v1/model-routing/eval-cases/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.skillName).toBe("summarise");

    const list = await request(app).get("/api/v1/model-routing/eval-cases?skillName=summarise");
    expect(list.body).toHaveLength(1);

    const update = await request(app).put(`/api/v1/model-routing/eval-cases/${id}`).send({ skillName: "summarise", skillScope: "org", input: { q: "y" }, qualityBar: 0.7 });
    expect(update.status).toBe(200);
    expect(update.body.qualityBar).toBe(0.7);

    const del = await request(app).delete(`/api/v1/model-routing/eval-cases/${id}`);
    expect(del.status).toBe(200);
    expect(store.size).toBe(0);
  });

  it("rejects a create missing skillName (400)", async function _missingName()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/model-routing/eval-cases").send({ skillScope: "org", input: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a qualityBar outside [0,1] (400)", async function _badBar()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/model-routing/eval-cases").send({ skillName: "s", skillScope: "org", input: {}, qualityBar: 2 });
    expect(res.status).toBe(400);
  });

  it("404s on an unknown id", async function _get404()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).get("/api/v1/model-routing/eval-cases/nope");
    expect(res.status).toBe(404);
  });

  it("scope guard: a non-operator may NOT create an org/global eval case (403)", async function _guardGlobal()
  {
    const app = _buildApp(_mockPrisma(new Map()), { email: "u@acme.test", isPlatformOperator: false });
    const res = await request(app).post("/api/v1/model-routing/eval-cases").send({ skillName: "s", skillScope: "org", input: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_SCOPE");
  });

  it("scope guard: a non-operator may create an eval case for their OWN ClusterTenant team", async function _guardOwn()
  {
    const store = new Map<string, Row>();
    const app = _buildApp(_mockPrisma(store, "acme"), { email: "u@acme.test", isPlatformOperator: false });
    const res = await request(app).post("/api/v1/model-routing/eval-cases").send({ skillName: "s", skillScope: "team", skillTeam: "acme", input: {} });
    expect(res.status).toBe(201);
  });
});
