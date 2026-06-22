import type * as k8s from "@kubernetes/client-node";

import { HostingProvider } from "../../hosting-adapter.types.js";
import type { GcpHostingConfig, HostingAdapter, TenantStateVolume, TenantStorageBinding, TenantStorageRequest } from "../../hosting-adapter.types.js";
import type { GcsBucketOperations } from "./gcp-bucket.client.js";

/** Hosting adapter for GKE: Workload Identity + GCS Fuse CSI + in-operator bucket provisioning. */
export class GcpHostingAdapter implements HostingAdapter
{
  /** @inheritdoc */
  public readonly provider: HostingProvider = HostingProvider.Gcp;

  /** GCP-only configuration (project, bucket prefix, CSI driver). */
  private readonly config: GcpHostingConfig;

  /** GCS operations client (injected for testability). */
  private readonly buckets: GcsBucketOperations;

  /**
   * @param config - GCP hosting configuration.
   * @param buckets - GCS client (inject a fake in unit tests).
   */
  public constructor(config: GcpHostingConfig, buckets: GcsBucketOperations)
  {
    this.config = config;
    this.buckets = buckets;
  }

  /** Create the tenant's GCS bucket via the cloud SDK (Workload Identity auth, idempotent). */
  public async provisionTenantStorage(request: TenantStorageRequest): Promise<TenantStorageBinding>
  {
    const bucketName = `${this.config.bucketPrefix}-${request.tenantName}`;

    // 1. Ensure the bucket exists. Idempotent so repeated reconciles are safe.
    await this.buckets.ensureBucket(bucketName);

    return { externalName: bucketName };
  }

  /** Buckets are retained on tenant deletion to avoid accidental data loss. */
  public async deprovisionTenantStorage(_tenantName: string): Promise<void>
  {
    return;
  }

  /** GKE Workload Identity annotation binding the KSA to a per-tenant GSA. */
  public buildServiceAccountIdentity(tenantName: string): Record<string, string>
  {
    return {
      "iam.gke.io/gcp-service-account": `openclaw-${tenantName}@${this.config.projectId}.iam.gserviceaccount.com`,
    };
  }

  /** GCS Fuse CSI volume mounting the tenant bucket into the pod. */
  public buildStateVolume(tenantName: string): TenantStateVolume
  {
    const volume: k8s.V1Volume = {
      name: "tenant-storage",
      csi: {
        driver: this.config.csiDriver,
        volumeAttributes: { bucketName: `${this.config.bucketPrefix}-${tenantName}` },
      },
    } as k8s.V1Volume;

    return {
      volume,
      volumeMount: { name: "tenant-storage", mountPath: "/data/openclaw" },
      requiresPvc: false,
    };
  }

}
