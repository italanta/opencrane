import * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../config.js";
import type { Tenant } from "./types.js";
import { TenantDomains } from "./tenant-domains.js";

/**
 * Pure resource builder for tenant-managed Kubernetes objects.
 */
export class TenantResourceBuilder
{
  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

  /** Helper for tenant host and domain conventions. */
  private tenantDomains: TenantDomains;

  /**
   * Create a new tenant resource builder.
   */
  constructor(config: OperatorConfig, tenantDomains: TenantDomains)
  {
    this.config = config;
    this.tenantDomains = tenantDomains;
  }

  /**
   * Build a ServiceAccount for the tenant pod.
   * When GCP storage is configured, includes the Workload Identity annotation.
   */
  buildServiceAccount(tenant: Tenant, namespace: string): k8s.V1ServiceAccount
  {
    const name = tenant.metadata!.name!;
    const annotations: Record<string, string> = {};

    if (this.config.storageProvider === "gcs" && this.config.gcpProject)
    {
      annotations["iam.gke.io/gcp-service-account"] =
        `openclaw-${name}@${this.config.gcpProject}.iam.gserviceaccount.com`;
    }

    return {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this.buildTenantLabels(name),
        annotations,
      },
    };
  }

  /**
   * Build a ConfigMap containing merged OpenClaw JSON configuration.
   */
  buildConfigMap(tenant: Tenant, namespace: string): k8s.V1ConfigMap
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
        labels: this.buildTenantLabels(name),
      },
      data: {
        "openclaw.json": JSON.stringify(merged, null, 2),
      },
    };
  }

  /**
   * Build a Deployment running a single-replica OpenClaw gateway pod.
   */
  buildDeployment(tenant: Tenant, namespace: string): k8s.V1Deployment
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
        labels: this.buildTenantLabels(name),
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { "opencrane.io/tenant": name },
        },
        template: {
          metadata: {
            labels: {
              ...this.buildTenantLabels(name),
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
  buildService(tenant: Tenant, namespace: string): k8s.V1Service
  {
    const name = tenant.metadata!.name!;
    return {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this.buildTenantLabels(name),
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
  buildIngress(tenant: Tenant, namespace: string): k8s.V1Ingress
  {
    const name = tenant.metadata!.name!;
    const host = this.tenantDomains.buildIngressHost(name);

    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: `openclaw-${name}`,
        namespace,
        labels: this.buildTenantLabels(name),
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
   * Return the standard set of labels applied to all tenant-owned resources.
   */
  buildTenantLabels(name: string): Record<string, string>
  {
    return {
      "app.kubernetes.io/part-of": "opencrane",
      "app.kubernetes.io/component": "tenant",
      "app.kubernetes.io/managed-by": "opencrane-operator",
      "opencrane.io/tenant": name,
    };
  }
}
