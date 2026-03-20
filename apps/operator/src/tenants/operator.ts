import { randomBytes } from "node:crypto";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig } from "../config.js";
import type { Tenant, TenantStatus } from "./types.js";
import { applyResource, deleteResource } from "../infra/k8s.js";
import { buildBucketClaim } from "../storage/provider.js";
import { TenantDomains } from "./tenant-domains.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Watches Tenant custom resources and reconciles the corresponding
 * Kubernetes workloads (Deployment, Service, Ingress, ConfigMap,
 * ServiceAccount, BucketClaim, encryption key Secret).
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

    this.log.info({ path }, "starting tenant watch");

    const watchLoop = async () => {
      try
      {
        await this.watch.watch(
          path,
          {},
          (type: string, tenant: Tenant) => {
            this.handleEvent(type, tenant).catch((err) => {
              this.log.error({ err, tenant: tenant.metadata?.name }, "reconcile failed");
            });
          },
          (err) => {
            if (err)
            {
              this.log.error({ err }, "watch connection lost, reconnecting...");
            }
            setTimeout(watchLoop, 5000);
          },
        );
      }
      catch (err)
      {
        this.log.error({ err }, "watch failed, retrying...");
        setTimeout(watchLoop, 5000);
      }
    };

    await watchLoop();
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
   * Reconcile all child resources for a running tenant: ServiceAccount,
   * BucketClaim (if cloud storage enabled), encryption key Secret,
   * ConfigMap, Deployment, Service, Ingress, and update the Tenant status.
   */
  async reconcileTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "reconciling tenant");

    // 1. Create/update ServiceAccount (with Workload Identity if GCP)
    await applyResource(this.objectApi, this._buildServiceAccount(tenant, namespace), this.log);

    // 2. Create BucketClaim if cloud storage is enabled
    if (this.config.storageProvider && this.config.crossplaneEnabled)
    {
      await applyResource(
        this.objectApi,
        buildBucketClaim(name, namespace, this.config.bucketPrefix),
        this.log,
      );
    }

    // 3. Create encryption key Secret (only if it doesn't exist)
    await this._ensureEncryptionKeySecret(name, namespace);

    // 4. Create/update ConfigMap with merged OpenClaw config
    await applyResource(this.objectApi, this._buildConfigMap(tenant, namespace), this.log);

    // 5. Create/update Deployment (single-pod OpenClaw instance)
    await applyResource(this.objectApi, this._buildDeployment(tenant, namespace), this.log);

    // 6. Create/update Service
    await applyResource(this.objectApi, this._buildService(tenant, namespace), this.log);

    // 7. Create/update Ingress rule
    await applyResource(this.objectApi, this._buildIngress(tenant, namespace), this.log);

    // 8. Update tenant status
    await this._updateStatus(tenant, namespace, {
      phase: "Running",
      podName: `openclaw-${name}`,
      ingressHost: this.tenantDomains.buildIngressHost(name),
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Suspend a tenant by scaling the deployment to zero replicas while
   * preserving cloud storage and other resources.
   */
  private async suspendTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "suspending tenant");

    const deployment = this._buildDeployment(tenant, namespace);
    deployment.spec!.replicas = 0;
    await applyResource(this.objectApi, deployment, this.log);

    await this._updateStatus(tenant, namespace, {
      phase: "Suspended",
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Remove child resources for a deleted tenant.
   * Retains: BucketClaim (data preservation), encryption key Secret (recovery).
   */
  private async cleanupTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "cleaning up tenant resources");

    await deleteResource(this.objectApi, {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: `openclaw-${name}-config`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    this.log.info({ name }, "tenant cleanup complete (bucket + encryption key retained)");
  }

  /**
   * Build a ServiceAccount for the tenant pod.
   * When GCP storage is configured, includes the Workload Identity annotation
   * so the pod can access its GCS bucket via IAM.
   */
  private _buildServiceAccount(tenant: Tenant, namespace: string): k8s.V1ServiceAccount
  {
    const name = tenant.metadata!.name!;
    const annotations: Record<string, string> = {};

    if (this.config.storageProvider === "gcs" && this.config.gcpProject)
    {
      annotations["iam.gke.io/gcp-service-account"] =
        `opencrane-${name}@${this.config.gcpProject}.iam.gserviceaccount.com`;
    }

    return {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this._tenantLabels(name),
        annotations,
      },
    };
  }

  /**
   * Ensure an encryption key Secret exists for the tenant.
   * Creates a new one with a random 256-bit key if none exists.
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
          labels: this._tenantLabels(name),
        },
        type: "Opaque",
        data: { key },
      };

      await applyResource(this.objectApi, secret, this.log);
      this.log.info({ name, secretName }, "created encryption key secret");
    }
  }

  /**
   * Build a ConfigMap containing the merged OpenClaw JSON configuration.
   */
  private _buildConfigMap(tenant: Tenant, namespace: string): k8s.V1ConfigMap
  {
    const name = tenant.metadata!.name!;
    const baseConfig = {
      gateway: {
        mode: "local",
        port: this.config.gatewayPort,
        bind: "lan",
      },
      agents: {
        defaults: {
          thinking: "medium",
        },
      },
    };

    const merged = tenant.spec.configOverrides
      ? { ...baseConfig, ...tenant.spec.configOverrides }
      : baseConfig;

    return {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: `openclaw-${name}-config`,
        namespace,
        labels: this._tenantLabels(name),
      },
      data: {
        "openclaw.json": JSON.stringify(merged, null, 2),
      },
    };
  }

  /**
   * Build a Deployment running a single-replica OpenClaw gateway pod.
   * Uses GCS Fuse CSI for tenant storage when cloud storage is configured,
   * otherwise falls back to a PVC.
   */
  private _buildDeployment(tenant: Tenant, namespace: string): k8s.V1Deployment
  {
    const name = tenant.metadata!.name!;
    const image = tenant.spec.openclawImage ?? this.config.tenantDefaultImage;
    const resources = tenant.spec.resources;
    const openclawVersion = tenant.spec.openclawVersion ?? "latest";

    const envVars: k8s.V1EnvVar[] = [
      { name: "OPENCLAW_STATE_DIR", value: "/data/openclaw" },
      { name: "OPENCLAW_SECRETS_DIR", value: "/data/secrets" },
      { name: "OPENCLAW_ENCRYPTION_KEY_PATH", value: "/etc/openclaw/encryption-key/key" },
      { name: "OPENCLAW_TENANT_NAME", value: name },
      { name: "OPENCLAW_VERSION", value: openclawVersion },
    ];

    const volumeMounts: k8s.V1VolumeMount[] = [
      { name: "config", mountPath: "/config", readOnly: true },
      { name: "shared-skills", mountPath: "/shared-skills", readOnly: true },
      { name: "pod-secrets", mountPath: "/data/secrets" },
      { name: "encryption-key", mountPath: "/etc/openclaw/encryption-key", readOnly: true },
    ];

    const volumes: k8s.V1Volume[] = [
      { name: "config", configMap: { name: `openclaw-${name}-config` } },
      { name: "shared-skills", persistentVolumeClaim: { claimName: this.config.sharedSkillsPvcName, readOnly: true } },
      { name: "pod-secrets", emptyDir: { medium: "Memory", sizeLimit: "10Mi" } },
      { name: "encryption-key", secret: { secretName: `openclaw-${name}-encryption-key` } },
    ];

    // Tenant storage: GCS Fuse CSI or PVC fallback
    if (this.config.storageProvider && this.config.csiDriver)
    {
      volumeMounts.unshift({ name: "tenant-storage", mountPath: "/data/openclaw" });
      volumes.unshift({
        name: "tenant-storage",
        csi: {
          driver: this.config.csiDriver,
          volumeAttributes: {
            bucketName: `${this.config.bucketPrefix}-${name}`,
          },
        },
      } as k8s.V1Volume);
    }
    else
    {
      // PVC fallback for local/non-cloud environments
      volumeMounts.unshift({ name: "tenant-storage", mountPath: "/data/openclaw" });
      volumes.unshift({
        name: "tenant-storage",
        persistentVolumeClaim: { claimName: `openclaw-${name}-state` },
      });
    }

    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this._tenantLabels(name),
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { "opencrane.io/tenant": name },
        },
        template: {
          metadata: {
            labels: {
              ...this._tenantLabels(name),
              "opencrane.io/tenant": name,
              ...(tenant.spec.team ? { "opencrane.io/team": tenant.spec.team } : {}),
            },
          },
          spec: {
            serviceAccountName: `openclaw-${name}`,
            containers: [
              {
                name: "openclaw",
                image,
                ports: [{ name: "gateway", containerPort: this.config.gatewayPort }],
                env: envVars,
                envFrom: [
                  { secretRef: { name: "org-shared-secrets", optional: true } },
                ],
                volumeMounts,
                resources: resources
                  ? {
                      requests: {
                        ...(resources.cpu ? { cpu: resources.cpu } : {}),
                        ...(resources.memory ? { memory: resources.memory } : {}),
                      },
                    }
                  : undefined,
                livenessProbe: {
                  httpGet: {
                    path: "/healthz",
                    port: this.config.gatewayPort as never,
                  },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                },
              },
            ],
            volumes,
          },
        },
      },
    };
  }

  /**
   * Build a ClusterIP Service exposing the tenant gateway port.
   */
  private _buildService(tenant: Tenant, namespace: string): k8s.V1Service
  {
    const name = tenant.metadata!.name!;
    return {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this._tenantLabels(name),
      },
      spec: {
        selector: { "opencrane.io/tenant": name },
        ports: [
          {
            name: "gateway",
            port: this.config.gatewayPort,
            targetPort: this.config.gatewayPort as never,
          },
        ],
      },
    };
  }

  /**
   * Build an Ingress resource routing external traffic to the tenant service.
   *
   * Subdomain binding works as follows:
   * 1. The host is derived from the Tenant name and base domain:
   *    `{tenantName}.{INGRESS_DOMAIN}`.
   * 2. DNS wildcard records (for example `*.example.com`) are configured
   *    outside the operator and resolve all tenant hosts to the cluster
   *    ingress IP.
   * 3. This Ingress creates an HTTP host rule for that exact host and maps
   *    `path: /` to the tenant's `openclaw-{tenantName}` Service.
   * 4. The ingress controller receives the request, matches the Host header,
   *    and forwards traffic only to that tenant's backend Service/Pod.
   */
  private _buildIngress(tenant: Tenant, namespace: string): k8s.V1Ingress
  {
    const name = tenant.metadata!.name!;
    const host = this.tenantDomains.buildIngressHost(name);

    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this._tenantLabels(name),
        annotations: {
          "kubernetes.io/ingress.class": this.config.ingressClassName,
        },
      },
      spec: {
        ingressClassName: this.config.ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: `openclaw-${name}`,
                      port: { number: this.config.gatewayPort },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }

  /**
   * Patch the status subresource of a Tenant CR with the given fields.
   */
  private async _updateStatus(
    tenant: Tenant,
    namespace: string,
    status: Partial<TenantStatus>,
  ): Promise<void>
  {
    const name = tenant.metadata!.name!;
    try
    {
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { status: { ...tenant.status, ...status } },
      });
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to update tenant status");
    }
  }

  /**
   * Return the standard set of Kubernetes labels applied to every
   * resource owned by a given tenant.
   */
  private _tenantLabels(name: string): Record<string, string>
  {
    return {
      "app.kubernetes.io/part-of": "opencrane",
      "app.kubernetes.io/component": "tenant",
      "app.kubernetes.io/managed-by": "opencrane-operator",
      "opencrane.io/tenant": name,
    };
  }
}
