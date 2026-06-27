import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ___LoadOidcAuthConfig } from "@opencrane/infra-auth";

/** OIDC env vars this suite mutates, snapshotted so each test starts clean. */
const _ENV_KEYS = ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET", "OIDC_COOKIE_SECURE", "NODE_ENV", "OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL"] as const;

describe("___LoadOidcAuthConfig — cookieSecure fail-closed", function _suite()
{
	/** Saved env values restored after each test. */
	const saved: Record<string, string | undefined> = {};

	beforeEach(function _snapshot()
	{
		for (const key of _ENV_KEYS)
		{
			saved[key] = process.env[key];
			delete process.env[key];
		}
		// Minimal valid OIDC config so the loader returns the enabled branch.
		process.env.OIDC_ISSUER_URL = "https://idp.example.com";
		process.env.OIDC_CLIENT_ID = "cp";
		process.env.OIDC_SESSION_SECRET = "secret";
	});

	afterEach(function _restore()
	{
		for (const key of _ENV_KEYS)
		{
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("forces Secure in production even when the redirect URI is http", function _prodForces()
	{
		process.env.NODE_ENV = "production";
		process.env.OIDC_REDIRECT_URI = "http://cp.internal/callback";
		expect(___LoadOidcAuthConfig().cookieSecure).toBe(true);
	});

	it("honours an explicit OIDC_COOKIE_SECURE=false even in production", function _explicitWins()
	{
		process.env.NODE_ENV = "production";
		process.env.OIDC_REDIRECT_URI = "https://cp.example.com/callback";
		process.env.OIDC_COOKIE_SECURE = "false";
		expect(___LoadOidcAuthConfig().cookieSecure).toBe(false);
	});

	it("infers from the redirect-URI scheme outside production", function _devInfers()
	{
		process.env.OIDC_REDIRECT_URI = "http://localhost:8080/callback";
		expect(___LoadOidcAuthConfig().cookieSecure).toBe(false);
		process.env.OIDC_REDIRECT_URI = "https://cp.example.com/callback";
		expect(___LoadOidcAuthConfig().cookieSecure).toBe(true);
	});

	it("defaults the platform-operator seed email to empty when unset (fail-closed)", function _seedDefaultEmpty()
	{
		process.env.OIDC_REDIRECT_URI = "https://cp.example.com/callback";
		expect(___LoadOidcAuthConfig().platformOperatorSeedEmail).toBe("");
	});

	it("reads OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL, lowercased and trimmed", function _seedNormalised()
	{
		process.env.OIDC_REDIRECT_URI = "https://cp.example.com/callback";
		process.env.OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL = "  Owner@Cluster.Example  ";
		expect(___LoadOidcAuthConfig().platformOperatorSeedEmail).toBe("owner@cluster.example");
	});
});
