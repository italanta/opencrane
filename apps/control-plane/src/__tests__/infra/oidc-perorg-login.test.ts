import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock openid-client so buildLoginUrl runs without real network discovery. `discovery`
// echoes back the client_id it was called with so the test can assert which client (per-org
// vs masters) was selected; `buildAuthorizationUrl` captures the scope it was handed.
const _discoveryCalls: Array<{ clientId: string }> = [];
let _lastAuthParams: Record<string, unknown> = {};
// The client_id of the discovered config handed to authorizationCodeGrant — lets the
// completeLogin test assert the SAME client resolved at buildLoginUrl is used at token exchange.
let _grantClientId: string | undefined;
vi.mock("openid-client", function _mockClient()
{
  return {
    randomPKCECodeVerifier() { return "verifier"; },
    async calculatePKCECodeChallenge() { return "challenge"; },
    randomState() { return "state"; },
    randomNonce() { return "nonce"; },
    async discovery(_issuer: URL, clientId: string)
    {
      _discoveryCalls.push({ clientId });
      return { clientId } as unknown;
    },
    buildAuthorizationUrl(config: { clientId: string }, params: Record<string, unknown>)
    {
      _lastAuthParams = params;
      return new URL(`https://idp.test/authorize?client=${config.clientId}`);
    },
    async authorizationCodeGrant(config: { clientId: string })
    {
      _grantClientId = config.clientId;
      return { claims() { return { sub: "user-1", email: "u@acme.io", email_verified: true }; }, access_token: undefined, id_token: "id-tok" };
    },
    async fetchUserInfo(_config: unknown, _accessToken: string, sub: string)
    {
      return { sub };
    },
  };
});

import { ___CreateOidcAuthService } from "../../infra/auth/oidc.service.js";

/** Minimal OIDC env so the service is enabled and uses `cid` as the masters client. */
function _enableOidc(): void
{
  process.env.OIDC_ISSUER_URL = "https://idp.test";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_REDIRECT_URI = "https://platform.dev.opencrane.ai/api/v1/auth/callback";
  process.env.OIDC_SESSION_SECRET = "test-secret";
  process.env.OIDC_SCOPES = "openid email profile";
}

/** Clear the OIDC env between tests so config does not leak across cases. */
function _disableOidc(): void
{
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_SESSION_SECRET;
  delete process.env.OIDC_SCOPES;
}

/** A Request-like object on `host` with a save-able session. */
function _reqOnHost(host: string): Request
{
  const session: Record<string, unknown> = { save(cb: (err?: Error) => void) { cb(); } };
  return { headers: { "x-forwarded-host": host }, session } as unknown as Request;
}

/** Prisma stub whose clusterTenant.findUnique returns `row`. */
function _prismaReturning(row: Record<string, unknown> | null): PrismaClient
{
  return { clusterTenant: { findUnique: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;
}

describe("OidcAuthService.buildLoginUrl — per-org client resolution (S3b)", function _suite()
{
  beforeEach(function _reset() { _enableOidc(); _discoveryCalls.length = 0; _lastAuthParams = {}; });
  afterEach(_disableOidc);

  it("uses the per-org client + org-restriction scope for a provisioned org host", async function _perOrg()
  {
    const prisma = _prismaReturning({ name: "acme", zitadelClientId: "client-acme", zitadelOrgId: "org-acme", zitadelRedirectUri: null });
    const service = ___CreateOidcAuthService(pino({ enabled: false }), prisma);
    const req = _reqOnHost("acme.dev.opencrane.ai");

    const url = await service.buildLoginUrl(req, "/");

    // Discovery + the authorization request both used the org's client, not the masters one.
    expect(_discoveryCalls).toEqual([{ clientId: "client-acme" }]);
    expect(url).toContain("client=client-acme");
    // The Zitadel org-restriction scope is appended so only acme's user pool may log in.
    expect(_lastAuthParams.scope).toBe("openid email profile urn:zitadel:iam:org:id:org-acme");
    // completeLogin must reuse the same client → the per-org client_id is recorded in the flow.
    expect((req.session as { oidcFlow?: { clientId?: string } }).oidcFlow?.clientId).toBe("client-acme");
  });

  it("uses the masters client (no org scope) for the platform host", async function _platform()
  {
    const prisma = _prismaReturning(null);
    const service = ___CreateOidcAuthService(pino({ enabled: false }), prisma);
    const req = _reqOnHost("platform.dev.opencrane.ai");

    const url = await service.buildLoginUrl(req, "/");

    // "platform" is not a provisioned CT → fall through to the masters client; no org scope.
    expect(_discoveryCalls).toEqual([{ clientId: "cid" }]);
    expect(url).toContain("client=cid");
    expect(_lastAuthParams.scope).toBe("openid email profile");
    expect((req.session as { oidcFlow?: { clientId?: string } }).oidcFlow?.clientId).toBeUndefined();
  });

  it("falls through to the masters client for an unprovisioned org host (fail-closed)", async function _unprovisioned()
  {
    // The CT exists but has no client_id yet (mid-provisioning / unconfigured Zitadel).
    const prisma = _prismaReturning({ name: "acme", zitadelClientId: null, zitadelOrgId: null, zitadelRedirectUri: null });
    const service = ___CreateOidcAuthService(pino({ enabled: false }), prisma);
    const req = _reqOnHost("acme.dev.opencrane.ai");

    const url = await service.buildLoginUrl(req, "/");

    expect(_discoveryCalls).toEqual([{ clientId: "cid" }]);
    expect(url).toContain("client=cid");
    expect(_lastAuthParams.scope).toBe("openid email profile");
  });
});

/** A callback Request carrying an in-flight oidcFlow (with optional per-org clientId). */
function _callbackReq(flowClientId: string | undefined): Request
{
  const session: Record<string, unknown> = {
    oidcFlow: { codeVerifier: "verifier", state: "state", nonce: "nonce", returnTo: "/", ...(flowClientId ? { clientId: flowClientId } : {}) },
    regenerate(cb: (err?: Error) => void) { cb(); },
    save(cb: (err?: Error) => void) { cb(); },
  };
  return { headers: { "x-forwarded-host": "acme.dev.opencrane.ai" }, originalUrl: "/api/v1/auth/callback?code=c&state=state", protocol: "https", session } as unknown as Request;
}

describe("OidcAuthService.completeLogin — token exchange uses the per-org client (S3b)", function _completeSuite()
{
  beforeEach(function _reset() { _enableOidc(); _discoveryCalls.length = 0; _grantClientId = undefined; });
  afterEach(_disableOidc);

  it("exchanges the code against the per-org client recorded at buildLoginUrl", async function _perOrgExchange()
  {
    const service = ___CreateOidcAuthService(pino({ enabled: false }), _prismaReturning(null));

    await service.completeLogin(_callbackReq("client-acme"));

    // The token exchange used the per-org client, not the masters one — the auth-request
    // and token-exchange client_ids match, so the issued code is honoured.
    expect(_grantClientId).toBe("client-acme");
  });

  it("exchanges the code against the masters client when no per-org client was recorded", async function _mastersExchange()
  {
    const service = ___CreateOidcAuthService(pino({ enabled: false }), _prismaReturning(null));

    await service.completeLogin(_callbackReq(undefined));

    expect(_grantClientId).toBe("cid");
  });
});
