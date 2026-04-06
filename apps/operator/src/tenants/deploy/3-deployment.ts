import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build a Deployment running a single-replica OpenClaw gateway pod.
 */
export function _BuildDeployment(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1Deployment
{
  const name = tenant.metadata!.name!;
  const image = tenant.spec.openclawImage ?? config.tenantDefaultImage;
  const resources = tenant.spec.resources;
  const openclawVersion = tenant.spec.openclawVersion ?? "latest";

  const envVars: k8s.V1EnvVar[] = [
    { name: "OPENCLAW_STATE_DIR", value: "/data/openclaw" },
    { name: "OPENCLAW_SECRETS_DIR", value: "/data/secrets" },
    { name: "OPENCLAW_ENCRYPTION_KEY_PATH", value: "/etc/openclaw/encryption-key/key" },
    { name: "OPENCLAW_TENANT_NAME", value: name },
    { name: "OPENCLAW_VERSION", value: openclawVersion },
    ...(config.liteLlmEnabled ? [{ name: "LITELLM_ENDPOINT", value: config.liteLlmEndpoint }] : []),
    ...(tenant.spec.team ? [{ name: "OPENCRANE_TEAM", value: tenant.spec.team }] : []),
  ];

  if (config.liteLlmEnabled)
  {
    envVars.push({
      name: "LITELLM_API_KEY",
      valueFrom: {
        secretKeyRef: {
          name: `openclaw-${name}-litellm-key`,
          key: "apiKey",
          optional: true,
        },
      },
    });
  }

  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: "config", mountPath: "/config", readOnly: true },
    { name: "shared-skills", mountPath: "/shared-skills", readOnly: true },
    { name: "pod-secrets", mountPath: "/data/secrets" },
    { name: "encryption-key", mountPath: "/etc/openclaw/encryption-key", readOnly: true },
  ];

  const volumes: k8s.V1Volume[] = [
    { name: "config", configMap: { name: `openclaw-${name}-config` } },
    { name: "shared-skills", persistentVolumeClaim: { claimName: config.sharedSkillsPvcName, readOnly: true } },
    { name: "pod-secrets", emptyDir: { medium: "Memory", sizeLimit: "10Mi" } },
    { name: "encryption-key", secret: { secretName: `openclaw-${name}-encryption-key` } },
  ];

  if (config.storageProvider && config.csiDriver)
  {
    volumeMounts.unshift({ name: "tenant-storage", mountPath: "/data/openclaw" });
    volumes.unshift({
      name: "tenant-storage",
      csi: {
        driver: config.csiDriver,
        volumeAttributes: {
          bucketName: `${config.bucketPrefix}-${name}`,
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
      labels: _BuildTenantLabels(name),
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { "opencrane.io/tenant": name },
      },
      template: {
        metadata: {
          labels: {
            ..._BuildTenantLabels(name),
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
              ports: [{ name: "gateway", containerPort: config.gatewayPort }],
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
                  port: config.gatewayPort as never,
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