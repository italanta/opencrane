import { describe, expect, it } from "vitest";

import { _OriginAllowed } from "../origin.js";

describe("_OriginAllowed (CSWSH guard)", () =>
{
  const allow = ["https://acme.opencrane.ai", "https://ai.client-co.com"];

  it("allows an exact allowlisted origin", () =>
  {
    expect(_OriginAllowed("https://acme.opencrane.ai", allow)).toBe(true);
    expect(_OriginAllowed("https://ai.client-co.com", allow)).toBe(true);
  });

  it("rejects a non-allowlisted origin", () =>
  {
    expect(_OriginAllowed("https://evil.example.com", allow)).toBe(false);
  });

  it("rejects a scheme or port mismatch (no fuzzy matching)", () =>
  {
    expect(_OriginAllowed("http://acme.opencrane.ai", allow)).toBe(false);
    expect(_OriginAllowed("https://acme.opencrane.ai:8443", allow)).toBe(false);
    expect(_OriginAllowed("https://acme.opencrane.ai/", allow)).toBe(false);
  });

  it("fails closed on a missing/empty origin", () =>
  {
    expect(_OriginAllowed(undefined, allow)).toBe(false);
    expect(_OriginAllowed("", allow)).toBe(false);
  });

  it("fails closed when the allowlist is empty", () =>
  {
    expect(_OriginAllowed("https://acme.opencrane.ai", [])).toBe(false);
  });
});
