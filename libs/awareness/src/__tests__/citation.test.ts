import { describe, expect, it } from "vitest";

import { _BuildCitation, _IsCitable } from "../citation.js";

describe("_BuildCitation (P4B.0 citation format)", function _suite()
{
	it("builds a complete citation from title + uri + sourceUpdatedAt", function _ok()
	{
		const c = _BuildCitation({ title: "Q3 Plan", uri: "https://wiki/q3", sourceUpdatedAt: "2026-06-01T00:00:00Z" });
		expect(c).toEqual({ title: "Q3 Plan", uri: "https://wiki/q3", freshnessTimestamp: "2026-06-01T00:00:00Z" });
	});

	it("falls back to url and freshnessRecordedAt", function _fallback()
	{
		const c = _BuildCitation({ title: "Notes", url: "https://drive/notes", freshnessRecordedAt: "2026-06-10T12:00:00Z" });
		expect(c).toEqual({ title: "Notes", uri: "https://drive/notes", freshnessTimestamp: "2026-06-10T12:00:00Z" });
	});

	it("prefers explicit uri over url and sourceUpdatedAt over freshnessRecordedAt", function _prefer()
	{
		const c = _BuildCitation({ title: "T", uri: "u1", url: "u2", sourceUpdatedAt: "s1", freshnessRecordedAt: "s2" });
		expect(c).toEqual({ title: "T", uri: "u1", freshnessTimestamp: "s1" });
	});

	it("returns null when any required field is missing or blank", function _missing()
	{
		expect(_BuildCitation({ uri: "u", sourceUpdatedAt: "t" })).toBeNull();               // no title
		expect(_BuildCitation({ title: "t", sourceUpdatedAt: "t" })).toBeNull();              // no uri
		expect(_BuildCitation({ title: "t", uri: "u" })).toBeNull();                          // no freshness
		expect(_BuildCitation({ title: "  ", uri: "u", sourceUpdatedAt: "t" })).toBeNull();   // blank title
		expect(_IsCitable({ title: "t", uri: "u", sourceUpdatedAt: "t" })).toBe(true);
	});
});
