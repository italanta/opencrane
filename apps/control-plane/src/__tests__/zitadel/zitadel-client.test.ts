import crypto from "node:crypto";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { _BuildZitadelManagementClient, _DeriveOrgRedirectUri, _HttpZitadelManagementClient, _ReadZitadelClientConfig } from "../../infra/zitadel/zitadel-client.js";

/** A real RSA SA key so the client's RS256 jwt-bearer signing actually succeeds. */
function _saKeyJson(): string
{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return JSON.stringify({ type: "serviceaccount", keyId: "k1", key: pem, userId: "u1" });
}

/** Build an injectable fetch fake that records calls and replies per path. */
function _fakeFetch(overrides: Record<string, { status?: number; body?: unknown }> = {}): { fetchImpl: typeof fetch; calls: Array<{ method: string; path: string; orgId?: string }> }
{
  const calls: Array<{ method: string; path: string; orgId?: string }> = [];
  const fetchImpl = (async function _f(url: string, init: { method?: string; headers?: Record<string, string> }) {
    const path = url.replace(/^https:\/\/[^/]+/, "");
    calls.push({ method: init?.method ?? "GET", path, orgId: init?.headers?.["x-zitadel-orgid"] });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const o = overrides[path];
    if (o) return { ok: (o.status ?? 200) < 400, status: o.status ?? 200, json: async () => o.body ?? {}, text: async () => JSON.stringify(o.body ?? {}) };
    if (path === "/oauth/v2/token") return ok({ access_token: "tok-abc", expires_in: 3600 });
    if (path === "/v2/organizations") return ok({ organizationId: "org-9" });
    if (path === "/management/v1/projects") return ok({ id: "proj-9" });
    if (path.endsWith("/roles/_bulk")) return ok({});
    if (path.endsWith("/apps/oidc")) return ok({ appId: "app-9", clientId: "client-9" });
    if (path.includes("/grants")) return ok({});
    if (path.startsWith("/admin/v1/orgs/")) return ok({});
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("_HttpZitadelManagementClient — live provisioning lifecycle (injected fetch)", function _liveSuite()
{
  it("provisions org → project → roles → app → master grant, in order, returning the ids", async function _provisions()
  {
    const { fetchImpl, calls } = _fakeFetch();
    const client = new _HttpZitadelManagementClient({ apiUrl: "https://z.example.com", serviceAccountKey: _saKeyJson(), baseDomain: "dev.opencrane.ai" }, fetchImpl);

    const result = await client.provisionOrg({ orgName: "acme", displayName: "Acme", redirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback", masterSubject: "u-master" });

    expect(result).toEqual({ orgId: "org-9", appId: "app-9", clientId: "client-9", redirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback" });
    const paths = calls.map(c => c.path);
    expect(paths).toEqual([
      "/oauth/v2/token",
      "/v2/organizations",
      "/management/v1/projects",
      "/management/v1/projects/proj-9/roles/_bulk",
      "/management/v1/projects/proj-9/apps/oidc",
      "/management/v1/users/u-master/grants",
    ]);
    // Every in-org call carries the new org's context header.
    expect(calls.filter(c => c.path.startsWith("/management")).every(c => c.orgId === "org-9")).toBe(true);
  });

  it("compensates (deletes the half-created org) and rethrows when a later step fails", async function _compensates()
  {
    const { fetchImpl, calls } = _fakeFetch({ "/management/v1/projects/proj-9/apps/oidc": { status: 500, body: { message: "boom" } } });
    const client = new _HttpZitadelManagementClient({ apiUrl: "https://z.example.com", serviceAccountKey: _saKeyJson(), baseDomain: "dev.opencrane.ai" }, fetchImpl);

    await expect(client.provisionOrg({ orgName: "acme", displayName: "Acme", redirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback", masterSubject: "u-master" })).rejects.toThrow(/apps\/oidc failed \(500\)/);
    // The compensating org delete ran.
    expect(calls.some(c => c.method === "DELETE" && c.path === "/admin/v1/orgs/org-9")).toBe(true);
  });

  it("fails loud (and compensates) when the app-create response omits the clientId (S3b)", async function _noClientId()
  {
    // The live app-create returns appId + clientId; an app row without a clientId would
    // leave the org with a login surface but no per-org credential, so we reject it.
    const { fetchImpl, calls } = _fakeFetch({ "/management/v1/projects/proj-9/apps/oidc": { status: 200, body: { appId: "app-9" } } });
    const client = new _HttpZitadelManagementClient({ apiUrl: "https://z.example.com", serviceAccountKey: _saKeyJson(), baseDomain: "dev.opencrane.ai" }, fetchImpl);

    await expect(client.provisionOrg({ orgName: "acme", displayName: "Acme", redirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback", masterSubject: "u-master" })).rejects.toThrow(/no clientId/);
    expect(calls.some(c => c.method === "DELETE" && c.path === "/admin/v1/orgs/org-9")).toBe(true);
  });

  it("teardownOrg tolerates an already-absent org (404)", async function _teardown404()
  {
    const { fetchImpl } = _fakeFetch({ "/admin/v1/orgs/gone": { status: 404, body: {} } });
    const client = new _HttpZitadelManagementClient({ apiUrl: "https://z.example.com", serviceAccountKey: _saKeyJson(), baseDomain: "dev.opencrane.ai" }, fetchImpl);
    await expect(client.teardownOrg("gone")).resolves.toBeUndefined();
  });

  it("rejects a malformed service-account key", function _badKey()
  {
    expect(() => new _HttpZitadelManagementClient({ apiUrl: "https://z.example.com", serviceAccountKey: "{}", baseDomain: "d" })).toThrow(/service-account key/);
  });
});

describe("_DeriveOrgRedirectUri", function _deriveSuite()
{
  it("derives the per-org callback URI from the org name + base domain", function _derives()
  {
    expect(_DeriveOrgRedirectUri("elewa-be", "dev.opencrane.ai")).toBe("https://elewa-be.dev.opencrane.ai/api/v1/auth/callback");
  });
});

describe("_ReadZitadelClientConfig + factory — hard-required, fail-loud when unconfigured", function _configSuite()
{
  let _saved: NodeJS.ProcessEnv;
  beforeEach(function _save() { _saved = process.env; process.env = { ..._saved }; });
  afterEach(function _restore() { process.env = _saved; });

  it("returns null config when any required var is missing", function _partial()
  {
    process.env.ZITADEL_MGMT_API_URL = "https://zitadel.example.com";
    delete process.env.ZITADEL_MGMT_SA_KEY;
    delete process.env.PLATFORM_BASE_DOMAIN;
    expect(_ReadZitadelClientConfig()).toBeNull();
  });

  it("reads a complete config (no shared projectId — each org gets its own)", function _complete()
  {
    process.env.ZITADEL_MGMT_API_URL = "https://zitadel.example.com";
    process.env.ZITADEL_MGMT_SA_KEY = "{\"type\":\"serviceaccount\"}";
    process.env.PLATFORM_BASE_DOMAIN = "dev.opencrane.ai";
    expect(_ReadZitadelClientConfig()).toEqual({
      apiUrl: "https://zitadel.example.com",
      serviceAccountKey: "{\"type\":\"serviceaccount\"}",
      baseDomain: "dev.opencrane.ai",
    });
  });

  it("factory THROWS when unconfigured (hard commit — never a silent no-op)", function _factoryThrows()
  {
    delete process.env.ZITADEL_MGMT_API_URL;
    delete process.env.ZITADEL_MGMT_SA_KEY;
    delete process.env.PLATFORM_BASE_DOMAIN;
    expect(() => _BuildZitadelManagementClient()).toThrow(/Zitadel management is required/);
  });
});
