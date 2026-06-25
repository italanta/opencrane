/**
 * Control-plane → Zitadel Management API seam (S3 / silo Phase 2a).
 *
 * The control-plane is the system-of-record that PROVISIONS Zitadel: on ClusterTenant
 * create it makes a dedicated Zitadel Organization + project + roles + OIDC app for the
 * org's isolated user pool, and grants the tenant master `admin`; on delete it tears the
 * org down. This interface is the single seam those lifecycle hooks call, so the call
 * sites stay thin and the orchestration is unit-testable against a fake.
 */

/** Config the live Zitadel management client requires (read from env). */
export interface ZitadelClientConfig
{
  /** Zitadel instance base URL, e.g. https://weownai-oidc-8dwlat.eu1.zitadel.cloud */
  apiUrl: string;
  /** Service-account key JSON (the downloaded Zitadel SA key) used for jwt-bearer auth. */
  serviceAccountKey: string;
  /** Platform base domain used to derive each org's redirect URI (`<org>.<base>`). */
  baseDomain: string;
}

/** Inputs needed to provision a ClusterTenant's Zitadel org + login surface. */
export interface ProvisionOrgInput
{
  /** ClusterTenant name (the org key) — first DNS label of the org host. */
  orgName: string;
  /** Human-readable org name → the Zitadel Organization display name. */
  displayName: string;
  /** Redirect URI to register on the org's OIDC app (`<org>.<base>/api/v1/auth/callback`). */
  redirectUri: string;
  /** IdP subject (Zitadel user id) of the tenant master, granted `admin` on the new org. */
  masterSubject: string;
}

/** The Zitadel identifiers persisted onto the ClusterTenant row after provisioning. */
export interface ProvisionOrgResult
{
  /** Provisioned Zitadel Organization id. */
  orgId: string;
  /** Provisioned OIDC application id (login surface for `<org>.<base>`). */
  appId: string;
  /** The OIDC client_id of the provisioned app — the per-org credential login authorizes with. */
  clientId: string;
  /** The redirect URI registered on the app (echoed for persistence). */
  redirectUri: string;
}

/**
 * Lifecycle operations the control-plane performs against Zitadel. Implementations are
 * **fail-loud** (throw on any non-OK response) so a caller wrapping them in a DB
 * transaction rolls the local write back on failure; `provisionOrg` additionally
 * compensates (deletes the half-created org) if a mid-flight step fails.
 */
export interface ZitadelManagementClient
{
  /**
   * Provision a dedicated Organization + project + roles + OIDC app for a ClusterTenant
   * and grant the master `admin`. Returns the identifiers to persist. Throws on failure.
   */
  provisionOrg(input: ProvisionOrgInput): Promise<ProvisionOrgResult>;

  /** Tear down a previously-provisioned org (tolerates an already-absent org). */
  teardownOrg(orgId: string): Promise<void>;
}
