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

  describe("base-domain matching (every-org case)", () =>
  {
    const bases = ["opencrane.ai"];

    it("allows any single-label org host under a configured base", () =>
    {
      expect(_OriginAllowed("https://acme.opencrane.ai", [], bases)).toBe(true);
      expect(_OriginAllowed("https://beta.opencrane.ai", [], bases)).toBe(true);
    });

    it("allows the base apex itself", () =>
    {
      expect(_OriginAllowed("https://opencrane.ai", [], bases)).toBe(true);
    });

    it("rejects a multi-label subdomain (per-user hosts no longer exist)", () =>
    {
      expect(_OriginAllowed("https://mike.acme.opencrane.ai", [], bases)).toBe(false);
    });

    it("rejects a look-alike suffix and a non-https scheme", () =>
    {
      expect(_OriginAllowed("https://evilopencrane.ai", [], bases)).toBe(false);
      expect(_OriginAllowed("https://acme.opencrane.ai.evil.com", [], bases)).toBe(false);
      expect(_OriginAllowed("http://acme.opencrane.ai", [], bases)).toBe(false);
      expect(_OriginAllowed("https://acme.opencrane.ai:8443", [], bases)).toBe(false);
    });

    it("still honours an exact vanity allowlist alongside base domains", () =>
    {
      expect(_OriginAllowed("https://ai.client-co.com", ["https://ai.client-co.com"], bases)).toBe(true);
    });
  });
});
