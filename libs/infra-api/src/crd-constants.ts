/**
 * Shared Kubernetes CRD constants used by routers, controllers, and drift detection
 * across both the fleet-manager and clustertenant-manager. Consolidates the API group,
 * version, and resource plural names in one place to avoid duplication.
 */

/** Kubernetes API group for OpenCrane custom resources. */
export const OPENCRANE_API_GROUP = "opencrane.io";

/** Kubernetes API version for OpenCrane custom resources. */
export const OPENCRANE_API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
export const TENANT_CRD_PLURAL = "tenants";

/** Plural resource name for the AccessPolicy CRD. */
export const POLICY_CRD_PLURAL = "accesspolicies";

/**
 * Alias of {@link POLICY_CRD_PLURAL}. The fleet-manager's controllers historically
 * referred to this CRD as `ACCESS_POLICY_CRD_PLURAL`; both names resolve to the same
 * plural so either codebase reads naturally.
 */
export const ACCESS_POLICY_CRD_PLURAL = POLICY_CRD_PLURAL;

/** Plural resource name for the cluster-scoped ClusterTenant CRD. */
export const CLUSTER_TENANT_CRD_PLURAL = "clustertenants";
