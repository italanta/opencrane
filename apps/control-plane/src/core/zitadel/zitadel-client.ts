import { _log } from "../../log.js";
import type { ProvisionOrgInput, ProvisionOrgResult, ZitadelManagementClient } from "./zitadel-client.types.js";

/**
 * No-op Zitadel management client — used until the instance is configured (and, in this
 * keystone slice, the only implementation; the live HTTP client lands in the follow-up).
 *
 * It performs NO Zitadel side effects and reports `isLive: false`, so `provisionOrg`
 * returns `null` and the ClusterTenant row is committed with null Zitadel columns. This
 * keeps the unconfigured/dev/test path safe: the org still exists locally, and the
 * reconcile/backfill loop (a later slice) can provision Zitadel once it is configured.
 */
export class _NoopZitadelManagementClient implements ZitadelManagementClient
{
  public readonly isLive = false;

  /** Provision nothing; signal to the caller (via null) to leave the Zitadel columns unset. */
  async provisionOrg(_input: ProvisionOrgInput): Promise<ProvisionOrgResult | null>
  {
    return null;
  }

  /** Tear down nothing. */
  async teardownOrg(_orgId: string): Promise<void>
  {
    // no-op
  }
}

/**
 * Configuration the live Zitadel management client requires (read from env). All four
 * must be present for the live client; any missing field falls back to the no-op so an
 * incomplete config never half-provisions identity infrastructure.
 */
export interface ZitadelClientConfig
{
  /** Zitadel instance base URL, e.g. https://weownai-oidc-8dwlat.eu1.zitadel.cloud */
  apiUrl: string;
  /** Service-account key JSON (the downloaded Zitadel SA key) used for jwt-bearer auth. */
  serviceAccountKey: string;
  /** Zitadel project id that owns the per-org OIDC apps + role definitions. */
  projectId: string;
  /** Platform base domain used to derive each org's redirect URI (`<org>.<base>`). */
  baseDomain: string;
}

/** Read the live-client config from env, or null when not (fully) configured. */
export function _ReadZitadelClientConfig(): ZitadelClientConfig | null
{
  const apiUrl = process.env.ZITADEL_MGMT_API_URL?.trim() ?? "";
  const serviceAccountKey = process.env.ZITADEL_MGMT_SA_KEY?.trim() ?? "";
  const projectId = process.env.ZITADEL_PROJECT_ID?.trim() ?? "";
  const baseDomain = process.env.PLATFORM_BASE_DOMAIN?.trim() ?? "";

  if (!apiUrl || !serviceAccountKey || !projectId || !baseDomain)
  {
    return null;
  }
  return { apiUrl, serviceAccountKey, projectId, baseDomain };
}

/**
 * Build the Zitadel management client for the process.
 *
 * Returns the no-op client when Zitadel is not (fully) configured. When it IS configured,
 * this keystone slice still returns the no-op but logs a clear notice — the live HTTP
 * implementation (jwt-bearer service-account auth + the Management-API org/app/role/grant
 * calls) is the next S3 slice, validated against the live instance with a real SA key.
 * Wiring the seam + the transactional call sites first keeps that follow-up a drop-in.
 */
export function _BuildZitadelManagementClient(): ZitadelManagementClient
{
  const config = _ReadZitadelClientConfig();
  if (config)
  {
    // Signal presence only — never log the SA key. Structured so it is queryable.
    _log.warn(
      { liveClientDeferred: true },
      "Zitadel management API is configured but the live client ships in the next S3 slice; org provisioning is currently a NO-OP (ClusterTenants are created without a Zitadel org)",
    );
  }
  return new _NoopZitadelManagementClient();
}

/**
 * Derive the OIDC redirect URI for an org's login surface: `https://<org>.<base>/api/v1/auth/callback`.
 * Centralised so the provisioner and the (future) login resolver agree on the exact value
 * that must be registered on the org's Zitadel app.
 *
 * @param orgName - The ClusterTenant name (first DNS label of the org host).
 * @param baseDomain - The platform base domain.
 */
export function _DeriveOrgRedirectUri(orgName: string, baseDomain: string): string
{
  return `https://${orgName}.${baseDomain}/api/v1/auth/callback`;
}
