import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the tenant Deployment that runs a single OpenClaw gateway pod.
 *
 * This builder is the main place where OpenCrane translates tenant intent
 * into runtime behavior: image/version selection, platform env vars, storage
 * strategy, skill mounting, LiteLLM integration, and pod hardening defaults.
 */
export function _BuildDeployment(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1Deployment
{
  const name = tenant.metadata!.name!;
  const image = tenant.spec.openclawImage ?? config.tenantDefaultImage;
  const resources = tenant.spec.resources;
  const openclawVersion = tenant.spec.openclawVersion ?? "latest";
  const allowedSkills = tenant.spec.skills?.join(",");

  // 1. Runtime env — inject both OpenClaw-required paths and OpenCrane-managed
  //    runtime hints so the tenant process knows where state, secrets, policy,
  //    and platform contract files live.
  const envVars: k8s.V1EnvVar[] = [
    { name: "OPENCLAW_STATE_DIR", value: "/data/openclaw" },
    { name: "OPENCLAW_SECRETS_DIR", value: "/data/secrets" },
    { name: "OPENCLAW_ENCRYPTION_KEY_PATH", value: "/etc/openclaw/encryption-key/key" },
    { name: "OPENCLAW_TENANT_NAME", value: name },
    { name: "OPENCLAW_VERSION", value: openclawVersion },
    { name: "OPENCRANE_RUNTIME_MODE", value: "managed" },
    { name: "OPENCRANE_RUNTIME_CONTRACT_PATH", value: "/config/opencrane-managed-runtime.json" },
    { name: "HOME", value: "/tmp/opencrane-home" },
    { name: "TMPDIR", value: "/tmp" },
    { name: "NPM_CONFIG_CACHE", value: "/tmp/npm-cache" },
    ...(config.liteLlmEnabled ? [{ name: "LITELLM_ENDPOINT", value: config.liteLlmEndpoint }] : []),
    ...(tenant.spec.team ? [{ name: "OPENCRANE_TEAM", value: tenant.spec.team }] : []),
    ...(tenant.spec.policyRef ? [{ name: "OPENCRANE_POLICY_REF", value: tenant.spec.policyRef }] : []),
    ...(allowedSkills !== undefined ? [{ name: "OPENCRANE_ALLOWED_SKILLS", value: allowedSkills }] : []),
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

  // 2. Volume mounts — keep only explicit writable paths mounted read-write;
  //    everything else stays read-only so the container can run with a
  //    read-only root filesystem.
  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: "config", mountPath: "/config", readOnly: true },
    { name: "shared-skills", mountPath: "/shared-skills", readOnly: true },
    { name: "pod-secrets", mountPath: "/data/secrets" },
    { name: "encryption-key", mountPath: "/etc/openclaw/encryption-key", readOnly: true },
    { name: "tmp", mountPath: "/tmp" },
  ];

  const volumes: k8s.V1Volume[] = [
    { name: "config", configMap: { name: `openclaw-${name}-config` } },
    { name: "shared-skills", persistentVolumeClaim: { claimName: config.sharedSkillsPvcName, readOnly: true } },
    { name: "pod-secrets", emptyDir: { medium: "Memory", sizeLimit: "10Mi" } },
    { name: "encryption-key", secret: { secretName: `openclaw-${name}-encryption-key` } },
    { name: "tmp", emptyDir: {} },
  ];

  // 3. Tenant state storage — choose cloud-backed CSI storage when the platform
  //    is configured for it, otherwise fall back to the per-tenant PVC path used
  //    by local and non-cloud installs.
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
          // 4. Pod defaults — enforce the baseline runtime hardening profile
          //    without changing the existing service-account or storage model.
          serviceAccountName: `openclaw-${name}`,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: {
              type: "RuntimeDefault",
            },
          },
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
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: {
                  drop: ["ALL"],
                },
                readOnlyRootFilesystem: true,
              },
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