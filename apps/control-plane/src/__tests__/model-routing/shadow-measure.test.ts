import type { PrismaClient, RoutingEvalCase } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { _RunShadowMeasurement } from "../../core/model-routing/shadow-measure.js";
import type { JudgeClient, ModelRunner } from "../../core/model-routing/shadow-measure.types.js";

/** Captured rows written by the mock Prisma client. */
interface CapturedWrites
{
  /** The persisted measurement rows. */
  measurements: Record<string, unknown>[];
  /** The persisted proposal rows. */
  proposals: Record<string, unknown>[];
}

/** Build a Prisma stub capturing measurement + proposal creates with stable ids. */
function _mockPrisma(captured: CapturedWrites): PrismaClient
{
  let mSeq = 0;
  let pSeq = 0;
  return {
    routingMeasurement: {
      create: async function _create(args: { data: Record<string, unknown> })
      {
        const row = { id: `m-${++mSeq}`, runAt: new Date("2026-06-18T00:00:00.000Z"), overheadPct: 0, ...args.data };
        captured.measurements.push(row);
        return row;
      },
    },
    routingProposal: {
      create: async function _create(args: { data: Record<string, unknown> })
      {
        const row = { id: `p-${++pSeq}`, status: "Pending", createdAt: new Date("2026-06-18T00:00:00.000Z"), ...args.data };
        captured.proposals.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;
}

/** Build an eval case row with sensible defaults. */
function _evalCase(over: Partial<RoutingEvalCase>): RoutingEvalCase
{
  return {
    id: "ec-1", skillName: "summarise", skillScope: "org", skillTeam: "", input: { q: "x" }, expected: null,
    qualityBar: 0.8, createdAt: new Date(), updatedAt: new Date(), ...over,
  } as RoutingEvalCase;
}

/** A runner returning a fixed cost per model. */
function _runner(baselineCost: number, candidateCost: number): ModelRunner
{
  return { run: async function _run(model: string) { return { output: model, costUsd: model === "candidate" ? candidateCost : baselineCost }; } };
}

/** A judge returning a fixed score. */
function _judge(score: number): JudgeClient
{
  return { score: async function _score() { return score; } };
}

describe("_RunShadowMeasurement", function _suite()
{
  const input = { skill: { name: "summarise", scope: "org", team: "" }, currentModel: "baseline", candidateModel: "candidate" };

  it("is a no-op when seams are unconfigured", async function _unconfigured()
  {
    const captured: CapturedWrites = { measurements: [], proposals: [] };
    const prisma = _mockPrisma(captured);

    const out = await _RunShadowMeasurement(prisma, { ...input, evalCases: [_evalCase({})] }, null, null);

    expect(out.kind).toBe("unconfigured");
    expect(captured.measurements).toHaveLength(0);
    expect(captured.proposals).toHaveLength(0);
  });

  it("is a no-op when there are no eval cases", async function _noCases()
  {
    const captured: CapturedWrites = { measurements: [], proposals: [] };
    const out = await _RunShadowMeasurement(_mockPrisma(captured), { ...input, evalCases: [] }, _judge(1), _runner(1, 0.5));
    expect(out.kind).toBe("unconfigured");
    expect(captured.measurements).toHaveLength(0);
  });

  it("persists a measurement AND a proposal when the savings CI excludes zero", async function _proposalEmitted()
  {
    const captured: CapturedWrites = { measurements: [], proposals: [] };
    const prisma = _mockPrisma(captured);
    // Cheaper candidate (0.5 vs 1.0) clears the bar everywhere -> savings ~50% with a positive CI.
    const cases = [_evalCase({ id: "a" }), _evalCase({ id: "b" }), _evalCase({ id: "c" })];

    const out = await _RunShadowMeasurement(prisma, { ...input, evalCases: cases }, _judge(0.95), _runner(1, 0.5), { bootstrapSamples: 20, rng: function _r() { return 0; } });

    expect(out.kind).toBe("measured");
    expect(captured.measurements).toHaveLength(1);
    expect(captured.proposals).toHaveLength(1);
    expect(captured.proposals[0].proposedModel).toBe("candidate");
    expect(captured.proposals[0].fromModel).toBe("baseline");
    expect(captured.measurements[0].projectedSavingsPct).toBeCloseTo(50, 6);
  });

  it("persists a measurement but NO proposal when the candidate fails the bar (no savings)", async function _noProposal()
  {
    const captured: CapturedWrites = { measurements: [], proposals: [] };
    const prisma = _mockPrisma(captured);
    // Judge below the 0.8 bar -> passedBar false everywhere -> effective == baseline -> 0% savings.
    const cases = [_evalCase({ id: "a" }), _evalCase({ id: "b" })];

    const out = await _RunShadowMeasurement(prisma, { ...input, evalCases: cases }, _judge(0.5), _runner(1, 0.5), { bootstrapSamples: 20, rng: function _r() { return 0; } });

    expect(out.kind).toBe("measured");
    expect(captured.measurements).toHaveLength(1);
    expect(captured.proposals).toHaveLength(0);
    expect(captured.measurements[0].projectedSavingsPct).toBeCloseTo(0, 6);
  });
});
