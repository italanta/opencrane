import { describe, expect, it } from "vitest";

import { ___EvaluateGolden } from "../eval/conformance.js";
import { ConformanceDimension } from "../eval/golden.types.js";
import type { GoldenQuery } from "../eval/golden.types.js";
import type { AwarenessResult, AwarenessHit } from "../awareness-client.types.js";

const _NOW = Date.parse("2026-06-13T12:00:00Z");

/** Build an awareness hit with sensible citable defaults. */
function _hit(over: Partial<AwarenessHit> = {}): AwarenessHit
{
	return {
		content: "Q3 revenue grew 12%.",
		score: 0.9,
		datasets: ["department/finance"],
		citation: { title: "Q3", uri: "https://wiki/q3", freshnessTimestamp: "2026-06-13T00:00:00Z" },
		...over,
	};
}

/** Build a result wrapping the given hits. */
function _result(hits: AwarenessHit[], droppedUncitable = 0): AwarenessResult
{
	return { contractVersion: "awareness/v1alpha1", query: "q", hits, droppedUncitable };
}

/** Build a golden with sensible allowed scope + overrides. */
function _golden(over: Partial<GoldenQuery> = {}): GoldenQuery
{
	return { id: "g1", query: "how did Q3 go?", allowedDatasets: ["department/finance", "org"], ...over };
}

/** Pull a single dimension's check out of an evaluation. */
function _check(result: AwarenessResult, golden: GoldenQuery, dim: ConformanceDimension)
{
	return ___EvaluateGolden(result, golden, _NOW).checks.find(function _d(c) { return c.dimension === dim; })!;
}

describe("___EvaluateGolden (P4B.4 conformance)", function _suite()
{
	it("passes a clean, fresh, in-scope, correct result on all dimensions", function _allPass()
	{
		const out = ___EvaluateGolden(_result([_hit()]), _golden({ expectedContains: ["revenue grew"] }), _NOW);
		expect(out.passed).toBe(true);
		expect(out.checks).toHaveLength(4);
	});

	it("citation: fails when the SDK dropped uncitable hits", function _citation()
	{
		expect(_check(_result([_hit()], 2), _golden(), ConformanceDimension.Citation).passed).toBe(false);
	});

	it("policy-safety: fails when a hit comes from an out-of-scope dataset", function _policy()
	{
		const leaky = _hit({ datasets: ["project/zeus"] });
		const check = _check(_result([leaky]), _golden(), ConformanceDimension.PolicySafety);
		expect(check.passed).toBe(false);
		expect(check.detail).toContain("project/zeus");
	});

	it("freshness: fails a source older than the 24h SLO and an undatable one", function _freshness()
	{
		const stale = _hit({ citation: { title: "old", uri: "u-stale", freshnessTimestamp: "2026-06-01T00:00:00Z" } });
		expect(_check(_result([stale]), _golden(), ConformanceDimension.Freshness).passed).toBe(false);
		const undatable = _hit({ citation: { title: "x", uri: "u-bad", freshnessTimestamp: "not-a-date" } });
		expect(_check(_result([undatable]), _golden(), ConformanceDimension.Freshness).passed).toBe(false);
	});

	it("freshness: respects a per-golden maxFreshnessAgeMs override", function _freshnessOverride()
	{
		// 1h-old source passes the default 24h but fails a tight 10-minute SLO.
		const hourOld = _hit({ citation: { title: "h", uri: "u", freshnessTimestamp: "2026-06-13T11:00:00Z" } });
		expect(_check(_result([hourOld]), _golden(), ConformanceDimension.Freshness).passed).toBe(true);
		expect(_check(_result([hourOld]), _golden({ maxFreshnessAgeMs: 10 * 60 * 1000 }), ConformanceDimension.Freshness).passed).toBe(false);
	});

	it("correctness: fails when an expected fact is absent", function _correctness()
	{
		expect(_check(_result([_hit()]), _golden({ expectedContains: ["headcount"] }), ConformanceDimension.Correctness).passed).toBe(false);
		// Case-insensitive match passes.
		expect(_check(_result([_hit()]), _golden({ expectedContains: ["REVENUE"] }), ConformanceDimension.Correctness).passed).toBe(true);
	});
});
