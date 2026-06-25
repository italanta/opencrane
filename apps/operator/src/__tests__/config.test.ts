import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _LoadOperatorConfig } from "../config.js";

/** Minimal mandatory env so `_LoadOperatorConfig` reaches the multi-instance guard. */
const _BASE_ENV: Record<string, string> = {
	TENANT_DEFAULT_IMAGE: "ghcr.io/opencrane/tenant:latest",
	INGRESS_DOMAIN: "ai.example.com",
	GATEWAY_PORT: "8080",
	IDLE_TIMEOUT_MINUTES: "30",
	IDLE_CHECK_INTERVAL_SECONDS: "60",
	LITELLM_ENABLED: "false",
	LITELLM_ENDPOINT: "http://litellm:4000",
	LITELLM_DEFAULT_MONTHLY_BUDGET_USD: "100",
};

describe("_LoadOperatorConfig multi-instance fail-closed guard (MI.1 / brief B2)", function _suite()
{
	let _saved: NodeJS.ProcessEnv;

	beforeEach(function _save()
	{
		_saved = process.env;
		process.env = { ..._BASE_ENV };
	});

	afterEach(function _restore()
	{
		process.env = _saved;
	});

	it("throws when REQUIRE_WATCH_NAMESPACE is true and WATCH_NAMESPACE is empty", function _failClosed()
	{
		process.env.WATCH_NAMESPACE = "";
		process.env.REQUIRE_WATCH_NAMESPACE = "true";
		expect(function _load() { _LoadOperatorConfig(); }).toThrow(/refusing to watch all namespaces/);
	});

	it("throws when WATCH_NAMESPACE is only whitespace under the guard", function _whitespace()
	{
		process.env.WATCH_NAMESPACE = "   ";
		process.env.REQUIRE_WATCH_NAMESPACE = "true";
		expect(function _load() { _LoadOperatorConfig(); }).toThrow(/refusing to watch all namespaces/);
	});

	it("loads a scoped namespace under the guard", function _scoped()
	{
		process.env.WATCH_NAMESPACE = "oc-acme";
		process.env.REQUIRE_WATCH_NAMESPACE = "true";
		const config = _LoadOperatorConfig();
		expect(config.watchNamespace).toBe("oc-acme");
		expect(config.requireWatchNamespace).toBe(true);
	});

	it("allows an empty watch namespace when the guard is off (legacy single-install)", function _legacy()
	{
		process.env.WATCH_NAMESPACE = "";
		// REQUIRE_WATCH_NAMESPACE unset → defaults to false.
		const config = _LoadOperatorConfig();
		expect(config.watchNamespace).toBe("");
		expect(config.requireWatchNamespace).toBe(false);
	});

	it("derives runtime-plane URL fallbacks from POD_NAMESPACE, not a shared namespace (B5)", function _podNamespaceFallback()
	{
		process.env.WATCH_NAMESPACE = "oc-acme";
		process.env.POD_NAMESPACE = "oc-acme";
		// Runtime-plane URL env vars are intentionally unset so the fallbacks are exercised.
		const config = _LoadOperatorConfig();
		expect(config.mcpGatewayUrl).toBe("http://opencrane-mcp-gateway.oc-acme.svc:8080");
		expect(config.skillRegistryUrl).toBe("http://opencrane-skill-registry.oc-acme.svc:5000");
		expect(config.controlPlaneInternalUrl).toBe("http://opencrane-control-plane.oc-acme.svc:3000");
	});

	it("falls back to the `default` namespace when POD_NAMESPACE is unset", function _defaultNamespaceFallback()
	{
		process.env.WATCH_NAMESPACE = "oc-acme";
		// POD_NAMESPACE unset → fallback host is `default`, never `opencrane-system`.
		const config = _LoadOperatorConfig();
		expect(config.mcpGatewayUrl).toBe("http://opencrane-mcp-gateway.default.svc:8080");
		expect(config.controlPlaneInternalUrl).toContain(".default.svc:");
	});
});

describe("_LoadOperatorConfig trusted-proxy fail-closed wiring (OC-2 / CONN.4)", function _trustedProxySuite()
{
	let _saved: NodeJS.ProcessEnv;

	beforeEach(function _save()
	{
		_saved = process.env;
		// WATCH_NAMESPACE is mandatory; set it so config load reaches the build step.
		process.env = { ..._BASE_ENV, WATCH_NAMESPACE: "oc-acme" };
	});

	afterEach(function _restore()
	{
		process.env = _saved;
	});

	it("resolves an unset GATEWAY_TRUSTED_PROXIES to trust-nothing (never trust-all)", function _unset()
	{
		// GATEWAY_TRUSTED_PROXIES intentionally absent from _BASE_ENV.
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual([]);
		expect(config.gatewayTrustNothing).toBe(true);
	});

	it("resolves an empty GATEWAY_TRUSTED_PROXIES to trust-nothing", function _empty()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "  ";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual([]);
		expect(config.gatewayTrustNothing).toBe(true);
	});

	it("parses a configured CIDR allowlist and clears the trust-nothing flag", function _configured()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "10.55.128.0/17, 192.168.1.0/24";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual(["10.55.128.0/17", "192.168.1.0/24"]);
		expect(config.gatewayTrustNothing).toBe(false);
	});

	it("crashes config load on a malformed CIDR rather than shifting the trust boundary", function _malformed()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "10.55.128.0/99";
		expect(function _load() { _LoadOperatorConfig(); }).toThrow(/invalid IP\/CIDR entry/);
	});
});

describe("_LoadOperatorConfig auto trusted-proxy derivation (task_845dd617)", function _autoSuite()
{
	let _saved: NodeJS.ProcessEnv;

	beforeEach(function _save()
	{
		_saved = process.env;
		process.env = { ..._BASE_ENV, WATCH_NAMESPACE: "oc-acme" };
	});

	afterEach(function _restore()
	{
		process.env = _saved;
	});

	it("expands `auto` to the POD_IP /14 pod range by default", function _autoDefault()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto";
		process.env.POD_IP = "10.8.3.5";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual(["10.8.0.0/14"]);
		expect(config.gatewayTrustNothing).toBe(false);
	});

	it("honours GATEWAY_TRUSTED_PROXIES_AUTO_MASK for the derived prefix", function _autoMask()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto";
		process.env.POD_IP = "172.20.55.7";
		process.env.GATEWAY_TRUSTED_PROXIES_AUTO_MASK = "16";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual(["172.20.0.0/16"]);
	});

	it("drops `auto` to trust-nothing when POD_IP is missing (stays fail-closed, never trust-all)", function _missingPodIp()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto";
		// POD_IP intentionally absent.
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual([]);
		expect(config.gatewayTrustNothing).toBe(true);
	});

	it("drops `auto` to trust-nothing when POD_IP is not a valid IPv4 address", function _invalidPodIp()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto";
		process.env.POD_IP = "fd00::1";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustNothing).toBe(true);
	});

	it("keeps explicit CIDRs when `auto` derivation fails (partial fallback, no trust-all)", function _mixedFallback()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto, 10.0.0.0/8";
		// POD_IP absent ⇒ the auto token is dropped, the explicit CIDR remains.
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual(["10.0.0.0/8"]);
		expect(config.gatewayTrustNothing).toBe(false);
	});

	it("falls back to the default /14 when the mask override is not a canonical integer", function _badMask()
	{
		process.env.GATEWAY_TRUSTED_PROXIES = "auto";
		process.env.POD_IP = "10.8.3.5";
		process.env.GATEWAY_TRUSTED_PROXIES_AUTO_MASK = "0xff";
		const config = _LoadOperatorConfig();
		expect(config.gatewayTrustedProxies).toEqual(["10.8.0.0/14"]);
	});
});
