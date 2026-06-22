import type { ClusterTenantComputeMode, ClusterTenantIsolationTier, ClusterTenantResourceQuota } from "@opencrane/contracts";

/** Compute placement block accepted on the cluster-tenant write path. */
export interface ClusterTenantComputeInput
{
  /** Whether the customer shares nodes or gets a dedicated pool. */
  mode: ClusterTenantComputeMode;
  /** Dedicated node pool name; required when `mode` is `dedicated`. */
  nodePool?: string;
}

/** Resource-gating block accepted on the cluster-tenant write path. */
export interface ClusterTenantResourcesInput
{
  /** Aggregate quota enforced across the customer's namespace. */
  quota: ClusterTenantResourceQuota;
}

/** Request body used to create a cluster tenant. */
export interface ClusterTenantCreateRequest
{
  /** Stable cluster-scoped identifier (the customer key). */
  name: string;
  /** Human-readable customer name. */
  displayName: string;
  /** Optional customer-vanity domain CNAMEd onto the org's derived apex; an overlay, not the org identity. */
  vanityDomain?: string;
  /** Isolation strength chosen for this customer. */
  isolationTier: ClusterTenantIsolationTier;
  /** Compute placement policy. */
  compute: ClusterTenantComputeInput;
  /** Resource gating for the customer's namespace. */
  resources: ClusterTenantResourcesInput;
}

/** Request body used to update a cluster tenant (name is immutable, taken from the path). */
export interface ClusterTenantUpdateRequest
{
  /** New human-readable customer name. */
  displayName?: string;
  /** New customer-vanity domain CNAMEd onto the org apex (empty string clears it). */
  vanityDomain?: string;
  /** New isolation strength. */
  isolationTier?: ClusterTenantIsolationTier;
  /** New compute placement policy. */
  compute?: ClusterTenantComputeInput;
  /** New resource gating block. */
  resources?: ClusterTenantResourcesInput;
}
