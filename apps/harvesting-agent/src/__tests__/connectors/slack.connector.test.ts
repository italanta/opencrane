import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackConnector } from "../../connectors/slack.connector.js";
import { _ValidateOrgIndexDocument } from "../../org-index-schema-v2.js";

/** Silent logger used by connector tests. */
const TEST_LOGGER = pino({ level: "silent" });

describe("SlackConnector schema v2 normalization", function _suite()
{
  beforeEach(function _beforeEach()
  {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-30T12:10:00.000Z"));
  });

  afterEach(function _afterEach()
  {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("emits lineage and freshness metadata required by org index schema v2", async function _test()
  {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          {
            type: "message",
            user: "U123",
            text: "Awareness rollout ready",
            ts: "1717070917.100000",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const connector = new SlackConnector({
      botToken: "xoxb-test-token",
      channelIds: ["C123"],
      maxMessagesPerCycle: 10,
      syncIntervalMs: 1000,
    }, TEST_LOGGER);

    const result = await connector.sync(null);

    expect(result.errors).toEqual([]);
    expect(result.nextCursor).toBe("1717070917.100000");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      source: "slack",
      sourceId: "C123/1717070917.100000",
      aclOrigin: "slack:channel-membership",
      sourceUpdatedAt: "2024-05-30T12:08:37.100Z",
      freshnessRecordedAt: "2024-05-30T12:10:00.000Z",
      ingestCursor: "1717070917.100000",
    });
    expect(_ValidateOrgIndexDocument(result.documents[0]).valid).toBe(true);
  });

  it("drops messages whose Slack timestamp cannot be converted safely", async function _test()
  {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          {
            type: "message",
            user: "U123",
            text: "Bad timestamp payload",
            ts: "",
          },
        ],
      }),
    }));
    const connector = new SlackConnector({
      botToken: "xoxb-test-token",
      channelIds: ["C123"],
      maxMessagesPerCycle: 10,
      syncIntervalMs: 1000,
    }, TEST_LOGGER);

    const result = await connector.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.errors).toEqual([]);
  });
});
