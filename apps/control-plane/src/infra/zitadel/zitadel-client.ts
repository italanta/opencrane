import crypto from "node:crypto";

import { _log } from "../../log.js";
import type { ProvisionOrgInput, ProvisionOrgResult, ZitadelClientConfig, ZitadelManagementClient } from "./zitadel-client.types.js";

export type { ZitadelClientConfig };

/** Shape of the Zitadel service-account key JSON (`type: serviceaccount`). */
interface _ServiceAccountKey
{
  keyId: string;
  key: string;
  userId: string;
}

/** Scope that requests an access token audience-bound to the Zitadel management API. */
const _MGMT_SCOPE = "openid urn:zitadel:iam:org:project:id:zitadel:aud";

/** Read the live-client config from env, or null when not (fully) configured. */
export function _ReadZitadelClientConfig(): ZitadelClientConfig | null
{
  const apiUrl = process.env.ZITADEL_MGMT_API_URL?.trim() ?? "";
  const serviceAccountKey = process.env.ZITADEL_MGMT_SA_KEY?.trim() ?? "";
  const baseDomain = process.env.PLATFORM_BASE_DOMAIN?.trim() ?? "";

  if (!apiUrl || !serviceAccountKey || !baseDomain)
  {
    return null;
  }
  return { apiUrl, serviceAccountKey, baseDomain };
}

/**
 * Live Zitadel Management API client (S3 / silo Phase 2a). Authenticates as a service
 * account via the JWT-bearer profile (RS256-signed assertion → `/oauth/v2/token`,
 * grant `urn:ietf:params:oauth:grant-type:jwt-bearer`), caches the access token until
 * just before expiry, and drives the per-org provisioning lifecycle validated against
 * the live instance: create Organization → project → bulk roles → OIDC app → grant the
 * master `admin`. Every call is fail-loud; `provisionOrg` compensates by deleting the
 * half-created org if a later step fails, so a partial failure never orphans an org.
 *
 * Requires the SA to hold instance-level `IAM_OWNER` (org create/delete is an
 * instance privilege) — documented as a setup prerequisite.
 */
export class _HttpZitadelManagementClient implements ZitadelManagementClient
{
  /** Trailing-slash-trimmed Zitadel instance base URL. */
  private readonly apiUrl: string;
  /** Parsed service-account key used to sign the jwt-bearer assertion. */
  private readonly saKey: _ServiceAccountKey;
  /** Injectable HTTP transport (global `fetch` in prod; a fake in tests). */
  private readonly fetchImpl: typeof fetch;
  /** Cached management access token + its refresh deadline (epoch ms). */
  private _cachedToken: { value: string; expiresAtMs: number } | null = null;

  /**
   * @param config - The instance URL, SA key JSON, and base domain.
   * @param fetchImpl - Injectable transport (defaults to global `fetch`); tests pass a fake.
   */
  public constructor(config: ZitadelClientConfig, fetchImpl: typeof fetch = fetch)
  {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    const parsed = JSON.parse(config.serviceAccountKey) as Partial<_ServiceAccountKey>;
    if (!parsed.keyId || !parsed.key || !parsed.userId)
    {
      throw new Error("ZITADEL_MGMT_SA_KEY is not a valid Zitadel service-account key (missing keyId/key/userId)");
    }
    this.saKey = { keyId: parsed.keyId, key: parsed.key, userId: parsed.userId };
  }

  public async provisionOrg(input: ProvisionOrgInput): Promise<ProvisionOrgResult>
  {
    // 1. Create the dedicated Organization (instance-level). Everything else happens
    //    inside its context via the x-zitadel-orgid header.
    const org = await this._call("POST", "/v2/organizations", { name: input.displayName }) as { organizationId?: string; id?: string };
    const orgId = org.organizationId ?? org.id;
    if (!orgId)
    {
      throw new Error("Zitadel org create returned no organizationId");
    }

    // 2..5. Provision the org's contents; compensate (delete the org) on any failure so
    //       a mid-flight error never leaves an orphaned, half-configured org behind.
    try
    {
      const project = await this._call("POST", "/management/v1/projects", { name: "opencrane" }, orgId) as { id?: string };
      const projectId = project.id;
      if (!projectId)
      {
        throw new Error("Zitadel project create returned no id");
      }

      await this._call("POST", `/management/v1/projects/${projectId}/roles/_bulk`, {
        roles: [
          { key: "owner", displayName: "Owner" },
          { key: "admin", displayName: "Admin" },
          { key: "member", displayName: "Member" },
        ],
      }, orgId);

      const app = await this._call("POST", `/management/v1/projects/${projectId}/apps/oidc`, {
        name: "login",
        redirectUris: [input.redirectUri],
        responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
        appType: "OIDC_APP_TYPE_WEB",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
        devMode: false,
      }, orgId) as { appId?: string; clientId?: string };
      if (!app.appId)
      {
        throw new Error("Zitadel OIDC app create returned no appId");
      }
      // The live app-create response carries the generated OIDC client_id alongside the
      // appId. Capture it so login can resolve this org's per-org client by host (S3b);
      // without it the org has a login surface but no credential to authorize against it.
      if (!app.clientId)
      {
        throw new Error("Zitadel OIDC app create returned no clientId");
      }

      // Grant the master `admin` on this org's project (cross-org user grant; the master
      // lives in the masters org but is granted into this CT org — the SSO bridge).
      await this._call("POST", `/management/v1/users/${input.masterSubject}/grants`, {
        projectId,
        roleKeys: ["admin"],
      }, orgId);

      _log.info({ orgId, appId: app.appId, orgName: input.orgName }, "provisioned Zitadel org for ClusterTenant");
      return { orgId, appId: app.appId, clientId: app.clientId, redirectUri: input.redirectUri };
    }
    catch (err)
    {
      _log.warn({ orgId, orgName: input.orgName, err }, "Zitadel org provisioning failed mid-flight; compensating by deleting the org");
      await this.teardownOrg(orgId).catch(function _ignore() { /* compensation is best-effort */ });
      throw err;
    }
  }

  public async teardownOrg(orgId: string): Promise<void>
  {
    const res = await this.fetchImpl(`${this.apiUrl}/admin/v1/orgs/${orgId}`, {
      method: "DELETE",
      headers: { ...(await this._authHeaders()), "x-zitadel-orgid": orgId },
    });
    // Already-absent org is the desired end state, not an error.
    if (res.ok || res.status === 404)
    {
      return;
    }
    throw new Error(`Zitadel org teardown failed (${res.status}): ${await res.text()}`);
  }

  /** Issue an authenticated, org-scoped Management API call; throw on any non-OK status. */
  private async _call(method: string, path: string, body: unknown, orgId?: string): Promise<unknown>
  {
    const headers: Record<string, string> = { ...(await this._authHeaders()), "content-type": "application/json" };
    if (orgId)
    {
      headers["x-zitadel-orgid"] = orgId;
    }
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    if (!res.ok)
    {
      throw new Error(`Zitadel ${method} ${path} failed (${res.status}): ${await res.text()}`);
    }
    return res.json().catch(function _empty() { return {}; });
  }

  /** Authorization header carrying a cached-or-fresh management access token. */
  private async _authHeaders(): Promise<Record<string, string>>
  {
    return { authorization: `Bearer ${await this._token()}` };
  }

  /** Acquire (and cache) a management access token via the JWT-bearer SA profile. */
  private async _token(): Promise<string>
  {
    const nowMs = Date.now();
    if (this._cachedToken && nowMs < this._cachedToken.expiresAtMs)
    {
      return this._cachedToken.value;
    }

    const assertion = this._signServiceAccountJwt();
    const res = await this.fetchImpl(`${this.apiUrl}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion, scope: _MGMT_SCOPE }),
    });
    if (!res.ok)
    {
      throw new Error(`Zitadel token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = await res.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token)
    {
      throw new Error("Zitadel token exchange returned no access_token");
    }
    // Refresh 60s before the stated expiry (default 1h) so a call never races the clock.
    const ttlMs = Math.max(60, (json.expires_in ?? 3600) - 60) * 1000;
    this._cachedToken = { value: json.access_token, expiresAtMs: nowMs + ttlMs };
    return json.access_token;
  }

  /** Build + RS256-sign the service-account assertion JWT (iss/sub = SA userId, aud = instance). */
  private _signServiceAccountJwt(): string
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = _b64url(JSON.stringify({ alg: "RS256", kid: this.saKey.keyId }));
    const claims = _b64url(JSON.stringify({ iss: this.saKey.userId, sub: this.saKey.userId, aud: this.apiUrl, iat: nowSec, exp: nowSec + 300 }));
    const signingInput = `${header}.${claims}`;
    const signature = _b64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), this.saKey.key));
    return `${signingInput}.${signature}`;
  }
}

/**
 * Build the Zitadel management client for the process. Returns the live client when
 * configured; **throws** when it is not — the control-plane hard-commits to Zitadel, so
 * the multi-tenant path must never silently run without it. The factory is only called
 * on the multi-tenant path (cluster-tenant manager enabled); a single-cluster install
 * never constructs it, so single-cluster installs are unaffected by the requirement.
 */
export function _BuildZitadelManagementClient(): ZitadelManagementClient
{
  const config = _ReadZitadelClientConfig();
  if (!config)
  {
    throw new Error(
      "Zitadel management is required for the cluster-tenant manager but is not configured. " +
      "Set ZITADEL_MGMT_API_URL, ZITADEL_MGMT_SA_KEY (instance IAM_OWNER service-account key), and PLATFORM_BASE_DOMAIN.",
    );
  }
  return new _HttpZitadelManagementClient(config);
}

/**
 * Derive the OIDC redirect URI for an org's login surface:
 * `https://<org>.<base>/api/v1/auth/callback`. Centralised so the provisioner and the
 * (future) login resolver agree on the exact value registered on the org's Zitadel app.
 */
export function _DeriveOrgRedirectUri(orgName: string, baseDomain: string): string
{
  return `https://${orgName}.${baseDomain}/api/v1/auth/callback`;
}

/** URL-safe base64 of a string or buffer (JWT segments / signatures). */
function _b64url(input: string | Buffer): string
{
  return Buffer.from(input).toString("base64url");
}
