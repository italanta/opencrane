import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _BuildFleetParticipationReport, _ClassifyParticipation, _RecordParticipationEvent } from "../../core/awareness/participation.js";

const _NOW = Date.parse("2026-06-13T12:00:00Z");
const _WINDOW = 15 * 60 * 1000;

describe("_ClassifyParticipation (P4B.5 severity model)", function _suite()
{
	const base = { runningVersion: "awareness/v1alpha1", expectedVersion: "awareness/v1alpha1", policyViolations: 0, nowMs: _NOW, stalenessWindowMs: _WINDOW };

	it("ok when fresh, on the expected version, and no violations", function _ok()
	{
		const c = _ClassifyParticipation({ ...base, lastSeenAtMs: _NOW - 60_000 });
		expect(c).toEqual({ participating: true, drifted: false, severity: "ok" });
	});

	it("warning (non-participation) when never seen or stale", function _stale()
	{
		expect(_ClassifyParticipation({ ...base, lastSeenAtMs: null }).severity).toBe("warning");
		expect(_ClassifyParticipation({ ...base, lastSeenAtMs: _NOW - 30 * 60 * 1000 })).toMatchObject({ participating: false, severity: "warning" });
	});

	it("warning (drift) when running version differs from expected", function _drift()
	{
		const c = _ClassifyParticipation({ ...base, lastSeenAtMs: _NOW - 1000, runningVersion: "awareness/v2alpha1" });
		expect(c).toMatchObject({ drifted: true, severity: "warning" });
	});

	it("critical when there are policy violations (overrides participation/drift)", function _critical()
	{
		const c = _ClassifyParticipation({ ...base, lastSeenAtMs: _NOW - 1000, policyViolations: 2 });
		expect(c.severity).toBe("critical");
	});
});

/** Build a Prisma stub for the record path; create throws P2002 when `duplicate`. */
function _recordPrisma(duplicate: boolean)
{
	const eventCreate = duplicate
		? vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }))
		: vi.fn().mockResolvedValue({});
	const upsert = vi.fn().mockResolvedValue({});
	const prisma = { participationEvent: { create: eventCreate }, tenantParticipation: { upsert } } as unknown as PrismaClient;
	return { prisma, eventCreate, upsert };
}

describe("_RecordParticipationEvent (P4B.5 idempotent ingest)", function _suite()
{
	it("records a new skill-execution policy violation and advances the rollup counters", async function _violation()
	{
		const { prisma, upsert } = _recordPrisma(false);
		const result = await _RecordParticipationEvent(prisma, { tenant: "t1", kind: "skill_execution", idempotencyKey: "k1", outcome: "policy-violation" });

		expect(result).toEqual({ recorded: true, duplicate: false });
		const call = upsert.mock.calls[0][0];
		expect(call.create).toMatchObject({ tenant: "t1", skillExecutionCount: 1, policyViolationCount: 1 });
		expect(call.update.skillExecutionCount).toEqual({ increment: 1 });
		expect(call.update.policyViolationCount).toEqual({ increment: 1 });
	});

	it("dedupes an at-least-once redelivery (P2002) without touching the rollup", async function _dup()
	{
		const { prisma, upsert } = _recordPrisma(true);
		const result = await _RecordParticipationEvent(prisma, { tenant: "t1", kind: "heartbeat", idempotencyKey: "k1" });
		expect(result).toEqual({ recorded: false, duplicate: true });
		expect(upsert).not.toHaveBeenCalled();
	});

	it("an agent_card event sets the card and does not bump execution counters", async function _card()
	{
		const { prisma, upsert } = _recordPrisma(false);
		await _RecordParticipationEvent(prisma, { tenant: "t1", kind: "agent_card", idempotencyKey: "k2", contractVersion: "awareness/v1alpha1", payload: { skills: ["s1"] } });
		const call = upsert.mock.calls[0][0];
		expect(call.create).toMatchObject({ skillExecutionCount: 0, policyViolationCount: 0, runningContractVersion: "awareness/v1alpha1" });
		expect(call.update.agentCard).toEqual({ skills: ["s1"] });
	});
});

describe("_BuildFleetParticipationReport (P4B.5 monitoring)", function _suite()
{
	it("classifies each tenant against its rollout-expected version and aggregates", async function _report()
	{
		const prisma = {
			tenant: { findMany: vi.fn().mockResolvedValue([
				{ name: "fresh", awarenessWave: "org" },
				{ name: "drifted", awarenessWave: "org" },
				{ name: "silent", awarenessWave: "org" },
				{ name: "bad", awarenessWave: "org" },
			]) },
			tenantParticipation: { findMany: vi.fn().mockResolvedValue([
				{ tenant: "fresh", lastSeenAt: new Date(_NOW - 60_000), runningContractVersion: "awareness/v1alpha1", policyViolationCount: 0 },
				{ tenant: "drifted", lastSeenAt: new Date(_NOW - 60_000), runningContractVersion: "awareness/v2alpha1", policyViolationCount: 0 },
				{ tenant: "bad", lastSeenAt: new Date(_NOW - 60_000), runningContractVersion: "awareness/v1alpha1", policyViolationCount: 3 },
				// "silent" has no rollup row → never participated.
			]) },
			awarenessRollout: { findUnique: vi.fn().mockResolvedValue(null) }, // default → expected = pinned v1alpha1
		} as unknown as PrismaClient;

		const report = await _BuildFleetParticipationReport(prisma, _NOW, _WINDOW);

		expect(report.total).toBe(4);
		expect(report.participating).toBe(3);     // fresh, drifted, bad seen recently; silent not
		expect(report.drifted).toBe(1);           // drifted runs v2 vs expected v1
		expect(report.critical).toBe(1);          // bad has violations
		expect(report.warning).toBe(2);           // drifted + silent
		const byName = Object.fromEntries(report.tenants.map(function _e(t) { return [t.tenant, t.severity]; }));
		expect(byName).toEqual({ fresh: "ok", drifted: "warning", silent: "warning", bad: "critical" });
	});
});
