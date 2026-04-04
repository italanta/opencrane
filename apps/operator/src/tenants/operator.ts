import { randomBytes } from "node:crypto";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig } from "../config.js";
import { applyResource } from "../infra/k8s.js";
import { _RunWatchLoop } from "../shared/watch-runner.js";
import { buildBucketClaim } from "../storage/provider.js";
import { TenantCleanup } from "./tenant-cleanup.js";
import { TenantDomains } from "./tenant-domains.js";
import { TenantResourceBuilder } from "./tenant-resource-builder.js";
import { TenantStatusWriter } from "./tenant-status-writer.js";
import type { Tenant } from "./types.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Watches Tenant custom resources and reconciles the corresponding
 * Kubernetes workloads.
 */
export class TenantOperator
{
  /** Client for managing custom object subresources (status updates). */
  private customApi: k8s.CustomObjectsApi;

  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Client for core Kubernetes API operations (Secrets). */
  private coreApi: k8s.CoreV1Api;

  /** Watch client for streaming Tenant CR events. */
  private watch: k8s.Watch;

  /** Scoped logger for tenant-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

  /** Helper for tenant host and domain conventions. */
  private tenantDomains: TenantDomains;

  /** Builder for tenant-managed Kubernetes resources. */
  private resourceBuilder: TenantResourceBuilder;

  /** Helper for removing tenant-owned resources during delete flows. */
  private cleanup: TenantCleanup;

  /** Helper for patching Tenant status subresource. */
  private statusWriter: TenantStatusWriter;

  /**
   * Create a new TenantOperator bound to the given KubeConfig.
   */
  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger)
  {
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.watch = new k8s.Watch(kc);
    this.config = config;
    this.tenantDomains = new TenantDomains(config.ingressDomain);
    this.resourceBuilder = new TenantResourceBuilder(config, this.tenantDomains);
    this.cleanup = new TenantCleanup(this.objectApi, log);
    this.statusWriter = new TenantStatusWriter(this.customApi, log);
    this.log = log.child({ component: "tenant-operator" });
  }

  /**
   * Begin watching for Tenant CR events and reconcile on each change.
   * Automatically reconnects on watch errors with a 5-second backoff.
   */
  async start(): Promise<void>
  {
    const ns = this.config.watchNamespace;
    const path = ns
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${ns}/${PLURAL}`
      : `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}`;

    await _RunWatchLoop<Tenant>({
      watch: this.watch,
      path,
      log: this.log,
      startMessage: "starting tenant watch",
      reconnectMessage: "watch connection lost, reconnecting...",
      failedMessage: "watch failed, retrying...",
      onEvent: async (type: string, tenant: Tenant) => {
        await this.handleEvent(type, tenant);
      },
    });
  }

  /**
   * Route a watch event to the appropriate reconciliation handler.
   */
  private async handleEvent(type: string, tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "tenant event");

    switch (type)
    {
      case "ADDED":
      case "MODIFIED":
        if (tenant.spec.suspended)
        {
          await this.suspendTenant(tenant);
        }
        else
        {
          await this.reconcileTenant(tenant);
        }
        break;
      case "DELETED":
        await this.cleanupTenant(tenant);
        break;
    }
  }

  /**
   * Reconcile all child resources for a running tenant and update status.
   */
  async reconcileTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "reconciling tenant");

    await applyResource(this.objectApi, this.resourceBuilder.buildServiceAccount(tenant, namespace), this.log);

    if (this.config.storageProvider && this.config.crossplaneEnabled)
    {
      await applyResource(
        this.objectApi,
        buildBucketClaim(name, namespace, this.config.bucketPrefix),
        this.log,
      );
    }

    await this._ensureEncryptionKeySecret(name, namespace);

    await applyResource(this.objectApi, this.resourceBuilder.buildConfigMap(tenant, namespace), this.log);
    await applyResource(this.objectApi, this.resourceBuilder.buildDeployment(tenant, namespace), this.log);
    await applyResource(this.objectApi, this.resourceBuilder.buildService(tenant, namespace), this.log);
    await applyResource(this.objectApi, this.resourceBuilder.buildIngress(tenant, namespace), this.log);

    await this.statusWriter.patchStatus(tenant, namespace, {
      phase: "Running",
      podName: `openclaw-${name}`,
      ingressHost: this.tenantDomains.buildIngressHost(name),
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Suspend a tenant by scaling the deployment to zero replicas.
   */
  private async suspendTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "suspending tenant");

    const deployment = this.resourceBuilder.buildDeployment(tenant, namespace);
    deployment.spec!.replicas = 0;
    await applyResource(this.objectApi, deployment, this.log);

    await this.statusWriter.patchStatus(tenant, namespace, {
      phase: "Suspended",
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Remove child resources for a deleted tenant.
   * Retains: BucketClaim and encryption key Secret.
   */
  private async cleanupTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "cleaning up tenant resources");

    await this.cleanup.cleanupTenant(name, namespace);

    this.log.info({ name }, "tenant cleanup complete (bucket + encryption key retained)");
  }

  /**
   * Ensure an encryption key Secret exists for the tenant.
   */
  private async _ensureEncryptionKeySecret(name: string, namespace: string): Promise<void>
  {
    const secretName = `openclaw-${name}-encryption-key`;

    try
    {
      await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
      this.log.debug({ name, secretName }, "encryption key secret already exists");
    }
    catch
    {
      const key = randomBytes(32).toString("base64");
      const secret: k8s.V1Secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretName,
          namespace,
          labels: this.resourceBuilder.buildTenantLabels(name),
        },
        type: "Opaque",
        data: { key },
      };

      await applyResource(this.objectApi, secret, this.log);
      this.log.info({ name, secretName }, "created encryption key secret");
    }
  }

}
