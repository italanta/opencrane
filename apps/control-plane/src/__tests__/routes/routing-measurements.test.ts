import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { routingMeasurementsRouter } from "../../routes/routing-measurements.js";
import type { ShadowSeamsFactory } from "../../routes/routing-measurements.js";

/** In-memory measurement row. */
type Row = Record<string, unknown>;

/** Build a Prisma stub over a measurement store + minimal eval-case/skill lookups. */
function _mockPrisma(store: Map<string, Row>): PrismaClient
{
  return {
    tenant: { findMany: async function _fm() { return []; } },
    routingMeasurement: {
      findMany: async function _list(args?: { where?: Record<string, unknown> })
      {
        const where = args?.where ?? {};
        return Array.from(store.values()).filter(function _m(r) { return Object.entries(where).every(function _eq([k, v]) { return r[k] === v; }); });
      },
      findUnique: async function _fu(args: { where: { id: string } }) { return store.get(args.where.id) ?? null; },
    },
    routingEvalCase: { findMany: async function _fm() { return []; } },
    skill: { findUnique: async function _fu() { return null; } },
  } as unknown as PrismaClient;
}

/** A factory that returns unconfigured (null) seams. */
const _unconfiguredSeams: ShadowSeamsFactory = function _f() { return { judge: null, runner: null }; };

/** Build a minimal app mounting the router. */
function _buildApp(prisma: PrismaClient, seams: ShadowSeamsFactory): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/model-routing/measurements", routingMeasurementsRouter(prisma, seams));
  return app;
}

describe("routingMeasurementsRouter", function _suite()
{
  it("lists measurements filtered by skill", async function _list()
  {
    const store = new Map<string, Row>([["m1", { id: "m1", skillName: "summarise", skillScope: "org", skillTeam: "", candidateModel: "cheap", sampledCalls: 3, atBarCheapFraction: 1, projectedSavingsPct: 40, ciLowPct: 10, ciHighPct: 60, overheadPct: 0, runAt: new Date("2026-06-18T00:00:00.000Z") }]]);
    const res = await request(_buildApp(_mockPrisma(store), _unconfiguredSeams)).get("/api/v1/model-routing/measurements?skillName=summarise");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].candidateModel).toBe("cheap");
  });

  it("gets a single measurement by id", async function _get()
  {
    const store = new Map<string, Row>([["m1", { id: "m1", skillName: "s", skillScope: "org", skillTeam: "", candidateModel: null, sampledCalls: 0, atBarCheapFraction: 0, projectedSavingsPct: 0, ciLowPct: 0, ciHighPct: 0, overheadPct: 0, runAt: new Date("2026-06-18T00:00:00.000Z") }]]);
    const res = await request(_buildApp(_mockPrisma(store), _unconfiguredSeams)).get("/api/v1/model-routing/measurements/m1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("m1");
  });

  it("404s on an unknown measurement", async function _missing()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()), _unconfiguredSeams)).get("/api/v1/model-routing/measurements/nope");
    expect(res.status).toBe(404);
  });

  it("POST /run is a best-effort no-op (200) when seams are unconfigured", async function _runNoop()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()), _unconfiguredSeams)).post("/api/v1/model-routing/measurements/run").send({ skillName: "s", skillScope: "org", candidateModel: "cheap" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unconfigured");
  });

  it("POST /run rejects a body missing candidateModel (400)", async function _runBad()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()), _unconfiguredSeams)).post("/api/v1/model-routing/measurements/run").send({ skillName: "s", skillScope: "org" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});
