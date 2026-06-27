import { describe, expect, it } from "vitest";

import { McpCredentialValidationError, _NormalizeCredentialInput } from "../../core/mcp-servers/mcp-servers.logic.js";
import type { McpServerCredentialInput } from "../../routes/mcp-servers.types.js";

const _SERVER_ID = "srv_1";

/** Build a credential input with sensible defaults for a single test case. */
function _input(overrides: Partial<McpServerCredentialInput>): McpServerCredentialInput
{
	return { displayName: "GitHub PAT", ...overrides };
}

describe("_NormalizeCredentialInput (P4D.1 brokering custody)", function _suite()
{
	it("accepts a static credential carrying a secretRef", function _staticOk()
	{
		const row = _NormalizeCredentialInput(_SERVER_ID, _input({ brokeringMode: "static", secretRef: "vault://gh" }));
		expect(row).toMatchObject({ mcpServerId: _SERVER_ID, brokeringMode: "StaticFallback", secretRef: "vault://gh" });
	});

	it("defaults to static brokering when no mode is supplied (pre-P4D.1 payloads)", function _defaultStatic()
	{
		const row = _NormalizeCredentialInput(_SERVER_ID, _input({ secretRef: "vault://gh" }));
		expect(row.brokeringMode).toBe("StaticFallback");
		expect(row.secretRef).toBe("vault://gh");
	});

	it("rejects a static credential with no secretRef", function _staticNoSecret()
	{
		expect(function _call() { return _NormalizeCredentialInput(_SERVER_ID, _input({ brokeringMode: "static" })); })
			.toThrow(McpCredentialValidationError);
	});

	it("treats a blank/whitespace secretRef as absent for a static credential", function _staticBlankSecret()
	{
		expect(function _call() { return _NormalizeCredentialInput(_SERVER_ID, _input({ brokeringMode: "static", secretRef: "   " })); })
			.toThrow(McpCredentialValidationError);
	});

	it("accepts an OBO credential with no secretRef and stores null", function _oboOk()
	{
		const row = _NormalizeCredentialInput(_SERVER_ID, _input({ brokeringMode: "obo" }));
		expect(row.brokeringMode).toBe("PerUserObo");
		expect(row.secretRef).toBeNull();
	});

	it("rejects an OBO credential that authors a static secretRef (custody violation)", function _oboWithSecret()
	{
		expect(function _call() { return _NormalizeCredentialInput(_SERVER_ID, _input({ brokeringMode: "obo", secretRef: "vault://gh" })); })
			.toThrow(McpCredentialValidationError);
	});
});
