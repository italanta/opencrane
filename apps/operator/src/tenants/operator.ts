import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../config.js";

import type { Tenant } from "./models/tenant.interface.js";
import { TenantStatusPhase } from "./models/tenant-status.interface.js";

import { _K8sApplyResource } from "../infra/k8s.js";
import { _RunWatchLoop, K8sWatchEventType } from "../shared/watch-runner.js";
import { _BuildGCPBucketClaim } from "../storage/provider.js";
import { _BuildConfigMap, _BuildDeployment, _BuildIngress, _BuildIngressHost, _BuildService, _BuildServiceAccount, _BuildStatePvc } from "./deploy/index.js";
import { TenantCleanup } from "./destroy/tenant-cleanup.js";

import { TenantEncryptionKeys } from "./internal/tenant-encryption-keys.js";
import { TenantLiteLlmKeys } from "./internal/tenant-litellm-keys.js";
import { TenantStatusWriter } from "./internal/tenant-status-writer.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Watches Tenant custom resources and reconciles the corresponding
 * Kubernetes workloads.
 *
 * All dependencies are injected via the constructor — use
 * {@link _CreateTenantOperator} to assemble from a raw KubeConfig in
 * production entry-points, and pass mocks directly in tests.
 */
export class TenantOperator
{
  /** Watch client for streaming Tenant CR events. */
  private watch: k8s.Watch;

  /** Client for custom resources (e.g., BucketClaim). */
  private customApi: k8s.CustomObjectsApi;

  /** Client for CoreV1 resources (ServiceAccount, Secret, ConfigMap, Service). */
  private coreApi: k8s.CoreV1Api;

  /** Client for AppsV1 resources (Deployment). */
  private appsApi: k8s.AppsV1Api;

  /** Client for NetworkingV1 resources (Ingress). */
  private networkingApi: k8s.NetworkingV1Api;

  /** Scoped logger for tenant-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OpenClawTenantOperatorConfig;

  /** Helper for removing tenant-owned resources during delete flows. */
  private cleanup: TenantCleanup;

  /** Helper for patching Tenant status subresource. */
  private statusWriter: TenantStatusWriter;

  /** Helper for per-tenant AES encryption key Secret lifecycle. */
  private encryptionKeys: TenantEncryptionKeys;

  /** Helper for LiteLLM virtual key provisioning and Secret creation. */
  private liteLlmKeys: TenantLiteLlmKeys;

  /**
   * Create a new TenantOperator with pre-wired dependencies.
   * Prefer {@link _CreateTenantOperator} in production entry-points.
   */
  constructor(watch: k8s.Watch,
              customApi: k8s.CustomObjectsApi,
              coreApi: k8s.CoreV1Api,
              appsApi: k8s.AppsV1Api,
              networkingApi: k8s.NetworkingV1Api,
              log: Logger,
              config: OpenClawTenantOperatorConfig,
              cleanup: TenantCleanup,
              statusWriter: TenantStatusWriter,
              encryptionKeys: TenantEncryptionKeys,
              liteLlmKeys: TenantLiteLlmKeys)
  {
    this.watch = watch;
    this.customApi = customApi;
    this.coreApi = coreApi;
    this.appsApi = appsApi;
    this.networkingApi = networkingApi;
    this.log = log;
    this.config = config;
    this.cleanup = cleanup;
    this.statusWriter = statusWriter;
    this.encryptionKeys = encryptionKeys;
    this.liteLlmKeys = liteLlmKeys;
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
      onEvent: async (type: K8sWatchEventType | string, tenant: Tenant) => {
        await this.handleEvent(type, tenant);
      },
    });
  }

  /**
   * Route a watch event to the appropriate reconciliation handler.
   */
  private async handleEvent(type: K8sWatchEventType | string, tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "tenant event");

    switch (type)
    {
      case K8sWatchEventType.Added:
      case K8sWatchEventType.Modified:
        if (tenant.spec.suspended)
        {
          await this.suspendTenant(tenant);
        }
        else
        {
          await this.reconcileTenant(tenant);
        }
        break;
      case K8sWatchEventType.Deleted:
        await this.cleanupTenant(tenant);
        break;
    }
  }

  /**
   * Reconcile all child resources for a running tenant and update status.
   *
   * Reconciliation is idempotent: it can be called repeatedly on the same
   * Tenant CR and will converge to the desired state without side effects.
   * Each child resource is applied via server-side apply, so existing
   * resources are updated in-place and missing ones are created.
   *
   * The reconcile order matters: later resources depend on earlier ones.
   * ServiceAccount must exist before the Deployment can reference it;
   * the encryption key Secret must exist before the Deployment mounts it;
   * the ConfigMap must exist before the Deployment reads it.
   *
   * On any failure the error is caught, `status.phase` is set to `"Error"`
   * with the error message, and the error is re-thrown so the watch loop
   * logs it and the event is not silently swallowed.
   */
  async reconcileTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "reconciling tenant");

    try
    {
      // 1. ServiceAccount — grants the tenant pod a GCP service account identity
      //    via Workload Identity, scoped to this tenant's GCS bucket and IAM bindings.
      await _K8sApplyResource(this.coreApi, _BuildServiceAccount(this.config, tenant, namespace), this.log);

      // 2. BucketClaim — requests a per-tenant GCS bucket via Crossplane.
      //    Skipped when cloud storage or Crossplane is not configured (PVC fallback).
      if (this.config.storageProvider && this.config.crossplaneEnabled)
      {
        await _K8sApplyResource(
          this.customApi,
          _BuildGCPBucketClaim(name, namespace, this.config.bucketPrefix),
          this.log,
        );
      }

      // 3. Encryption key Secret — generates a random 32-byte AES key on first reconcile
      //    and stores it as a K8s Secret. Idempotent: existing secrets are not rotated.
      await this.encryptionKeys.ensureEncryptionKeySecret(name, namespace);

      // 4. LiteLLM key Secret — creates a per-tenant virtual key in LiteLLM and stores
      //    it in a tenant Secret mounted through env var. Skipped when LiteLLM is disabled.
      await this.liteLlmKeys.ensureLiteLlmKeySecret(tenant, namespace);

      // 5. ConfigMap — serialises the base OpenClaw JSON config merged with any
      //    spec.configOverrides the tenant author provided.
      await _K8sApplyResource(this.coreApi, _BuildConfigMap(this.config, tenant, namespace), this.log);

      // 6. Tenant state PVC — used only when cloud storage is disabled.
      if (!this.config.storageProvider)
      {
        await _K8sApplyResource(this.coreApi, _BuildStatePvc(name, namespace), this.log);
      }

      // 7. Deployment — single-replica pod running the tenant's OpenClaw gateway.
      //    Mounts the ConfigMap, encryption key, GCS volume (or PVC), and shared skills.
      await _K8sApplyResource(this.appsApi, _BuildDeployment(this.config, tenant, namespace), this.log);

      // 8. Service — ClusterIP that makes the gateway reachable inside the cluster
      //    on the configured gateway port.
      await _K8sApplyResource(this.coreApi, _BuildService(this.config, tenant, namespace), this.log);

      // 9. Ingress — routes external HTTPS traffic for {tenant}.{domain} to the Service.
      await _K8sApplyResource(this.networkingApi, _BuildIngress(this.config, tenant, namespace), this.log);

      // 10. Status — write the observed Running state back to the Tenant CR so that
      //    kubectl, the control-plane API, and the UI all see the current phase.
      await this.statusWriter.patchStatus(tenant, namespace, {
        phase: TenantStatusPhase.Running,
        podName: `openclaw-${name}`,
        ingressHost: _BuildIngressHost(name, this.config.ingressDomain),
        lastReconciled: new Date().toISOString(),
      });
    }
    catch (err)
    {
      this.log.error({ err, name }, "reconcile failed");
      await this.statusWriter.patchStatus(tenant, namespace, {
        phase: TenantStatusPhase.Error,
        message: err instanceof Error ? err.message : String(err),
        lastReconciled: new Date().toISOString(),
      });
      throw err;
    }
  }

  /**
   * Suspend a tenant by scaling the deployment to zero replicas.
   */
  private async suspendTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "suspending tenant");

    const deployment = _BuildDeployment(this.config, tenant, namespace);
    deployment.spec!.replicas = 0;
    await _K8sApplyResource(this.appsApi, deployment, this.log);

    await this.statusWriter.patchStatus(tenant, namespace, {
      phase: TenantStatusPhase.Suspended,
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

}

/**
 * Wire all dependencies from a KubeConfig and return a ready-to-start TenantOperator.
 *
 * This factory owns all K8s client construction so that `TenantOperator` itself
 * only depends on the abstractions it actually needs. Use this from application
 * entry-points; inject helpers directly in tests.
 *
 * @param kc - Resolved KubeConfig (cluster or in-cluster credentials).
 * @param config - Operator runtime configuration from environment variables.
 * @param baseLog - Root pino logger; scoped to `tenant-operator` component inside.
 */
export function _CreateTenantOperator(kc: k8s.KubeConfig, config: OpenClawTenantOperatorConfig, baseLog: Logger): TenantOperator
{
  // 1. K8s API clients — each scoped to one API group; none leak into TenantOperator directly.
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  const watch = new k8s.Watch(kc);

  // 2. Scoped logger — child-scoped here so all tenant-operator log lines share the label.
  const log = baseLog.child({ component: "tenant-operator" });

  // 3. K8s helpers — each receives only the API clients it actually calls.
  const cleanup = new TenantCleanup(objectApi, log);
  const statusWriter = new TenantStatusWriter(customApi, log);
  const encryptionKeys = new TenantEncryptionKeys(coreApi, objectApi, log);
  const liteLlmKeys = new TenantLiteLlmKeys(config, coreApi, objectApi, log);

  return new TenantOperator(watch, customApi, coreApi, appsApi, networkingApi, log, config, cleanup, statusWriter, encryptionKeys, liteLlmKeys);
}

