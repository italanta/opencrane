import { describe, expect, it } from "vitest";

import type { NormalizedDocument } from "../domain/harvesting-agents/harvesting-agent.types.js";
import { _ValidateOrgIndexDocument } from "../org-index-schema-v2.js";

/**
 * Build a valid org index schema v2 document for validator tests.
 *
 * @param overrides - Partial overrides for scenario-specific cases.
 * @returns Valid normalized document fixture.
 */
function _BuildDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument
{
  return {
    source: "slack",
    sourceId: "C123/1717171717.000100",
    owner: "owner@example.com",
    sensitivityTags: ["slack"],
    content: "Schema validation fixture",
    aclOrigin: "slack:channel-membership",
    sourceUpdatedAt: "2024-05-30T12:08:37.100Z",
    freshnessRecordedAt: "2024-05-30T12:10:00.000Z",
    ingestCursor: "1717070917.000100",
    ...overrides,
  };
}

describe("org index schema v2 validator", function _suite()
{
  it("rejects locale-style timestamps that are not strict ISO-8601 UTC strings", function _test()
  {
    const result = _ValidateOrgIndexDocument(_BuildDocument({
      sourceUpdatedAt: "Thu May 30 2024 12:08:37 GMT",
    }));

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      field: "sourceUpdatedAt",
      message: "must be an ISO-8601 timestamp string",
    });
  });

  it("rejects blank optional metadata fields when connectors provide them", function _test()
  {
    const result = _ValidateOrgIndexDocument(_BuildDocument({
      confidentiality: "",
    }));

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      field: "confidentiality",
      message: "must be omitted or provided as a non-empty string",
    });
  });
});
