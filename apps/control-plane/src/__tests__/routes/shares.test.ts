import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sharesRouter } from "../../routes/shares.js";
import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess } from "../../core/grants/grant-compiler.types.js";

// Drive the least-privilege gate directly: the route calls compile(caller, …) to decide
// what the caller holds. Default = holds nothing, so the gate denies unless a test allows.
vi.mock("../../core/grants/grant-compiler.js", () => ({
  compile: vi.fn().mockResolvedValue([]),
}));

/** A captured grant.create call's data, for assertions. */
let _lastCreate: Record<string, unknown> | null = null;

/** Build a Prisma stub for the shares route. */
function _prisma(opts: {
  mcpServerIds?: string[];
  skillBundleIds?: string[];
  groupIds?: string[];
  existingShare?: Record<string, unknown> | null;
  myShares?: Array<Record<string, unknown>>;
  grantById?: Record<string, { id: string; sharedBy: string | null }>;
} = {}): { prisma: PrismaClient; deleted: string[] }
{
  const deleted: string[] = [];
  const prisma = {
    mcpServer: { findUnique: vi.fn(async (a: { where: { id: string } }) => (opts.mcpServerIds ?? []).includes(a.where.id) ? { id: a.where.id } : null) },
    skillBundle: { findUnique: vi.fn(async (a: { where: { id: string } }) => (opts.skillBundleIds ?? []).includes(a.where.id) ? { id: a.where.id } : null) },
    group: { findUnique: vi.fn(async (a: { where: { id: string } }) => (opts.groupIds ?? []).includes(a.where.id) ? { id: a.where.id } : null) },
    grant: {
      findFirst: vi.fn(async () => opts.existingShare ?? null),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { _lastCreate = a.data; return { ...a.data, id: "grant-new", createdAt: new Date("2026-06-25T00:00:00Z") }; }),
      findMany: vi.fn(async () => (opts.myShares ?? []).map(s => ({ scope: "personal", note: null, sharedBy: "caller-1", createdAt: new Date("2026-06-25T00:00:00Z"), subjectType: "user", subjectId: "x", payloadType: "mcp-server", payloadId: "y", id: "z", ...s }))),
      findUnique: vi.fn(async (a: { where: { id: string } }) => opts.grantById?.[a.where.id] ?? null),
      delete: vi.fn(async (a: { where: { id: string } }) => { deleted.push(a.where.id); return {}; }),
    },
  } as unknown as PrismaClient;
  return { prisma, deleted };
}

/** Build a test app mounting the shares router, injecting a caller session (or none). */
function _app(prisma: PrismaClient, caller?: string): Express
{
  const app = express();
  app.use(express.json());
  app.use(function _injectSession(req: Request, _res: Response, next: NextFunction)
  {
    (req as unknown as { session?: unknown }).session = caller ? { authUser: { sub: caller } } : {};
    next();
  });
  app.use("/api/v1/shares", sharesRouter(prisma));
  return app;
}

describe("sharesRouter — inter-user sharing (S4)", function _suite()
{
  // Reset the gate between tests so a queued `mockResolvedValueOnce` in a test that never
  // reaches the gate (e.g. payload-not-found short-circuits earlier) can't leak forward.
  beforeEach(function _resetGate() { vi.mocked(compile).mockReset().mockResolvedValue([]); _lastCreate = null; });

  it("401s when the caller is unauthenticated", async function _unauth()
  {
    const { prisma } = _prisma({ mcpServerIds: ["mcp-1"] });
    const res = await request(_app(prisma)).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "user", recipientId: "bob" });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid body (bad enum / missing fields)", async function _bad()
  {
    const { prisma } = _prisma();
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "nope", payloadId: "", recipientType: "user", recipientId: "" });
    expect(res.status).toBe(400);
  });

  it("404s when the payload does not exist", async function _noPayload()
  {
    vi.mocked(compile).mockResolvedValueOnce([{ payloadId: "mcp-1", access: GrantCompilerAccess.Allow }] as never);
    const { prisma } = _prisma({ mcpServerIds: [] });
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "user", recipientId: "bob" });
    expect(res.status).toBe(404);
  });

  it("403s when the caller does not hold an Allow on the payload (least-privilege gate)", async function _gate()
  {
    vi.mocked(compile).mockResolvedValueOnce([]); // caller holds nothing
    const { prisma } = _prisma({ mcpServerIds: ["mcp-1"] });
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "user", recipientId: "bob" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("creates an Allow grant on the recipient when the caller holds the payload (201)", async function _create()
  {
    vi.mocked(compile).mockResolvedValueOnce([{ payloadId: "mcp-1", access: GrantCompilerAccess.Allow }] as never);
    const { prisma } = _prisma({ mcpServerIds: ["mcp-1"] });
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "user", recipientId: "bob" });
    expect(res.status).toBe(201);
    // Written as an Allow user-grant on the recipient, stamped with the sharer + cascade id.
    expect(_lastCreate).toMatchObject({ payloadType: "McpServer", payloadId: "mcp-1", subjectType: "User", subjectId: "bob", access: "Allow", sharedBy: "caller-1", mcpServerId: "mcp-1" });
    expect(res.body.recipientId).toBe("bob");
  });

  it("404s a group recipient that does not exist", async function _noGroup()
  {
    vi.mocked(compile).mockResolvedValueOnce([{ payloadId: "mcp-1", access: GrantCompilerAccess.Allow }] as never);
    const { prisma } = _prisma({ mcpServerIds: ["mcp-1"], groupIds: [] });
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "group", recipientId: "ghost" });
    expect(res.status).toBe(404);
  });

  it("is idempotent — an identical existing share is returned with 200, no duplicate", async function _idem()
  {
    vi.mocked(compile).mockResolvedValueOnce([{ payloadId: "mcp-1", access: GrantCompilerAccess.Allow }] as never);
    const { prisma } = _prisma({
      mcpServerIds: ["mcp-1"],
      existingShare: { id: "grant-existing", payloadType: "mcp-server", payloadId: "mcp-1", subjectType: "user", subjectId: "bob", scope: "personal", note: null, sharedBy: "caller-1", createdAt: new Date("2026-06-01T00:00:00Z") },
    });
    const res = await request(_app(prisma, "caller-1")).post("/api/v1/shares").send({ payloadType: "mcp-server", payloadId: "mcp-1", recipientType: "user", recipientId: "bob" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("grant-existing");
  });

  it("revoke deletes only a share the caller created; another's share 404s and is untouched", async function _revoke()
  {
    const { prisma, deleted } = _prisma({ grantById: { mine: { id: "mine", sharedBy: "caller-1" }, theirs: { id: "theirs", sharedBy: "someone-else" } } });

    const notMine = await request(_app(prisma, "caller-1")).delete("/api/v1/shares/theirs");
    expect(notMine.status).toBe(404);
    expect(deleted).not.toContain("theirs");

    const mine = await request(_app(prisma, "caller-1")).delete("/api/v1/shares/mine");
    expect(mine.status).toBe(200);
    expect(deleted).toContain("mine");
  });
});
