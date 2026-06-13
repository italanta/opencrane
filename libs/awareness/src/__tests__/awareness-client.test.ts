import { describe, expect, it, vi } from "vitest";

import { AwarenessClient } from "../awareness-client.js";
import { AWARENESS_CONTRACT_VERSION } from "../contract-version.js";
import type { AwarenessQuery, CogneeSearchHit, CogneeSearchTransport } from "../awareness-client.types.js";

/** A transport returning a fixed set of hits and recording the call. */
function _transport(hits: CogneeSearchHit[]): CogneeSearchTransport & { calls: unknown[][] }
{
	const calls: unknown[][] = [];
	const fn = function _t(endpoint: string, query: AwarenessQuery, signal?: AbortSignal): Promise<CogneeSearchHit[]>
	{
		calls.push([endpoint, query, signal]);
		return Promise.resolve(hits);
	};
	return Object.assign(fn, { calls });
}

const _CITABLE: CogneeSearchHit = {
	content: "Q3 revenue grew 12%.",
	score: 0.9,
	datasets: ["department/finance"],
	metadata: { title: "Q3 Report", uri: "https://wiki/q3", source_updated_at: "2026-06-01T00:00:00Z" },
};

describe("AwarenessClient.query (P4B.1)", function _suite()
{
	it("returns citable hits stamped with the contract version", async function _ok()
	{
		const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000", search: _transport([_CITABLE]) });
		const result = await client.query({ query: "how did Q3 go?" });

		expect(result.contractVersion).toBe(AWARENESS_CONTRACT_VERSION);
		expect(result.query).toBe("how did Q3 go?");
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]).toMatchObject({
			content: "Q3 revenue grew 12%.",
			score: 0.9,
			datasets: ["department/finance"],
			citation: { title: "Q3 Report", uri: "https://wiki/q3", freshnessTimestamp: "2026-06-01T00:00:00Z" },
		});
		expect(result.droppedUncitable).toBe(0);
	});

	it("drops uncitable hits and counts them (citation-quality invariant)", async function _drop()
	{
		const uncitable: CogneeSearchHit = { content: "orphan fact", metadata: { title: "No link" } };
		const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000", search: _transport([_CITABLE, uncitable]) });
		const result = await client.query({ query: "x" });

		expect(result.hits).toHaveLength(1);
		expect(result.droppedUncitable).toBe(1);
		// Every surfaced hit carries a complete citation — never an unattributed one.
		expect(result.hits.every(function _cited(h) { return h.citation.title && h.citation.uri && h.citation.freshnessTimestamp; })).toBe(true);
	});

	it("retrieves directly from the Cognee endpoint (no control-plane mediation) and applies the default limit", async function _direct()
	{
		const transport = _transport([]);
		const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000/", search: transport, defaultLimit: 5 });
		await client.query({ query: "x", datasets: ["org"] });

		// The transport is called with the Cognee endpoint (trailing slash trimmed), not a control-plane URL.
		expect(transport.calls[0][0]).toBe("http://cognee:8000");
		expect(transport.calls[0][1]).toMatchObject({ query: "x", datasets: ["org"], limit: 5 });
	});

	it("missing score becomes null", async function _noScore()
	{
		const noScore: CogneeSearchHit = { content: "c", metadata: { title: "T", uri: "u", source_updated_at: "t" } };
		const client = new AwarenessClient({ cogneeEndpoint: "http://c", search: _transport([noScore]) });
		const result = await client.query({ query: "x" });
		expect(result.hits[0].score).toBeNull();
	});
});

describe("AwarenessClient default transport", function _suite()
{
	it("POSTs to <endpoint>/v1/search and parses a results envelope", async function _fetch()
	{
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: function _json() { return Promise.resolve({ results: [{ text: "hello", metadata: { title: "T", uri: "u", source_updated_at: "t" } }] }); },
		});
		vi.stubGlobal("fetch", fetchMock);

		try
		{
			const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000" });
			const result = await client.query({ query: "hi" });
			expect(fetchMock).toHaveBeenCalledWith("http://cognee:8000/v1/search", expect.objectContaining({ method: "POST" }));
			expect(result.hits[0].content).toBe("hello");
		}
		finally
		{
			vi.unstubAllGlobals();
		}
	});

	it("degrades to empty hits on a null/garbage JSON body instead of crashing", async function _nullBody()
	{
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: function _json() { return Promise.resolve(null); } });
		vi.stubGlobal("fetch", fetchMock);
		try
		{
			const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000" });
			const result = await client.query({ query: "hi" });
			expect(result.hits).toEqual([]);
			expect(result.droppedUncitable).toBe(0);
		}
		finally
		{
			vi.unstubAllGlobals();
		}
	});

	it("throws on a non-2xx Cognee response", async function _err()
	{
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
		vi.stubGlobal("fetch", fetchMock);
		try
		{
			const client = new AwarenessClient({ cogneeEndpoint: "http://cognee:8000" });
			await expect(client.query({ query: "hi" })).rejects.toThrow(/Cognee search failed: 503/);
		}
		finally
		{
			vi.unstubAllGlobals();
		}
	});
});
