import { describe, expect, it } from "vitest";

import { _IntersectSessionScope, _NormalizeScopeSelectors } from "../../core/sessions/session-scope.js";
import { GrantCompilerAccess, GrantCompilerPayloadType, GrantCompilerScope, GrantCompilerSubjectType } from "../../core/grants/grant-compiler.types.js";
import type { CompiledGrantDecision } from "../../core/grants/grant-compiler.types.js";
import type { ScopeSelector } from "../../core/sessions/session-scope.types.js";

/** Build a compiled awareness decision for the given payload/access/scope. */
function _decision(payloadId: string, access: GrantCompilerAccess, scope: GrantCompilerScope): CompiledGrantDecision
{
	return {
		grantId: `g-${payloadId}`,
		payloadType: GrantCompilerPayloadType.Awareness,
		payloadId,
		access,
		priority: 0,
		scope,
		subjectType: GrantCompilerSubjectType.Tenant,
		subjectId: "t1",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("_NormalizeScopeSelectors (P4B.7)", function _suite()
{
	it("trims, drops empty/unknown, and dedupes by payloadId (last wins)", function _normalize()
	{
		const out = _NormalizeScopeSelectors([
			{ scope: "project", payloadId: " proj-x " },
			{ scope: "org", payloadId: "" },
			{ scope: "bogus" as ScopeSelector["scope"], payloadId: "proj-y" },
			{ scope: "department", payloadId: "proj-x" },
		]);
		// proj-x deduped to the last entry (department); empty + bogus dropped.
		expect(out).toEqual([{ scope: "department", payloadId: "proj-x" }]);
	});
});

describe("_IntersectSessionScope (P4B.7)", function _suite()
{
	const decisions: CompiledGrantDecision[] = [
		_decision("proj-x", GrantCompilerAccess.Allow, GrantCompilerScope.Project),
		_decision("org-acme", GrantCompilerAccess.Allow, GrantCompilerScope.Org),
		_decision("proj-y", GrantCompilerAccess.Deny, GrantCompilerScope.Project),
	];

	it("grants entitled scopes and rejects denied + unknown (anti-spill)", function _intersect()
	{
		const res = _IntersectSessionScope([
			{ scope: "project", payloadId: "proj-x" },
			{ scope: "project", payloadId: "proj-y" }, // explicitly denied
			{ scope: "project", payloadId: "proj-z" }, // no decision at all
			{ scope: "org", payloadId: "org-acme" },
		], decisions);

		expect(res.granted).toEqual([
			{ scope: "project", payloadId: "proj-x" },
			{ scope: "org", payloadId: "org-acme" },
		]);
		expect(res.rejected).toEqual([
			{ scope: "project", payloadId: "proj-y" },
			{ scope: "project", payloadId: "proj-z" },
		]);
	});

	it("adopts the authoritative grant scope, never the client-claimed one (no spoofing)", function _authoritative()
	{
		// Client claims proj-x at "org" level; the grant assigns it "project".
		const res = _IntersectSessionScope([{ scope: "org", payloadId: "proj-x" }], decisions);
		expect(res.granted).toEqual([{ scope: "project", payloadId: "proj-x" }]);
	});

	it("returns no grants when the principal is entitled to nothing requested", function _empty()
	{
		const res = _IntersectSessionScope([{ scope: "project", payloadId: "proj-y" }], decisions);
		expect(res.granted).toEqual([]);
		expect(res.rejected).toEqual([{ scope: "project", payloadId: "proj-y" }]);
	});
});
