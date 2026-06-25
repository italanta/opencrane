import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { resourceSharesRouter } from "../../routes/resource-shares.js";

/** Capture of the last group.create / group.update payload. */
let _lastWrite: Record<string, unknown> | null = null;

/** Build a Prisma stub around the group mirror for resource-share tests. */
function _prisma(opts: { byName?: Record<string, { id: string; name: string; members: string[] }>; byId?: Record<string, { id: string; name: string; members: string[] }>; all?: Array<{ id: string; name: string; members: string[] }> } = {}): PrismaClient
{
  return {
    group: {
      findUnique: vi.fn(async (a: { where: { name?: string; id?: string } }) => (a.where.name ? opts.byName?.[a.where.name] : opts.byId?.[a.where.id ?? ""]) ?? null),
      findMany: vi.fn(async () => opts.all ?? []),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { _lastWrite = a.data; return { id: "grp-new", name: a.data.name, members: a.data.members }; }),
      update: vi.fn(async (a: { where: { name?: string; id?: string }; data: Record<string, unknown> }) => { _lastWrite = a.data; return { id: "grp-x", name: "resource:file:f1", members: a.data.members }; }),
    },
  } as unknown as PrismaClient;
}

/** Build a test app mounting the resource-shares router with an injected caller session. */
function _app(prisma: PrismaClient, caller?: string): Express
{
  const app = express();
  app.use(express.json());
  app.use(function _session(req: Request, _res: Response, next: NextFunction)
  {
    (req as unknown as { session?: unknown }).session = caller ? { authUser: { sub: caller } } : {};
    next();
  });
  app.use("/api/v1/resource-shares", resourceSharesRouter(prisma));
  return app;
}

describe("resourceSharesRouter — direct file/chat sharing → resource group (S4c)", function _suite()
{
  it("401s an unauthenticated caller", async function _unauth()
  {
    const res = await request(_app(_prisma())).post("/api/v1/resource-shares").send({ resourceType: "file", resourceId: "f1", recipientSubject: "bob" });
    expect(res.status).toBe(401);
  });

  it("400s an invalid body", async function _bad()
  {
    const res = await request(_app(_prisma(), "alice")).post("/api/v1/resource-shares").send({ resourceType: "nope", resourceId: "", recipientSubject: "" });
    expect(res.status).toBe(400);
  });

  it("creates the resource group with the sharer + recipient on first share (201)", async function _create()
  {
    _lastWrite = null;
    const res = await request(_app(_prisma(), "alice")).post("/api/v1/resource-shares").send({ resourceType: "file", resourceId: "f1", recipientSubject: "bob" });
    expect(res.status).toBe(201);
    // Personal-scoped group named for the resource, members = sharer + recipient.
    expect(_lastWrite).toMatchObject({ name: "resource:file:f1", scope: "Personal" });
    expect((_lastWrite as Record<string, unknown> | null)?.members).toEqual(["alice", "bob"]);
    expect(res.body.members).toEqual(["alice", "bob"]);
  });

  it("adds the recipient to an existing group when the caller is a member (200)", async function _addMember()
  {
    _lastWrite = null;
    const prisma = _prisma({ byName: { "resource:file:f1": { id: "g1", name: "resource:file:f1", members: ["alice"] } } });
    const res = await request(_app(prisma, "alice")).post("/api/v1/resource-shares").send({ resourceType: "file", resourceId: "f1", recipientSubject: "bob" });
    expect(res.status).toBe(200);
    expect((_lastWrite as Record<string, unknown> | null)?.members).toEqual(["alice", "bob"]);
  });

  it("403s when a non-member tries to share an existing resource (least-privilege)", async function _gate()
  {
    const prisma = _prisma({ byName: { "resource:file:f1": { id: "g1", name: "resource:file:f1", members: ["alice"] } } });
    // carol is not a member → cannot share alice's resource.
    const res = await request(_app(prisma, "carol")).post("/api/v1/resource-shares").send({ resourceType: "file", resourceId: "f1", recipientSubject: "bob" });
    expect(res.status).toBe(403);
  });

  it("lists only the resource shares the caller is a member of", async function _list()
  {
    const prisma = _prisma({ all: [
      { id: "g1", name: "resource:file:f1", members: ["alice", "bob"] },
      { id: "g2", name: "resource:chat:c9", members: ["carol"] },
    ] });
    const res = await request(_app(prisma, "alice")).get("/api/v1/resource-shares");
    expect(res.status).toBe(200);
    expect(res.body.map((s: { resourceId: string }) => s.resourceId)).toEqual(["f1"]);
  });

  it("revokes a recipient only from a group the caller is in; otherwise 404", async function _revoke()
  {
    const prisma = _prisma({ byId: { g1: { id: "g1", name: "resource:file:f1", members: ["alice", "bob"] }, g2: { id: "g2", name: "resource:file:f2", members: ["carol"] } } });

    const notMine = await request(_app(prisma, "alice")).delete("/api/v1/resource-shares/g2/recipients/carol");
    expect(notMine.status).toBe(404);

    _lastWrite = null;
    const mine = await request(_app(prisma, "alice")).delete("/api/v1/resource-shares/g1/recipients/bob");
    expect(mine.status).toBe(200);
    expect((_lastWrite as Record<string, unknown> | null)?.members).toEqual(["alice"]);
  });
});
