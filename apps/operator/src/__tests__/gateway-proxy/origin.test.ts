import { describe, expect, it } from "vitest";

import { _OriginAllowed } from "../../gateway-proxy/origin.js";

describe("_OriginAllowed (CSWSH guard)", () =>
{
  const allow = ["https://ai.client-co.com"];
  const bases = ["opencrane.ai"];

  it("allows an exact allowlisted (vanity) origin", () =>
  {
    expect(_OriginAllowed("https://ai.client-co.com", allow)).toBe(true);
  });

  it("allows any single-label org host under a configured base", () =>
  {
    expect(_OriginAllowed("https://acme.opencrane.ai", [], bases)).toBe(true);
    expect(_OriginAllowed("https://opencrane.ai", [], bases)).toBe(true);
  });

  it("rejects a multi-label subdomain, scheme/port mismatch, and look-alikes", () =>
  {
    expect(_OriginAllowed("https://mike.acme.opencrane.ai", [], bases)).toBe(false);
    expect(_OriginAllowed("http://acme.opencrane.ai", [], bases)).toBe(false);
    expect(_OriginAllowed("https://acme.opencrane.ai:8443", [], bases)).toBe(false);
    expect(_OriginAllowed("https://evilopencrane.ai", [], bases)).toBe(false);
    expect(_OriginAllowed("https://acme.opencrane.ai.evil.com", [], bases)).toBe(false);
  });

  it("fails closed on missing origin and when both lists are empty", () =>
  {
    expect(_OriginAllowed(undefined, allow, bases)).toBe(false);
    expect(_OriginAllowed("https://acme.opencrane.ai", [], [])).toBe(false);
  });
});
