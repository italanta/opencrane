import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { modelRoutingRecommendationsRouter } from "../../routes/model-routing-recommendations.js";

/** A generic in-memory row. */
type Row = Record<string, unknown>;

/** A session-bearing user used to exercise the read-time scope filter. */
interface SessionUser
{
  /** Verified email used by the fail-closed tenant lookup. */
  email: string;
  /** Whether the caller is a platform operator (sees all). */
  isPlatformOperator: boolean;
}

/** Seeds for the mock store: measurements, open proposals, skills, and the caller's tenant ref. */
interface Seeds
{
  /** RoutingMeasurement rows. */
  measurements: Row[];
  /** RoutingProposal rows (any status; the router filters to Pending). */
  proposals?: Row[];
  /** Skill rows for the pinnedModel fallback. */
  skills?: Row[];
  /** The clusterTenantRef the caller's email resolves to (null = unresolved). */
  tenantClusterTenant?: string | null;
}

/** Build a Prisma stub over fixed seed arrays. */
function _mockPrisma(seeds: Seeds): PrismaClient
{
  return {
    tenant: {
      findMany: async function _findMany()
      {
        return seeds.tenantClusterTenant ? [{ clusterTenantRef: seeds.tenantClusterTenant }] : [];
      },
    },
    routingMeasurement: {
      findMany: async function _list(args?: { where?: Record<string, unknown> })
      {
        const where = args?.where ?? {};
        return seeds.measurements.filter(function _m(r) { return Object.entries(where).every(function _eq([k, v]) { return r[k] === v; }); });
      },
    },
    routingProposal: {
      findMany: async function _list(args?: { where?: { status?: string } })
      {
        const status = args?.where?.status;
        return (seeds.proposals ?? []).filter(function _p(r) { return status ? r.status === status : true; });
      },
    },
    skill: {
      findMany: async function _list() { return seeds.skills ?? []; },
    },
  } as unknown as PrismaClient;
}

/** Build a minimal app mounting the recommendations router, optionally seeding a session user. */
function _buildApp(prisma: PrismaClient, user?: SessionUser): Express
{
  const app = express();
  app.use(express.json());
  if (user)
  {
    app.use(function _seedSession(req, _res, next) { (req as unknown as { session: { authUser: SessionUser } }).session = { authUser: user }; next(); });
  }
  app.use("/api/v1/model-routing/recommendations", modelRoutingRecommendationsRouter(prisma));
  return app;
}

/** Build a measurement row. */
function _measurement(over: Partial<Row>): Row
{
  return { id: "m", skillName: "s", skillScope: "org", skillTeam: "", candidateModel: "cheap", sampledCalls: 3, atBarCheapFraction: 1, projectedSavingsPct: 30, ciLowPct: 10, ciHighPct: 50, overheadPct: 0, runAt: new Date("2026-06-18T00:00:00.000Z"), ...over };
}

describe("modelRoutingRecommendationsRouter", function _suite()
{
  it("takes the latest measurement per skill and joins an open Pending proposal", async function _latestAndJoin()
  {
    const seeds: Seeds = {
      measurements: [
        _measurement({ id: "old", skillName: "summarise", candidateModel: "old-cheap", projectedSavingsPct: 5, runAt: new Date("2026-06-01T00:00:00.000Z") }),
        _measurement({ id: "new", skillName: "summarise", candidateModel: "new-cheap", projectedSavingsPct: 42, runAt: new Date("2026-06-17T00:00:00.000Z") }),
      ],
      proposals: [{ id: "p1", skillName: "summarise", skillScope: "org", skillTeam: "", fromModel: "expensive", proposedModel: "new-cheap", status: "Pending" }],
      skills: [{ name: "summarise", scope: "org", team: "", pinnedModel: "expensive" }],
    };
    const res = await request(_buildApp(_mockPrisma(seeds))).get("/api/v1/model-routing/recommendations");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].measurementId).toBe("new");
    expect(res.body[0].hasOpenProposal).toBe(true);
    expect(res.body[0].proposalId).toBe("p1");
    expect(res.body[0].currentModel).toBe("expensive");
    expect(res.body[0].recommendedModel).toBe("new-cheap");
  });

  it("falls back to the skill pin + measurement candidate when there is no proposal", async function _noProposal()
  {
    const seeds: Seeds = {
      measurements: [_measurement({ id: "m1", skillName: "translate", candidateModel: "cand" })],
      skills: [{ name: "translate", scope: "org", team: "", pinnedModel: "pinned" }],
    };
    const res = await request(_buildApp(_mockPrisma(seeds))).get("/api/v1/model-routing/recommendations");

    expect(res.body[0].hasOpenProposal).toBe(false);
    expect(res.body[0].proposalId).toBe(null);
    expect(res.body[0].currentModel).toBe("pinned");
    expect(res.body[0].recommendedModel).toBe("cand");
  });

  it("sorts recommendations by projected savings desc", async function _sort()
  {
    const seeds: Seeds = {
      measurements: [
        _measurement({ id: "lo", skillName: "a", projectedSavingsPct: 10 }),
        _measurement({ id: "hi", skillName: "b", projectedSavingsPct: 80 }),
        _measurement({ id: "mid", skillName: "c", projectedSavingsPct: 40 }),
      ],
    };
    const res = await request(_buildApp(_mockPrisma(seeds))).get("/api/v1/model-routing/recommendations");

    expect(res.body.map(function _s(r: { measurementId: string }) { return r.measurementId; })).toEqual(["hi", "mid", "lo"]);
  });

  it("onlyOpen=true returns only skills with an open Pending proposal", async function _onlyOpen()
  {
    const seeds: Seeds = {
      measurements: [
        _measurement({ id: "withProp", skillName: "a" }),
        _measurement({ id: "noProp", skillName: "b" }),
      ],
      proposals: [{ id: "p", skillName: "a", skillScope: "org", skillTeam: "", fromModel: null, proposedModel: "x", status: "Pending" }],
    };
    const res = await request(_buildApp(_mockPrisma(seeds))).get("/api/v1/model-routing/recommendations?onlyOpen=true");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].measurementId).toBe("withProp");
  });

  it("scope filter: a non-operator sees only skills owned by their OWN ClusterTenant", async function _scopeFilter()
  {
    const seeds: Seeds = {
      measurements: [
        _measurement({ id: "mine", skillName: "a", skillTeam: "acme" }),
        _measurement({ id: "theirs", skillName: "b", skillTeam: "other" }),
        _measurement({ id: "global", skillName: "c", skillTeam: "" }),
      ],
      tenantClusterTenant: "acme",
    };
    const app = _buildApp(_mockPrisma(seeds), { email: "user@acme.test", isPlatformOperator: false });
    const res = await request(app).get("/api/v1/model-routing/recommendations");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].measurementId).toBe("mine");
  });

  it("scope filter: an operator sees every skill", async function _operatorSeesAll()
  {
    const seeds: Seeds = {
      measurements: [_measurement({ id: "a", skillName: "a", skillTeam: "acme" }), _measurement({ id: "b", skillName: "b", skillTeam: "other" })],
      tenantClusterTenant: "acme",
    };
    const app = _buildApp(_mockPrisma(seeds), { email: "op@platform.test", isPlatformOperator: true });
    const res = await request(app).get("/api/v1/model-routing/recommendations");

    expect(res.body).toHaveLength(2);
  });

  it("scope filter: a non-operator with no resolved ClusterTenant sees nothing (fail-closed)", async function _failClosed()
  {
    const seeds: Seeds = {
      measurements: [_measurement({ id: "a", skillName: "a", skillTeam: "acme" })],
      tenantClusterTenant: null,
    };
    const app = _buildApp(_mockPrisma(seeds), { email: "nobody@nowhere.test", isPlatformOperator: false });
    const res = await request(app).get("/api/v1/model-routing/recommendations");

    expect(res.body).toEqual([]);
  });
});
