import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig, Tenant } from "./types.js";
import { applyResource, deleteResource } from "./reconciler.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Watches Tenant custom resources and reconciles the corresponding
 * Kubernetes workloads (Deployment, Service, Ingress, ConfigMap, PVC).
 */
export class TenantOperator
{
  /** Client for managing custom object subresources (status updates). */
  private customApi: k8s.CustomObjectsApi;

  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Watch client for streaming Tenant CR events. */
  private watch: k8s.Watch;

  /** Scoped logger for tenant-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

  /**
   * Create a new TenantOperator bound to the given KubeConfig.
   */
  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger)
  {
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.watch = new k8s.Watch(kc);
    this.config = config;
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
      try {
        await this.watch.watch(
          path,
          {},
          (type: string, tenant: Tenant) => {
            this.handleEvent(type, tenant).catch((err) => {
              this.log.error({ err, tenant: tenant.metadata?.name }, "reconcile failed");
            });
          },
          (err) => {
            if (err) {
              this.log.error({ err }, "watch connection lost, reconnecting...");
            }
            setTimeout(watchLoop, 5000);
          },
        );
      } catch (err) {
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

    switch (type) {
      case "ADDED":
      case "MODIFIED":
        if (tenant.spec.suspended) {
          await this.suspendTenant(tenant);
        } else {
          await this.reconcileTenant(tenant);
        }
        break;
      case "DELETED":
        await this.cleanupTenant(tenant);
        break;
    }
  }

  /**
   * Reconcile all child resources for a running tenant: PVC, ConfigMap,
   * Deployment, Service, Ingress, and update the Tenant status.
   */
  async reconcileTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "reconciling tenant");

    // 1. Create/update PVC for tenant state
    await applyResource(this.objectApi, this._buildPvc(tenant, namespace), this.log);

    // 2. Create/update ConfigMap with merged OpenClaw config
    await applyResource(this.objectApi, this._buildConfigMap(tenant, namespace), this.log);

    // 3. Create/update Deployment (single-pod OpenClaw instance)
    await applyResource(this.objectApi, this._buildDeployment(tenant, namespace), this.log);

    // 4. Create/update Service
    await applyResource(this.objectApi, this._buildService(tenant, namespace), this.log);

    // 5. Create/update Ingress rule
    await applyResource(this.objectApi, this._buildIngress(tenant, namespace), this.log);

    // 6. Update tenant status
    await this._updateStatus(tenant, namespace, {
      phase: "Running",
      podName: `openclaw-${name}`,
      ingressHost: `${name}.${this.config.ingressDomain}`,
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Suspend a tenant by scaling the deployment to zero replicas while
   * preserving the PVC and other resources.
   */
  private async suspendTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "suspending tenant");

    // Scale deployment to 0 but keep PVC
    const deployment = this._buildDeployment(tenant, namespace);
    deployment.spec!.replicas = 0;
    await applyResource(this.objectApi, deployment, this.log);

    await this._updateStatus(tenant, namespace, {
      phase: "Suspended",
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Remove all child resources for a deleted tenant except the PVC,
   * which is intentionally retained to preserve data.
   */
  private async cleanupTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "cleaning up tenant resources");

    // Delete in reverse order (ingress, service, deployment, configmap)
    // PVC is intentionally kept to preserve data
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

    this.log.info({ name }, "tenant cleanup complete (PVC retained)");
  }

  /**
   * Build a PersistentVolumeClaim for the tenant's state directory.
   */
  private _buildPvc(tenant: Tenant, namespace: string): k8s.V1PersistentVolumeClaim
  {
    const name = tenant.metadata!.name!;
    return {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: `openclaw-${name}-state`,
        namespace,
        labels: this._tenantLabels(name),
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: { storage: "1Gi" },
        },
      },
    };
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

    // Merge config overrides from Tenant CR
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
   * Build a Deployment running a single-replica OpenClaw gateway pod
   * with state, config, and shared-skills volume mounts.
   */
  private _buildDeployment(tenant: Tenant, namespace: string): k8s.V1Deployment
  {
    const name = tenant.metadata!.name!;
    const image = tenant.spec.openclawImage ?? this.config.tenantDefaultImage;
    const resources = tenant.spec.resources;

    const envVars: k8s.V1EnvVar[] = [
      { name: "OPENCLAW_STATE_DIR", value: "/data/openclaw" },
    ];

    const volumeMounts: k8s.V1VolumeMount[] = [
      { name: "state", mountPath: "/data/openclaw" },
      { name: "config", mountPath: "/config", readOnly: true },
    ];

    const volumes: k8s.V1Volume[] = [
      {
        name: "state",
        persistentVolumeClaim: { claimName: `openclaw-${name}-state` },
      },
      {
        name: "config",
        configMap: { name: `openclaw-${name}-config` },
      },
    ];

    // Mount shared skills if configured
    volumeMounts.push({
      name: "shared-skills",
      mountPath: "/shared-skills",
      readOnly: true,
    });
    volumes.push({
      name: "shared-skills",
      persistentVolumeClaim: {
        claimName: this.config.sharedSkillsPvcName,
        readOnly: true,
      },
    });

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
              ...(tenant.spec.team
                ? { "opencrane.io/team": tenant.spec.team }
                : {}),
            },
          },
          spec: {
            containers: [
              {
                name: "openclaw",
                image,
                ports: [
                  {
                    name: "gateway",
                    containerPort: this.config.gatewayPort,
                  },
                ],
                env: envVars,
                envFrom: [
                  {
                    secretRef: {
                      name: "org-shared-secrets",
                      optional: true,
                    },
                  },
                ],
                volumeMounts,
                resources: resources
                  ? {
                      requests: {
                        ...(resources.cpu ? { cpu: resources.cpu } : {}),
                        ...(resources.memory
                          ? { memory: resources.memory }
                          : {}),
                      },
                    }
                  : undefined,
                livenessProbe: {
                  httpGet: {
                    path: "/healthz",
                    port: this.config.gatewayPort as never,
                  },
                  initialDelaySeconds: 10,
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
   */
  private _buildIngress(tenant: Tenant, namespace: string): k8s.V1Ingress
  {
    const name = tenant.metadata!.name!;
    const host = `${name}.${this.config.ingressDomain}`;

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
    try {
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { status: { ...tenant.status, ...status } },
      });
    } catch (err) {
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

/** Re-export for status update typing. */
type TenantStatus = import("./types.js").TenantStatus;
