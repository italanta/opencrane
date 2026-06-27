import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _RequireOrgAdmin } from "@opencrane/infra-auth";

/** OIDC + token env vars that decide `_IsDevAuthMode`; cleared/restored around each test. */
const _AUTH_ENV = ["OPENCRANE_API_TOKEN", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET"] as const;

/** Build a mock (req, res, next) trio capturing the status/body and whether next ran. */
function _mock(session?: { isOrgAdmin: boolean }): { req: Request; res: Response; next: NextFunction; out: { status?: number; body?: unknown; nexted: boolean } }
{
  const out: { status?: number; body?: unknown; nexted: boolean } = { nexted: false };
  const req = { session: session ? { authUser: { isOrgAdmin: session.isOrgAdmin } } : undefined } as unknown as Request;
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  const next: NextFunction = () => { out.nexted = true; };
  return { req, res, next, out };
}

describe("_RequireOrgAdmin (P0.5)", function _suite()
{
  const _saved: Record<string, string | undefined> = {};

  beforeEach(function _clearEnv()
  {
    for (const key of _AUTH_ENV) { _saved[key] = process.env[key]; delete process.env[key]; }
  });

  afterEach(function _restoreEnv()
  {
    for (const key of _AUTH_ENV) { if (_saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = _saved[key]; } }
    vi.unstubAllEnvs();
  });

  it("allows a verified org admin", function _allowAdmin()
  {
    const { req, res, next, out } = _mock({ isOrgAdmin: true });
    _RequireOrgAdmin()(req, res, next);
    expect(out.nexted).toBe(true);
    expect(out.status).toBeUndefined();
  });

  it("rejects a session that is not an org admin with 403", function _denyNonAdmin()
  {
    const { req, res, next, out } = _mock({ isOrgAdmin: false });
    _RequireOrgAdmin()(req, res, next);
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "FORBIDDEN_NOT_ORG_ADMIN" });
  });

  it("allows an unauthenticated request under dev mode (no OIDC, no API token)", function _devOpen()
  {
    // env cleared in beforeEach ⇒ _IsDevAuthMode() is true.
    const { req, res, next, out } = _mock();
    _RequireOrgAdmin()(req, res, next);
    expect(out.nexted).toBe(true);
  });

  it("fails closed for an unauthenticated request when real auth is configured", function _failClosed()
  {
    process.env.OPENCRANE_API_TOKEN = "ci-token";
    const { req, res, next, out } = _mock();
    _RequireOrgAdmin()(req, res, next);
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(403);
  });
});
