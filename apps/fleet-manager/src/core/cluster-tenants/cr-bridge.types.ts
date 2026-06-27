/** Org owner identity projected into the ClusterTenant CR `spec.owner`. */
export interface ClusterTenantOwner
{
  /** The owner's OIDC subject (`sub`) — stable IdP-issued identifier, required. */
  subject: string;
  /** The owner's IdP-verified email; becomes the default Tenant's contact email. */
  email?: string;
}

/**
 * Desired-state spec EXCLUDING the owner. This is the shape sent on a
 * merge-patch (update path): omitting `owner` means a JSON merge-patch
 * leaves the existing `spec.owner` untouched.
 */
export interface ClusterTenantCrSpecPatch
{
  /** Human-readable org display name shown in UIs and audit logs. */
  displayName: string;
  /** Optional customer-vanity domain CNAMEd onto the derived `<org>.<base>` apex. */
  vanityDomain?: string;
  /** Isolation tier (`shared` | `dedicatedNodes` | `dedicatedCluster`) driving the operator's boundary-provisioner selection. */
  isolationTier: string;
  /** Compute placement: shared cluster or a dedicated node pool. */
  compute: {
    /** Compute mode: `shared` (multi-tenant pool) or `dedicated` (per-org node pool). */
    mode: string;
    /** Node-pool name when `mode` is `dedicated`; omitted/ignored otherwise. */
    nodePool?: string;
  };
  /** Resource governance for the org's bound namespace. */
  resources: {
    /** Kubernetes `ResourceQuota` map (CPU, memory, storage, etc.) applied to the org namespace. */
    quota: Record<string, unknown>;
  };
  /**
   * Public per-org Zitadel OIDC identifiers, projected onto the CR so the silo resolves
   * per-org login from the CR (Option A). Omitted entirely until the org is provisioned —
   * a JSON merge-patch then leaves any existing `spec.zitadel` untouched. These are PUBLIC
   * OIDC ids (client_id / org id / redirect URI), NOT secrets.
   */
  zitadel?: {
    /** The org's OIDC `client_id` login authorizes with. */
    clientId?: string;
    /** The org's Zitadel Organization id (drives the `urn:zitadel:iam:org:id:{orgId}` login scope). */
    orgId?: string;
    /** The redirect URI registered on the org's OIDC app, when known. */
    redirectUri?: string;
  };
}

/**
 * Full desired-state spec — the patch shape extended with the mandatory owner.
 * Used as the spec on a CREATE (every org has a single owner; the control plane
 * 401s any create with no resolvable subject, so a CR is never born owner-less).
 */
export interface ClusterTenantSpec extends ClusterTenantCrSpecPatch
{
  /** Org owner identity — stamped on create, preserved across updates by the merge-patch path. */
  owner: ClusterTenantOwner;
}
