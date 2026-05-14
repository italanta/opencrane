import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import type { AccessPolicy } from "../../policies/types.js";
import { _ResolveTenantPolicy } from "../../tenants/internal/policy-resolution.js";
import { TenantPolicyResolutionState } from "../../tenants/models/tenant-status.interface.js";

/**
 * Build a minimal AccessPolicy fixture with selectable name and selector fields.
 */
function _makePolicy(name: string, options?: { matchTeam?: string; matchLabels?: Record<string, string> }): AccessPolicy
{
  return {
    apiVersion: "opencrane.io/v1alpha1",
    kind: "AccessPolicy",
    metadata: { name, namespace: "default" },
    spec: {
      tenantSelector: {
        ...(options?.matchTeam ? { matchTeam: options.matchTeam } : {}),
        ...(options?.matchLabels ? { matchLabels: options.matchLabels } : {}),
      },
    },
  };
}

/**
 * Build a custom API mock that returns the provided policy list.
 */
function _makeCustomApi(policies: AccessPolicy[]): k8s.CustomObjectsApi
{
  return {
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ body: { items: policies } }),
  } as unknown as k8s.CustomObjectsApi;
}

describe("_ResolveTenantPolicy", function ()
{
  it("prefers explicit policyRef over selector matches", async function ()
  {
    const tenant = _makeTenant("alpha", { team: "engineering", policyRef: "explicit-policy" });
    const policies = [
      _makePolicy("explicit-policy", { matchTeam: "other-team" }),
      _makePolicy("selector-policy", { matchTeam: "engineering" }),
    ];

    const result = await _ResolveTenantPolicy(_makeCustomApi(policies), defaultConfig, tenant, "default");

    expect(result.effectivePolicy?.metadata?.name).toBe("explicit-policy");
    expect(result.source).toBe("policyRef");
    expect(result.state).toBe(TenantPolicyResolutionState.Resolved);
  });

  it("returns PolicyNotFound when explicit policyRef is missing", async function ()
  {
    const tenant = _makeTenant("alpha", { policyRef: "missing-policy" });
    const result = await _ResolveTenantPolicy(_makeCustomApi([]), defaultConfig, tenant, "default");

    expect(result.source).toBe("policyRef");
    expect(result.state).toBe(TenantPolicyResolutionState.PolicyNotFound);
  });

  it("uses a single selector match when no explicit policyRef exists", async function ()
  {
    const tenant = _makeTenant("alpha", { team: "engineering" });
    const policies = [
      _makePolicy("selector-policy", { matchTeam: "engineering" }),
      _makePolicy("other-policy", { matchTeam: "security" }),
    ];

    const result = await _ResolveTenantPolicy(_makeCustomApi(policies), defaultConfig, tenant, "default");

    expect(result.effectivePolicy?.metadata?.name).toBe("selector-policy");
    expect(result.source).toBe("selector");
    expect(result.state).toBe(TenantPolicyResolutionState.Resolved);
  });

  it("returns PolicyConflict when multiple selectors match", async function ()
  {
    const tenant = _makeTenant("alpha", { team: "engineering" });
    const policies = [
      _makePolicy("selector-a", { matchTeam: "engineering" }),
      _makePolicy("selector-b", { matchLabels: { "opencrane.io/tenant": "alpha" } }),
    ];

    const result = await _ResolveTenantPolicy(_makeCustomApi(policies), defaultConfig, tenant, "default");

    expect(result.source).toBe("selector");
    expect(result.state).toBe(TenantPolicyResolutionState.PolicyConflict);
  });

  it("uses configured default policy when no selector or explicit match exists", async function ()
  {
    const tenant = _makeTenant("alpha", { team: "engineering" });
    const configWithDefault = {
      ...defaultConfig,
      defaultTenantPolicyRef: "default-policy",
    };

    const result = await _ResolveTenantPolicy(
      _makeCustomApi([_makePolicy("default-policy")]),
      configWithDefault,
      tenant,
      "default",
    );

    expect(result.effectivePolicy?.metadata?.name).toBe("default-policy");
    expect(result.source).toBe("default");
    expect(result.state).toBe(TenantPolicyResolutionState.Resolved);
  });

  it("returns DefaultPolicyNotFound when configured default policy is missing", async function ()
  {
    const tenant = _makeTenant("alpha");
    const configWithDefault = {
      ...defaultConfig,
      defaultTenantPolicyRef: "missing-default",
    };

    const result = await _ResolveTenantPolicy(_makeCustomApi([]), configWithDefault, tenant, "default");

    expect(result.source).toBe("default");
    expect(result.state).toBe(TenantPolicyResolutionState.DefaultPolicyNotFound);
  });

  it("returns NoPolicy when no policy path applies", async function ()
  {
    const tenant = _makeTenant("alpha");
    const result = await _ResolveTenantPolicy(_makeCustomApi([]), defaultConfig, tenant, "default");

    expect(result.source).toBe("none");
    expect(result.state).toBe(TenantPolicyResolutionState.NoPolicy);
  });
});