import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedDocument } from "../domain/harvesting-agents/harvesting-agent.types.js";
import { _IngestDocuments } from "../ingestion.js";

/** Silent logger used by ingestion tests. */
const TEST_LOGGER = pino({ level: "silent" });

/** Cognee endpoint used in all ingestion tests. */
const TEST_COGNEE_ENDPOINT = "http://cognee.test";

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
    scope: "team",
    subject: "platform",
    shareList: ["user1@example.com", "user2@example.com"],
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
 * Build a fetch spy that resolves as a successful Cognee ingest response.
 */
function _BuildSuccessFetchSpy(): ReturnType<typeof vi.fn>
{
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

describe("harvesting ingestion schema v2", function _suite()
{
  afterEach(function _afterEach()
  {
    vi.unstubAllGlobals();
  });

  it("pushes org index schema v2 document to Cognee on first ingest", async function _test()
  {
    const document = _BuildDocument();
    const fetchSpy = _BuildSuccessFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await _IngestDocuments(TEST_COGNEE_ENDPOINT, [document], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TEST_COGNEE_ENDPOINT}/v1/add`);
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string) as {
      data: string;
      dataset_name: string;
      metadata: Record<string, unknown>;
    };
    expect(body.data).toBe(document.content);
    expect(body.dataset_name).toBe("team/platform");
    expect(body.metadata.source).toBe("slack");
    expect(body.metadata.acl_origin).toBe("slack:channel-membership");
    expect(body.metadata.sensitivity_tags).toEqual(["slack", "internal"]);
    expect(body.metadata.scope).toBe("team");
    expect(body.metadata.subject).toBe("platform");
    expect(body.metadata.share_list).toEqual(["user1@example.com", "user2@example.com"]);
    expect(body.metadata.confidentiality).toBe("internal");
    expect(body.metadata.source_updated_at).toBe("2024-05-30T12:08:37.100Z");
  });

  it("rejects non-conformant org index documents before calling Cognee", async function _test()
  {
    const invalidDocument = _BuildDocument({
      freshnessRecordedAt: "not-a-timestamp",
    });
    const fetchSpy = _BuildSuccessFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await _IngestDocuments(TEST_COGNEE_ENDPOINT, [invalidDocument], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 0,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts failed documents when Cognee responds with an error status", async function _test()
  {
    const document = _BuildDocument();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await _IngestDocuments(TEST_COGNEE_ENDPOINT, [document], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 0,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("resolves dataset as 'org' when no scope fields are set", async function _test()
  {
    const document = _BuildDocument({
      scope: undefined,
      subject: undefined,
      shareList: undefined,
    });
    const fetchSpy = _BuildSuccessFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);

    await _IngestDocuments(TEST_COGNEE_ENDPOINT, [document], TEST_LOGGER);

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      dataset_name: string;
    };
    expect(body.dataset_name).toBe("org");
  });

  it("processes multiple documents and tallies counts correctly", async function _test()
  {
    const valid = _BuildDocument();
    const invalid = _BuildDocument({ freshnessRecordedAt: "bad" });
    const fetchSpy = _BuildSuccessFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await _IngestDocuments(TEST_COGNEE_ENDPOINT, [valid, invalid], TEST_LOGGER);

    expect(result).toEqual({
      upsertedCount: 1,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

