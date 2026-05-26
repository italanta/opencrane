import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { NormalizedDocument } from "../domain/harvesting-agents/harvesting-agent.types.js";
import { _ComputeContentHash } from "../connectors/slack.connector.js";
import { _IngestDocuments } from "../ingestion.js";

/** Silent logger used by ingestion tests. */
const TEST_LOGGER = pino({ level: "silent" });

/**
 * Build a valid org index schema v2 document with optional override fields.
 *
 * @param overrides - Partial field overrides for scenario-specific assertions.
 * @returns Valid normalized document fixture.
 */
function _BuildDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument
{
  return {
    source: "slack",
    sourceId: "C123/1717171717.000100",
    owner: "owner@example.com",
    teamScope: "platform",
    departmentScope: "engineering",
    projectScope: "opencrane",
    sensitivityTags: ["slack", "internal"],
    title: "Release checklist",
    content: "Ship the awareness schema v2 rollout.",
    confidentiality: "internal",
    jurisdiction: "global",
    retentionClass: "standard",
    aclOrigin: "slack:channel-membership",
    sourceUpdatedAt: "2024-05-30T12:08:37.100Z",
    freshnessRecordedAt: "2024-05-30T12:10:00.000Z",
    ingestCursor: "1717070917.000100",
    ...overrides,
  };
}

/**
 * Build the minimal Prisma stub required by the ingestion pipeline.
 *
 * @returns Prisma-like stub plus spy handles for assertions.
 */
function _BuildPrismaStub(): {
  prisma: {
    orgDocument: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };
  findUniqueSpy: ReturnType<typeof vi.fn>;
  upsertSpy: ReturnType<typeof vi.fn>;
}
{
  const findUniqueSpy = vi.fn().mockResolvedValue(null);
  const upsertSpy = vi.fn().mockResolvedValue({});

  return {
    prisma: {
      orgDocument: {
        findUnique: findUniqueSpy,
        upsert: upsertSpy,
      },
    },
    findUniqueSpy,
    upsertSpy,
  };
}

describe("harvesting ingestion schema v2", function _suite()
{
  it("persists org index schema v2 metadata during upsert", async function _test()
  {
    const document = _BuildDocument();
    const { prisma, findUniqueSpy, upsertSpy } = _BuildPrismaStub();

    const result = await _IngestDocuments(prisma as never, [document], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(findUniqueSpy).toHaveBeenCalledOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();

    const upsertArgs = upsertSpy.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };

    expect(upsertArgs.create.departmentScope).toBe("engineering");
    expect(upsertArgs.create.projectScope).toBe("opencrane");
    expect(upsertArgs.create.confidentiality).toBe("internal");
    expect(upsertArgs.create.aclOrigin).toBe("slack:channel-membership");
    expect((upsertArgs.create.sourceUpdatedAt as Date).toISOString()).toBe("2024-05-30T12:08:37.100Z");
    expect((upsertArgs.create.freshnessRecordedAt as Date).toISOString()).toBe("2024-05-30T12:10:00.000Z");
    expect(upsertArgs.update.ingestCursor).toBe("1717070917.000100");
  });

  it("rejects non-conformant org index documents before touching persistence", async function _test()
  {
    const invalidDocument = _BuildDocument({
      freshnessRecordedAt: "not-a-timestamp",
    });
    const { prisma, findUniqueSpy, upsertSpy } = _BuildPrismaStub();

    const result = await _IngestDocuments(prisma as never, [invalidDocument], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 0,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(findUniqueSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("updates rows when metadata changes even if document content is unchanged", async function _test()
  {
    const previousDocument = _BuildDocument();
    const nextDocument = _BuildDocument({
      confidentiality: "restricted",
    });
    const { prisma, upsertSpy } = _BuildPrismaStub();
    prisma.orgDocument.findUnique = vi.fn().mockResolvedValue({
      contentHash: _ComputeContentHash(previousDocument.content),
      owner: previousDocument.owner,
      teamScope: previousDocument.teamScope ?? null,
      departmentScope: previousDocument.departmentScope ?? null,
      projectScope: previousDocument.projectScope ?? null,
      sensitivityTags: previousDocument.sensitivityTags,
      title: previousDocument.title ?? null,
      confidentiality: previousDocument.confidentiality ?? null,
      jurisdiction: previousDocument.jurisdiction ?? null,
      retentionClass: previousDocument.retentionClass ?? null,
      aclOrigin: previousDocument.aclOrigin,
      sourceUpdatedAt: new Date(previousDocument.sourceUpdatedAt),
      ingestCursor: previousDocument.ingestCursor,
      embeddingReady: true,
    });

    const result = await _IngestDocuments(prisma as never, [nextDocument], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect((upsertSpy.mock.calls[0][0] as { update: Record<string, unknown> }).update.confidentiality).toBe("restricted");
    expect((upsertSpy.mock.calls[0][0] as { update: Record<string, unknown> }).update.embeddingReady).toBe(true);
  });

  it("skips rows when neither content nor metadata changed", async function _test()
  {
    const document = _BuildDocument();
    const { prisma, upsertSpy } = _BuildPrismaStub();
    prisma.orgDocument.findUnique = vi.fn().mockResolvedValue({
      contentHash: _ComputeContentHash(document.content),
      owner: document.owner,
      teamScope: document.teamScope ?? null,
      departmentScope: document.departmentScope ?? null,
      projectScope: document.projectScope ?? null,
      sensitivityTags: document.sensitivityTags,
      title: document.title ?? null,
      confidentiality: document.confidentiality ?? null,
      jurisdiction: document.jurisdiction ?? null,
      retentionClass: document.retentionClass ?? null,
      aclOrigin: document.aclOrigin,
      sourceUpdatedAt: new Date(document.sourceUpdatedAt),
      ingestCursor: document.ingestCursor,
      embeddingReady: true,
    });

    const result = await _IngestDocuments(prisma as never, [document], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
