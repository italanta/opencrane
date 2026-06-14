import { describe, expect, it } from "vitest";

import { AwarenessClient } from "../awareness-client.js";
import { ___RunGoldenSuite, ___SuiteGatesRollout } from "../eval/runner.js";
import type { GoldenQuery } from "../eval/golden.types.js";
import type { CogneeSearchHit, CogneeSearchTransport } from "../awareness-client.types.js";

const _NOW = Date.parse("2026-06-13T12:00:00Z");

/** A transport that answers per query string from a fixture map. */
function _transport(byQuery: Record<string, CogneeSearchHit[]>): CogneeSearchTransport
{
	return function _t(_endpoint, query) { return Promise.resolve(byQuery[query.query] ?? []); };
}

function _freshHit(dataset: string, content: string): CogneeSearchHit
{
	return { content, datasets: [dataset], metadata: { title: "T", uri: `https://src/${dataset}`, source_updated_at: "2026-06-13T11:00:00Z" } };
}

const _GOLDENS: GoldenQuery[] = [
	{ id: "g-finance", query: "q3 revenue?", allowedDatasets: ["department/finance"], expectedContains: ["revenue"] },
	{ id: "g-eng", query: "deploy process?", allowedDatasets: ["department/eng"], expectedContains: ["deploy"] },
];

describe("___RunGoldenSuite + ___SuiteGatesRollout (P4B.4)", function _suite()
{
	it("passes a clean suite and gates the rollout open", async function _clean()
	{
		const client = new AwarenessClient({
			cogneeEndpoint: "http://cognee",
			search: _transport({
				"q3 revenue?": [_freshHit("department/finance", "revenue grew 12%")],
				"deploy process?": [_freshHit("department/eng", "deploy via the pipeline")],
			}),
		});

		const report = await ___RunGoldenSuite(client, _GOLDENS, _NOW);
		expect(report).toMatchObject({ total: 2, passed: 2, failed: 0, policyViolations: 0 });
		expect(___SuiteGatesRollout(report)).toBe(true);
	});

	it("counts a policy violation and gates the rollout shut", async function _violation()
	{
		const client = new AwarenessClient({
			cogneeEndpoint: "http://cognee",
			search: _transport({
				// finance query leaks an eng dataset → policy violation
				"q3 revenue?": [_freshHit("department/eng", "revenue and secret eng plans")],
				"deploy process?": [_freshHit("department/eng", "deploy via the pipeline")],
			}),
		});

		const report = await ___RunGoldenSuite(client, _GOLDENS, _NOW);
		expect(report.policyViolations).toBe(1);
		expect(report.failed).toBe(1);
		expect(___SuiteGatesRollout(report)).toBe(false);
	});

	it("keeps the gate OPEN on a non-policy quality failure (warn, not block)", async function _correctnessFail()
	{
		const client = new AwarenessClient({
			cogneeEndpoint: "http://cognee",
			search: _transport({
				"q3 revenue?": [_freshHit("department/finance", "revenue grew 12%")],
				"deploy process?": [_freshHit("department/eng", "unrelated content")],
			}),
		});

		const report = await ___RunGoldenSuite(client, _GOLDENS, _NOW);
		// A correctness miss with clean policy + no errors is a warning, not a gate block
		// (locked SLO: violation=page / drift=warn).
		expect(report.policyViolations).toBe(0);
		expect(report.errors).toBe(0);
		expect(report.failed).toBe(1);
		expect(___SuiteGatesRollout(report)).toBe(true);
	});

	it("captures a query error as a failed result and gates SHUT (verification impossible)", async function _queryError()
	{
		const client = new AwarenessClient({
			cogneeEndpoint: "http://cognee",
			search: function _t(_e, query) { return query.query === "deploy process?" ? Promise.reject(new Error("cognee down")) : Promise.resolve([_freshHit("department/finance", "revenue grew 12%")]); },
		});

		const report = await ___RunGoldenSuite(client, _GOLDENS, _NOW);
		expect(report.errors).toBe(1);
		expect(report.results.find(function _e(r) { return r.id === "g-eng"; })?.error).toContain("cognee down");
		expect(___SuiteGatesRollout(report)).toBe(false);
	});
});
