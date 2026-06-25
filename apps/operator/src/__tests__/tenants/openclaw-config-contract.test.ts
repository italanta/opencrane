import { describe, expect, it } from "vitest";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import { _BuildConfigMap } from "../../tenants/deploy/index.js";

/**
 * Structural contract test for the rendered `openclaw.json` (task_d611ab4d, S1).
 *
 * OpenClaw's gateway config schema is **strict** — an unknown key crashes the pod
 * on boot (the `trustNothing`-class crash fixed in f6afafd, where the operator
 * leaked an internal flag into the `gateway` block). The full validation against
 * the pinned OpenClaw zod schema is BLOCKED (the schema is not vendored — OpenClaw
 * ships as a container, not an npm dep), so this is the no-dependency fallback: it
 * pins the exact key set the operator emits and fails closed on any stray key,
 * which is precisely the regression class that crashed live tenants.
 */
describe("openclaw.json render contract — strict key set (task_d611ab4d)", function _suite()
{
  /** Keys OpenClaw's strict `gateway` schema accepts; anything else crashes the pod. */
  const _ALLOWED_GATEWAY_KEYS = ["mode", "port", "bind", "trustedProxies", "auth"];

  /** Keys of the nested `gateway.auth.trustedProxy` block. */
  const _ALLOWED_TRUSTED_PROXY_KEYS = ["userHeader", "allowUsers"];

  function _renderGateway(tenant = _makeTenant("contract")): Record<string, unknown>
  {
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");
    return payload.gateway as Record<string, unknown>;
  }

  it("emits exactly the strict gateway key set — no stray keys", function _gatewayKeys()
  {
    const gateway = _renderGateway();
    expect(Object.keys(gateway).sort()).toEqual([..._ALLOWED_GATEWAY_KEYS].sort());
  });

  it("never leaks the internal trustNothing flag into the gateway block", function _noTrustNothing()
  {
    // The exact f6afafd regression: trustNothing is operator-internal, not an
    // OpenClaw key, so it must never appear anywhere in the rendered config.
    const configMap = _BuildConfigMap(defaultConfig, _makeTenant("contract"), "default");
    const raw = configMap.data?.["openclaw.json"] ?? "";
    expect(raw).not.toContain("trustNothing");
  });

  it("emits the strict trusted-proxy auth shape", function _authShape()
  {
    const gateway = _renderGateway();
    const auth = gateway.auth as Record<string, unknown>;
    expect(auth.mode).toBe("trusted-proxy");

    const trustedProxy = auth.trustedProxy as Record<string, unknown>;
    expect(Object.keys(trustedProxy).sort()).toEqual([..._ALLOWED_TRUSTED_PROXY_KEYS].sort());
  });

  it("pins the gateway to the owner email via allowUsers", function _ownerPin()
  {
    // CONN.10 — the operator-emitted config must scope the pod to its owner. (Note:
    // configOverrides currently REPLACES the gateway block via shallow merge, so a
    // gateway override drops this pin — tracked as a follow-up gap, see PR notes.)
    const gateway = _renderGateway(_makeTenant("contract"));
    const auth = gateway.auth as Record<string, unknown>;
    const trustedProxy = auth.trustedProxy as { allowUsers: string[] };
    expect(trustedProxy.allowUsers).toEqual(["contract@example.com"]);
  });
});
