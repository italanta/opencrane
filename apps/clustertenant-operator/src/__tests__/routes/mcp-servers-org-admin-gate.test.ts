import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpServersRouter } from "../../routes/mcp-servers.js";

/**
 * End-to-end check that `_RequireOrgAdmin` is actually wired onto the MCP catalogue
 * mutation routes (P0.5): create/update/delete are org-admin-only, reads stay open,
 * and the dev-mode/fail-closed posture matches the rest of the platform.
 */

/** Auth env that decides `_IsDevAuthMode`; cleared/restored around each test. */
const _AUTH_ENV = ["OPENCRANE_API_TOKEN", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET"] as const;

/**
 * Recording Prisma stub: every `prisma.<model>.<method>()` resolves to `[]` and is a
 * memoised spy keyed `model.method`, so a test can assert which calls the handler made
 * (e.g. that a denied request never reached `mcpServer.delete`).
 */
function _mockPrisma(): { prisma: PrismaClient; spies: Record<string, ReturnType<typeof vi.fn>> }
{
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const prisma = new Proxy({}, {
    get(_t, model)
    {
      return new Proxy({}, {
        get(_t2, method)
        {
          const key = `${String(model)}.${String(method)}`;
          return (spies[key] ??= vi.fn().mockResolvedValue([]));
        },
      });
    },
  }) as unknown as PrismaClient;
  return { prisma, spies };
}

/** Mount the router, optionally seeding a session user (mirrors the OIDC session shape). */
function _buildApp(prisma: PrismaClient, user?: { isOrgAdmin: boolean }): Express
{
  const app = express();
  app.use(express.json());
  if (user)
  {
    app.use(function _seedSession(req, _res, next) { (req as unknown as { session: { authUser: { isOrgAdmin: boolean } } }).session = { authUser: user }; next(); });
  }
  app.use("/api/v1/mcp-servers", mcpServersRouter(prisma));
  return app;
}

describe("mcp-servers router — _RequireOrgAdmin gate (P0.5)", function _suite()
{
  const _saved: Record<string, string | undefined> = {};

  /** Snapshot then clear the auth env so each case controls the dev-mode/fail-closed posture. */
  beforeEach(function _clearEnv()
  {
    for (const key of _AUTH_ENV) { _saved[key] = process.env[key]; delete process.env[key]; }
  });

  /** Restore the auth env captured in `beforeEach` so cases stay isolated. */
  afterEach(function _restoreEnv()
  {
    for (const key of _AUTH_ENV) { if (_saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = _saved[key]; } }
  });

  it("allows reads for a non-admin session (GET is not gated)", async function _readsOpen()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: false })).get("/api/v1/mcp-servers");

    expect(res.status).toBe(200);
    expect(spies["mcpServer.findMany"]).toHaveBeenCalled();
  });

  it("denies create for a non-admin session and never reaches the handler", async function _denyCreate()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: false }))
      .post("/api/v1/mcp-servers").send({ name: "x", endpoint: "https://e", transport: "streamable-http" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN_NOT_ORG_ADMIN" });
    expect(spies["mcpServer.create"]).toBeUndefined();
  });

  it("denies update for a non-admin session and never reaches the handler", async function _denyUpdate()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: false }))
      .put("/api/v1/mcp-servers/srv-1").send({ name: "x" });

    expect(res.status).toBe(403);
    expect(spies["mcpServer.update"]).toBeUndefined();
  });

  it("denies delete for a non-admin session and never reaches the handler", async function _denyDelete()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: false })).delete("/api/v1/mcp-servers/srv-1");

    expect(res.status).toBe(403);
    expect(spies["mcpServer.delete"]).toBeUndefined();
  });

  it("lets an org-admin session through the delete gate to the handler", async function _allowDelete()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: true })).delete("/api/v1/mcp-servers/srv-1");

    expect(res.status).not.toBe(403);
    expect(spies["mcpServer.delete"]).toHaveBeenCalled();
  });

  it("returns 400 when an org-admin omits the required scope on create", async function _missingScope()
  {
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma, { isOrgAdmin: true }))
      .post("/api/v1/mcp-servers").send({ name: "x", endpoint: "https://e", transport: "streamable-http" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", error: "scope is required" });
    expect(spies["mcpServer.create"]).toBeUndefined();
  });

  it("opens the gate under dev mode when no session and no real auth is configured", async function _devOpen()
  {
    const { prisma } = _mockPrisma();
    const res = await request(_buildApp(prisma)).delete("/api/v1/mcp-servers/srv-1");

    expect(res.status).not.toBe(403);
  });

  it("fails closed for an unauthenticated mutation when real auth is configured", async function _failClosed()
  {
    process.env.OPENCRANE_API_TOKEN = "ci-token";
    const { prisma, spies } = _mockPrisma();
    const res = await request(_buildApp(prisma)).delete("/api/v1/mcp-servers/srv-1");

    expect(res.status).toBe(403);
    expect(spies["mcpServer.delete"]).toBeUndefined();
  });
});
