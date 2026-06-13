import { describe, expect, it } from "vitest";

import { _ParseOpenClawSetupCode } from "../../tenants/internal/openclaw-pairing-provision.js";

/** Encode a pairing payload the way the gateway emits its setup code. */
function _encode(payload: object): string
{
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

describe("_ParseOpenClawSetupCode (CONN.3 pairing provisioning)", function _suite()
{
  it("decodes a raw base64 setup code into a pairing link", function _rawCode()
  {
    const code = _encode({ url: "wss://t1.example.com/gateway", bootstrapToken: "boot-xyz" });
    expect(_ParseOpenClawSetupCode(code)).toEqual({ gatewayUrl: "wss://t1.example.com/gateway", bootstrapToken: "boot-xyz" });
  });

  it("unwraps the CLI --json envelope carrying the code under setupCode", function _envelope()
  {
    const code = _encode({ url: "wss://t1.example.com/gateway", bootstrapToken: "boot-xyz" });
    const stdout = JSON.stringify({ setupCode: code });
    expect(_ParseOpenClawSetupCode(stdout)).toMatchObject({ bootstrapToken: "boot-xyz" });
  });

  it("accepts a --json envelope that exposes the payload fields directly", function _directEnvelope()
  {
    const stdout = JSON.stringify({ url: "wss://t1.example.com/gateway", bootstrapToken: "boot-direct" });
    expect(_ParseOpenClawSetupCode(stdout)).toEqual({ gatewayUrl: "wss://t1.example.com/gateway", bootstrapToken: "boot-direct" });
  });

  it("omits gatewayUrl when the payload has none (broker derives the fallback)", function _noUrl()
  {
    const code = _encode({ bootstrapToken: "boot-only" });
    expect(_ParseOpenClawSetupCode(code)).toEqual({ gatewayUrl: undefined, bootstrapToken: "boot-only" });
  });

  it("throws when no bootstrap token can be recovered", function _noToken()
  {
    const code = _encode({ url: "wss://t1.example.com/gateway" });
    expect(function _call() { _ParseOpenClawSetupCode(code); }).toThrow(/bootstrapToken/);
  });

  it("throws on an empty setup code", function _empty()
  {
    expect(function _call() { _ParseOpenClawSetupCode("  "); }).toThrow(/empty/);
  });
});
