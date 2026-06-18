import { Buffer } from "node:buffer";

import * as k8s from "@kubernetes/client-node";
import pino from "pino";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { _makeTenant, defaultConfig } from "../fixtures.js";
import { TenantLiteLlmKeys } from "../../tenants/internal/tenant-litellm-keys.js";
import type { OpenClawTenantOperatorConfig } from "../../config.js";

const _log = pino({ level: "silent" });

/** Config with LiteLLM enabled + a master key, the baseline for these tests. */
const _enabledConfig: OpenClawTenantOperatorConfig = {
  ...defaultConfig,
  liteLlmEnabled: true,
  liteLlmEndpoint: "http://litellm:4000",
  liteLlmMasterKey: "sk-master",
  liteLlmDefaultMonthlyBudgetUsd: 50,
  liteLlmBudgetDuration: "30d",
};

/**
 * Build a stub CoreV1Api whose readNamespacedSecret either throws (Secret
 * missing → create path) or returns a Secret carrying the supplied key value
 * (existing-secret → update path).
 *
 * @param existingKeyValue - When set, the decoded apiKey the Secret returns.
 */
function _makeCoreApi(existingKeyValue?: string): k8s.CoreV1Api
{
  return {
    readNamespacedSecret: vi.fn().mockImplementation(function _read(): Promise<k8s.V1Secret>
    {
      if (existingKeyValue === undefined)
      {
        return Promise.reject(new Error("404 not found"));
      }

      return Promise.resolve({
        data: { apiKey: Buffer.from(existingKeyValue).toString("base64") },
      } as unknown as k8s.V1Secret);
    }),
  } as unknown as k8s.CoreV1Api;
}

/** Stub KubernetesObjectApi recording server-side applies without a cluster. */
function _makeObjectApi(): k8s.KubernetesObjectApi
{
  return {
    read: vi.fn().mockRejectedValue(new Error("not found")),
    patch: vi.fn().mockResolvedValue({ body: {} }),
    create: vi.fn().mockResolvedValue({ body: {} }),
  } as unknown as k8s.KubernetesObjectApi;
}

/** Parse the JSON body of a recorded fetch call. */
function _bodyOf(call: unknown[]): Record<string, unknown>
{
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("TenantLiteLlmKeys", () =>
{
  beforeEach(() =>
  {
    vi.restoreAllMocks();
  });

  afterEach(() =>
  {
    vi.unstubAllGlobals();
  });

  it("generate sends the new params (budget_duration, team_id, max_budget)", async () =>
  {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: "sk-tenant-new" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const coreApi = _makeCoreApi();
    const keys = new TenantLiteLlmKeys(_enabledConfig, coreApi, _makeObjectApi(), _log);
    const tenant = _makeTenant("acme-user", { clusterTenantRef: "acme", monthlyBudgetUsd: 75 });

    await keys.ensureLiteLlmKeySecret(tenant, "default");

    // Exactly one /key/generate call (no /key/update on the create path).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://litellm:4000/key/generate");

    const body = _bodyOf(fetchMock.mock.calls[0]);
    expect(body["key_alias"]).toBe("opencrane-acme-user");
    expect(body["metadata"]).toEqual({ tenant: "acme-user" });
    expect(body["max_budget"]).toBe(75);
    expect(body["budget_duration"]).toBe("30d");
    expect(body["team_id"]).toBe("acme");
  });

  it("generate resolves team_id from spec.team when no clusterTenantRef, and adds rate limits when configured", async () =>
  {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: "sk-tenant-new" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config: OpenClawTenantOperatorConfig = {
      ..._enabledConfig,
      liteLlmDefaultTpmLimit: 1000,
      liteLlmDefaultRpmLimit: 60,
    };
    const keys = new TenantLiteLlmKeys(config, _makeCoreApi(), _makeObjectApi(), _log);
    const tenant = _makeTenant("solo-user", { team: "engineering" });

    await keys.ensureLiteLlmKeySecret(tenant, "default");

    const body = _bodyOf(fetchMock.mock.calls[0]);
    expect(body["team_id"]).toBe("engineering");
    expect(body["tpm_limit"]).toBe(1000);
    expect(body["rpm_limit"]).toBe(60);
  });

  it("omits team_id and rate limits when neither team nor limits are set", async () =>
  {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: "sk-tenant-new" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const keys = new TenantLiteLlmKeys(_enabledConfig, _makeCoreApi(), _makeObjectApi(), _log);
    const tenant = _makeTenant("orphan-user");

    await keys.ensureLiteLlmKeySecret(tenant, "default");

    const body = _bodyOf(fetchMock.mock.calls[0]);
    expect(body).not.toHaveProperty("team_id");
    expect(body).not.toHaveProperty("tpm_limit");
    expect(body).not.toHaveProperty("rpm_limit");
  });

  it("existing-secret path calls /key/update with the existing key value (no rotation, no generate)", async () =>
  {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const objectApi = _makeObjectApi();
    const keys = new TenantLiteLlmKeys(_enabledConfig, _makeCoreApi("sk-tenant-existing"), objectApi, _log);
    const tenant = _makeTenant("acme-user", { clusterTenantRef: "acme", monthlyBudgetUsd: 120 });

    await keys.ensureLiteLlmKeySecret(tenant, "default");

    // 1. Exactly one call, and it is /key/update — not /key/generate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://litellm:4000/key/update");

    // 2. Re-applies the params, identifying the key by its existing value
    //    (so the value is preserved → no pod restart).
    const body = _bodyOf(fetchMock.mock.calls[0]);
    expect(body["key"]).toBe("sk-tenant-existing");
    expect(body["max_budget"]).toBe(120);
    expect(body["budget_duration"]).toBe("30d");
    expect(body["team_id"]).toBe("acme");

    // 3. No new Secret written → key value is not rotated.
    expect((objectApi.patch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((objectApi.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("does not crash the reconcile when /key/update fails (best-effort, non-fatal)", async () =>
  {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const keys = new TenantLiteLlmKeys(_enabledConfig, _makeCoreApi("sk-tenant-existing"), _makeObjectApi(), _log);
    const tenant = _makeTenant("acme-user", { clusterTenantRef: "acme" });

    await expect(keys.ensureLiteLlmKeySecret(tenant, "default")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when LiteLLM integration is disabled", async () =>
  {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const keys = new TenantLiteLlmKeys(defaultConfig, _makeCoreApi(), _makeObjectApi(), _log);
    await keys.ensureLiteLlmKeySecret(_makeTenant("anyone"), "default");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
