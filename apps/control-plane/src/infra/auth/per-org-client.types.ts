/**
 * Types for host→ClusterTenant→per-org OIDC client resolution (S3b).
 *
 * Each ClusterTenant gets a dedicated Zitadel Organization + OIDC app on create (S3),
 * persisting `{zitadelOrgId, zitadelClientId, zitadelRedirectUri}`. A request arriving at
 * `<org>.<base>` must log in against THAT org's client (and only that org's user pool),
 * so login resolves the per-org client from the host's first DNS label.
 */

/**
 * The org-scoped OIDC client resolved for a per-org host. Returned only when the host's
 * ClusterTenant has a fully-provisioned client; an unprovisioned or unknown host yields
 * null (fail-closed → login falls through to the masters client).
 */
export interface ResolvedPerOrgClient
{
  /** The ClusterTenant (silo) name — the host's first DNS label, confirmed against the DB. */
  clusterTenant: string;

  /** The org's OIDC client_id login authorizes with (the per-org credential). */
  clientId: string;

  /** The org's Zitadel Organization id — added as the `urn:zitadel:iam:org:id:{orgId}` login scope. */
  orgId: string;

  /** The redirect URI registered on the org's app, when known (else null). */
  redirectUri: string | null;
}
