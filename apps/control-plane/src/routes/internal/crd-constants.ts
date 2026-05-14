/**
 * Shared Kubernetes CRD constants used by routers and drift detection.
 * Consolidates API group, version, and resource plural names in one place
 * to avoid duplication across tenant, policy, and drift code paths.
 */

/** Kubernetes API group for OpenCrane custom resources. */
export const OPENCRANE_API_GROUP = "opencrane.io";

/** Kubernetes API version for OpenCrane custom resources. */
export const OPENCRANE_API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
export const TENANT_CRD_PLURAL = "tenants";

/** Plural resource name for the AccessPolicy CRD. */
export const POLICY_CRD_PLURAL = "accesspolicies";
