import { describe, expect, it } from "vitest";

import { _ResolveOpenClawPairing } from "../../infra/auth/openclaw-pairing.js";

describe("_ResolveOpenClawPairing", function _suite()
{
	it("uses the stored wss gateway URL", function _stored()
	{
		const pairing = _ResolveOpenClawPairing({ openclaw: { gatewayUrl: "wss://pod/gateway" } }, "pod.example.com");
		expect(pairing).toEqual({ gatewayUrl: "wss://pod/gateway" });
	});

	it("derives the gateway URL from ingressHost when none is stored, routed at /gateway", function _derived()
	{
		// Same-origin hosting: the SPA owns `/` and the control plane `/api`, so the WS is
		// exposed at `/gateway` (the proxy strips the prefix before forwarding to the pod).
		const pairing = _ResolveOpenClawPairing(null, "pod.example.com");
		expect(pairing).toEqual({ gatewayUrl: "wss://pod.example.com/gateway" });
	});

	it("returns null when there is no URL and no ingress host", function _notReady()
	{
		expect(_ResolveOpenClawPairing(null, null)).toBeNull();
		expect(_ResolveOpenClawPairing({ openclaw: {} }, null)).toBeNull();
	});

	it("ignores a malformed configOverrides shape", function _malformed()
	{
		expect(_ResolveOpenClawPairing("not-an-object", "pod.example.com")?.gatewayUrl).toBe("wss://pod.example.com/gateway");
		expect(_ResolveOpenClawPairing({ openclaw: 42 }, null)).toBeNull();
	});

	it("rejects a non-wss stored gateway URL, falling back to wss ingress", function _rejectsWs()
	{
		const pairing = _ResolveOpenClawPairing({ openclaw: { gatewayUrl: "ws://pod/gateway" } }, "pod.example.com");
		expect(pairing).toEqual({ gatewayUrl: "wss://pod.example.com/gateway" });
	});

	it("returns null when the stored URL is non-wss and there is no ingress host", function _rejectsWsNoFallback()
	{
		expect(_ResolveOpenClawPairing({ openclaw: { gatewayUrl: "https://pod/gateway" } }, null)).toBeNull();
	});
});
