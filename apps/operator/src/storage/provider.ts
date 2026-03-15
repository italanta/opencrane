import type { KubernetesObject } from "@kubernetes/client-node";

/** Information about a provisioned storage bucket. */
export interface BucketInfo
{
  /** Full bucket name (e.g. "opencrane-jente"). */
  bucketName: string;
  /** Cloud provider this bucket lives on. */
  provider: string;
}

/**
 * Cloud storage provisioning contract.
 * Implementations create/destroy per-tenant storage buckets.
 */
export interface StorageProvider
{
  /** Provision a storage bucket/container for a tenant. */
  provisionBucket(tenantName: string): Promise<BucketInfo>;
  /** Deprovision a tenant's storage bucket/container. */
  deprovisionBucket(tenantName: string): Promise<void>;
}

/**
 * Builds a Crossplane BucketClaim custom resource for a tenant.
 * The Crossplane controller provisions the actual cloud storage bucket.
 * @param tenantName - Unique tenant identifier
 * @param namespace - Kubernetes namespace
 * @param bucketPrefix - Prefix for bucket naming (e.g. "opencrane")
 * @returns A Kubernetes object representing the BucketClaim CR
 */
export function buildBucketClaim(tenantName: string, namespace: string, bucketPrefix: string): KubernetesObject
{
  return {
    apiVersion: "storage.opencrane.io/v1alpha1",
    kind: "BucketClaim",
    metadata: {
      name: `openclaw-${tenantName}-bucket`,
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-operator",
        "opencrane.io/tenant": tenantName,
      },
    },
    spec: {
      bucketName: `${bucketPrefix}-${tenantName}`,
      tenantName,
    },
  } as KubernetesObject;
}
