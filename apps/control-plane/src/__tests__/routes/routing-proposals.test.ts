import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { routingProposalsRouter } from "../../routes/routing-proposals.js";

/** An in-memory row store for proposals + skills + audit. */
interface Stores
{
  /** Proposal rows keyed by id. */
  proposals: Map<string, Record<string, unknown>>;
  /** Skill rows keyed by compound-key string. */
  skills: Map<string, Record<string, unknown>>;
  /** Captured audit rows. */
  audit: Record<string, unknown>[];
}

/** Build a Prisma stub over the stores; supports the transaction used by approve. */
function _mockPrisma(stores: Stores): PrismaClient
{
  function _skillKey(name: string, scope: string, team: string): string { return `${name}:${scope}:${team}`; }
  const client = {
    tenant: { findMany: async function _fm() { return []; } },
    routingProposal: {
      findMany: async function _list(args?: { where?: { status?: string } })
      {
        const all = Array.from(stores.proposals.values());
        return args?.where?.status ? all.filter(function _byS(r) { return r.status === args.where!.status; }) : all;
      },
      findUnique: async function _fu(args: { where: { id: string }; select?: Record<string, boolean> }) { return stores.proposals.get(args.where.id) ?? null; },
      update: async function _update(args: { where: { id: string }; data: Record<string, unknown> })
      {
        const row = { ...stores.proposals.get(args.where.id), ...args.data };
        stores.proposals.set(args.where.id, row);
        return row;
      },
    },
    skill: {
      findUnique: async function _fu(args: { where: { name_scope_team: { name: string; scope: string; team: string } } })
      {
        const k = args.where.name_scope_team;
        return stores.skills.get(_skillKey(k.name, k.scope, k.team)) ?? null;
      },
      update: async function _update(args: { where: { name_scope_team: { name: string; scope: string; team: string } }; data: Record<string, unknown> })
      {
        const k = args.where.name_scope_team;
        const key = _skillKey(k.name, k.scope, k.team);
        const row = { ...stores.skills.get(key), ...args.data };
        stores.skills.set(key, row);
        return row;
      },
    },
    auditEntry: { create: async function _create(args: { data: Record<string, unknown> }) { stores.audit.push(args.data); return args.data; } },
    $transaction: async function _tx(fn: (tx: unknown) => Promise<void>) { await fn(client); },
  };
  return client as unknown as PrismaClient;
}

/** Build a minimal app mounting the proposals router. */
function _buildApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/model-routing/proposals", routingProposalsRouter(prisma));
  return app;
}

/** Seed a pending proposal + its target skill. */
function _seed(): Stores
{
  const stores: Stores = { proposals: new Map(), skills: new Map(), audit: [] };
  stores.proposals.set("p1", { id: "p1", skillName: "summarise", skillScope: "org", skillTeam: "", fromModel: "expensive", proposedModel: "cheap", projectedSavingsPct: 40, ciLowPct: 10, ciHighPct: 60, measurementId: "m1", status: "Pending", decidedBy: null, decidedAt: null, createdAt: new Date() });
  stores.skills.set("summarise:org:", { name: "summarise", scope: "org", team: "", modelMode: null, pinnedModel: null });
  return stores;
}

describe("routingProposalsRouter", function _suite()
{
  it("lists and filters proposals by status", async function _list()
  {
    const stores = _seed();
    const list = await request(_buildApp(_mockPrisma(stores))).get("/api/v1/model-routing/proposals?status=pending");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe("pending");
  });

  it("approve pins the skill, marks Applied, and writes an audit entry", async function _approve()
  {
    const stores = _seed();
    const res = await request(_buildApp(_mockPrisma(stores))).post("/api/v1/model-routing/proposals/p1/approve").send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("applied");
    expect(res.body.appliedModel).toBe("cheap");
    expect(stores.skills.get("summarise:org:")!.pinnedModel).toBe("cheap");
    expect(stores.skills.get("summarise:org:")!.modelMode).toBe("Pinned");
    expect(stores.proposals.get("p1")!.status).toBe("Applied");
    expect(stores.audit.some(function _a(e) { return e.action === "RoutingProposalApplied"; })).toBe(true);
  });

  it("reject flips status and leaves the skill untouched", async function _reject()
  {
    const stores = _seed();
    const res = await request(_buildApp(_mockPrisma(stores))).post("/api/v1/model-routing/proposals/p1/reject").send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(stores.skills.get("summarise:org:")!.pinnedModel).toBeNull();
    expect(stores.proposals.get("p1")!.status).toBe("Rejected");
    expect(stores.audit.some(function _a(e) { return e.action === "RoutingProposalRejected"; })).toBe(true);
  });

  it("409s when approving an already-decided proposal", async function _doubleApply()
  {
    const stores = _seed();
    stores.proposals.get("p1")!.status = "Applied";
    const res = await request(_buildApp(_mockPrisma(stores))).post("/api/v1/model-routing/proposals/p1/approve").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PROPOSAL_ALREADY_DECIDED");
  });

  it("404s when the proposal is missing", async function _missing()
  {
    const res = await request(_buildApp(_mockPrisma(_seed()))).post("/api/v1/model-routing/proposals/nope/approve").send({});
    expect(res.status).toBe(404);
  });
});
