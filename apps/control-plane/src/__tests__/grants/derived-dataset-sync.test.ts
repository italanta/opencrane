import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _SyncDerivedDatasetMembership } from "../../routes/tenants.js";

/** Capture of the membership rows written by a sync. */
let _written: Array<{ scope: string; subject: string }> | null = null;
/** Whether the Cognee permission endpoint was called. */
let _cogneeCalled = false;

/**
 * Build a Prisma stub: `group.findMany` drives the derivation, `tenantDatasetMembership.findMany`
 * is the persisted projection to diff against, and `$transaction` runs the callback inline while
 * recording the createMany payload + that deleteMany ran.
 */
function _prisma(groups: Array<{ scope: string; members: string[] }>, persisted: Array<{ scope: string; subject: string }>): PrismaClient
{
  const tdm = {
    findMany: vi.fn(async () => persisted),
    deleteMany: vi.fn(async () => ({ count: persisted.length })),
    createMany: vi.fn(async (a: { data: Array<{ scope: string; subject: string }> }) => { _written = a.data; return { count: a.data.length }; }),
  };
  const prisma = {
    group: { findMany: vi.fn(async () => groups) },
    tenantDatasetMembership: tdm,
    $transaction: vi.fn(async (fn: (tx: PrismaClient) => Promise<unknown>) => fn(prisma)),
  } as unknown as PrismaClient;
  return prisma;
}

describe("_SyncDerivedDatasetMembership — diff-gated derive→replace→Cognee (S4c.2)", function _suite()
{
  beforeEach(function _reset()
  {
    _written = null;
    _cogneeCalled = false;
    process.env.COGNEE_ENDPOINT = "https://cognee.test";
    vi.stubGlobal("fetch", vi.fn(async () => { _cogneeCalled = true; return { ok: true, status: 200 }; }));
  });
  afterEach(function _restore() { vi.unstubAllGlobals(); delete process.env.COGNEE_ENDPOINT; });

  it("is a no-op when the derived membership equals the persisted projection", async function _noop()
  {
    // Group puts alice in a Team with [alice,bob]; the persisted projection already matches.
    const prisma = _prisma(
      [{ scope: "Team", members: ["alice", "bob"] }],
      // Prisma returns the enum MEMBER NAME (PascalCase) for scope, not the @map'd DB value.
      [{ scope: "Org", subject: "default" }, { scope: "Team", subject: "alice" }, { scope: "Team", subject: "bob" }],
    );

    const result = await _SyncDerivedDatasetMembership(prisma, "acme", "alice");

    expect(result.changed).toBe(false);
    expect(_written).toBeNull();        // no row replacement
    expect(_cogneeCalled).toBe(false);  // no Cognee write on a no-op
  });

  it("replaces rows AND syncs Cognee when the derivation changed", async function _changed()
  {
    // Derivation yields a team membership the persisted projection lacks → must write + sync.
    const prisma = _prisma(
      [{ scope: "Team", members: ["alice", "bob"] }],
      [{ scope: "Org", subject: "default" }],
    );

    const result = await _SyncDerivedDatasetMembership(prisma, "acme", "alice");

    expect(result.changed).toBe(true);
    expect(_cogneeCalled).toBe(true);
    // The replacement rows carry the derived team members (+ the org singleton).
    expect(_written).toEqual(expect.arrayContaining([
      { tenant: "acme", scope: "Org", subject: "default" },
      { tenant: "acme", scope: "Team", subject: "alice" },
      { tenant: "acme", scope: "Team", subject: "bob" },
    ]));
  });

  it("updates the projection but skips Cognee when COGNEE_ENDPOINT is unset", async function _noCognee()
  {
    delete process.env.COGNEE_ENDPOINT;
    const prisma = _prisma([{ scope: "Team", members: ["alice"] }], [{ scope: "Org", subject: "default" }]);

    const result = await _SyncDerivedDatasetMembership(prisma, "acme", "alice");

    expect(result.changed).toBe(true);
    expect(_written).not.toBeNull();    // rows still replaced
    expect(_cogneeCalled).toBe(false);  // Cognee not deployed → no external write
  });
});
