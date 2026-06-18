import type { ModelRoutingScope } from "@opencrane/contracts";

/**
 * The minimal scope facts a {@link _ClusterTenantScopeGuard} needs about the resource a
 * mutation targets: at which scope it is owned, and (when ClusterTenant-scoped) by whom.
 */
export interface ClusterTenantScopedResource
{
  /** Whether the resource is platform-wide (`global`) or owned by one ClusterTenant. */
  scope: ModelRoutingScope;
  /** Owning ClusterTenant key when `scope` is `clusterTenant`; null/undefined for Global. */
  clusterTenant: string | null;
}
