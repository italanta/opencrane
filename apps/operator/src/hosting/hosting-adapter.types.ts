import type * as k8s from "@kubernetes/client-node";

/** Supported hosting substrates. On-prem is the default. */
export enum HostingProvider
{
  OnPrem = "onprem",
  Gcp = "gcp",
  Azure = "azure",
  Aws = "aws",
}

/** GCP-specific hosting configuration. Present only when hostingProvider === Gcp. */
export interface GcpHostingConfig
{
  /** GCP project ID used for Workload Identity bindings and bucket provisioning. */
  projectId: string;

  /** Prefix for per-tenant GCS bucket names ({prefix}-{tenantName}). */
  bucketPrefix: string;

  /** CSI driver name for mounting GCS Fuse volumes into pods. */
  csiDriver: string;
}

/** Request describing the tenant whose storage is being provisioned. */
export interface TenantStorageRequest
{
  /** Tenant CR name. */
  tenantName: string;

  /** Namespace the tenant runs in. */
  namespace: string;
}

/** Result of provisioning external storage for a tenant. */
export interface TenantStorageBinding
{
  /** Provider-native storage identifier (bucket name), or null on-prem. */
  externalName: string | null;
}

/** The pod's persistent state volume and how it is mounted. */
export interface TenantStateVolume
{
  /** Pod volume definition (cloud CSI mount, or PVC reference on-prem). */
  volume: k8s.V1Volume;

  /** Where the volume mounts inside the tenant container. */
  volumeMount: k8s.V1VolumeMount;

  /** True when the operator must also create a PersistentVolumeClaim (on-prem path). */
  requiresPvc: boolean;
}

/**
 * The single contract the operator depends on for all hosting-substrate concerns.
 * Cloud specifics live behind concrete adapters; on-prem is the default implementation.
 */
export interface HostingAdapter
{
  /** Identifier of the active provider, for logging and metrics. */
  readonly provider: HostingProvider;

  /** Provision external storage for a tenant. No-op (null externalName) on-prem. */
  provisionTenantStorage(request: TenantStorageRequest): Promise<TenantStorageBinding>;

  /** Release external storage for a tenant. No-op on-prem. */
  deprovisionTenantStorage(tenantName: string): Promise<void>;

  /** Identity annotations merged onto the tenant ServiceAccount. Empty on-prem. */
  buildServiceAccountIdentity(tenantName: string): Record<string, string>;

  /** The tenant pod state volume + mount, plus whether a PVC must be created. */
  buildStateVolume(tenantName: string): TenantStateVolume;
}
