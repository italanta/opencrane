import type * as k8s from "@kubernetes/client-node";

import type { TenantStateVolume } from "../../hosting/index.js";
import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import type { ClusterTenantComputeView } from "@opencrane/infra-api";
import { _BuildTenantLabels } from "./tenant-labels.js";
import { _BuildClusterTenantScheduling } from "./cluster-tenant-scheduling.js";

/**
 * Build the tenant Deployment that runs a single OpenClaw gateway pod.
 *
 * This builder is the main place where OpenCrane translates tenant intent
 * into runtime behavior: image/version selection, platform env vars, storage
 * strategy, LiteLLM integration, and pod hardening defaults.
 *
 * Skill and MCP grants are NOT injected here. They are compiled by the
 * control-plane effective-contract endpoint and re-pulled by the pod at each
 * agentic-loop boundary. The contract is advisory; the ingress planes (Obot
 * MCP Gateway and Skill Registry) are the live authz boundary.
 *
 * @param stateVolume - Pre-computed state volume from the hosting adapter.
 *   The adapter decides whether the volume is a CSI mount (cloud) or PVC ref (on-prem).
 * @param compute - Optional ClusterTenant compute placement; when `dedicated`
 *   with a node pool, the pod is pinned to that pool. Omitted/shared leaves the
 *   pod unconstrained, keeping ref-less openclaws byte-for-byte unchanged.
 * @param configChecksum - Optional SHA of the tenant ConfigMap (`_ConfigChecksum`).
 *   When set it is stamped as the pod-template `opencrane.io/config-checksum`
 *   annotation so a config change (e.g. a newly-registered BYOK default model)
 *   rolls the pod — a mounted ConfigMap update alone does not restart OpenClaw,
 *   which reads `openclaw.json` only at startup. Omitted ⇒ no annotation, so the
 *   suspend path and existing tests render byte-for-byte unchanged.
 */
export function _BuildDeployment(config: OpenClawTenantOperatorConfig, stateVolume: TenantStateVolume, tenant: Tenant,
                                 namespace: string, compute?: ClusterTenantComputeView, configChecksum?: string): k8s.V1Deployment
{
  const name = tenant.metadata!.name!;
  const image = tenant.spec.openclawImage ?? config.tenantDefaultImage;
  const resources = tenant.spec.resources;
  const openclawVersion = tenant.spec.openclawVersion ?? config.defaultOpenclawVersion;

  // 0. Scheduling — derive nodeSelector/tolerations from the parent ClusterTenant's
  //    compute mode. Empty for shared/ref-less openclaws, so the pod spec below is
  //    identical to the pre-ClusterTenant baseline on the default path.
  const scheduling = _BuildClusterTenantScheduling(compute);

  // 1. Runtime env — inject both OpenClaw-required paths and OpenCrane-managed
  //    runtime hints so the tenant process knows where state, secrets, policy,
  //    and platform contract files live.
  //    Note: CSV skill/MCP allow lists are removed — authorization is now
  //    group-based and compiled by the control-plane effective-contract endpoint.
  const envVars: k8s.V1EnvVar[] = [
    { name: "OPENCLAW_STATE_DIR", value: "/data/openclaw" },
    { name: "OPENCLAW_SECRETS_DIR", value: "/data/secrets" },
    { name: "OPENCLAW_ENCRYPTION_KEY_PATH", value: "/etc/openclaw/encryption-key/key" },
    { name: "OPENCLAW_TENANT_NAME", value: name },
    { name: "OPENCLAW_VERSION", value: openclawVersion },
    { name: "OPENCRANE_RUNTIME_MODE", value: "managed" },
    { name: "OPENCRANE_RUNTIME_CONTRACT_PATH", value: "/config/opencrane-managed-runtime.json" },
    { name: "OPENCRANE_MCP_GATEWAY_URL", value: config.mcpGatewayUrl },
    { name: "OPENCRANE_SKILL_REGISTRY_URL", value: config.skillRegistryUrl },
    { name: "OPENCRANE_MCP_GATEWAY_TOKEN_PATH", value: "/var/run/opencrane/tokens/obot-gateway.token" },
    { name: "OPENCRANE_SKILL_REGISTRY_TOKEN_PATH", value: "/var/run/opencrane/tokens/skill-registry.token" },
    { name: "OPENCRANE_CONTROL_PLANE_URL", value: config.controlPlaneInternalUrl },
    { name: "OPENCRANE_CONTRACT_TOKEN_PATH", value: "/var/run/opencrane/tokens/control-plane.token" },
    { name: "HOME", value: "/tmp/opencrane-home" },
    { name: "TMPDIR", value: "/tmp" },
    { name: "NPM_CONFIG_CACHE", value: "/tmp/npm-cache" },
    ...(config.liteLlmEnabled ? [{ name: "LITELLM_ENDPOINT", value: config.liteLlmEndpoint }] : []),
    ...(tenant.spec.team ? [{ name: "OPENCRANE_TEAM", value: tenant.spec.team }] : []),
    ...(tenant.spec.policyRef ? [{ name: "OPENCRANE_POLICY_REF", value: tenant.spec.policyRef }] : []),
    // Gateway auth is trusted-proxy (OC-2 / CONN.4), configured in openclaw.json
    // (see 2-config-map.ts) — no OPENCLAW_GATEWAY_TOKEN here (mutually exclusive
    // with trusted-proxy; the gateway binds because trusted-proxy is a valid mode).
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

    // OpenClaw requires OPENAI_API_KEY for its internal OpenAI translator engine fallback
    envVars.push({
      name: "OPENAI_API_KEY",
      valueFrom: {
        secretKeyRef: {
          name: `openclaw-${name}-openai-key`,
          key: "apiKey",
          optional: true,
        },
      },
    });
  }

  // 2. Volume mounts — the state volume mount comes from the adapter;
  //    everything else is provider-agnostic and stays read-only where possible.
  //    Skills are now pulled per-entitlement from the Skill Registry via
  //    projected token; there is no shared-skills PVC mount.
  const volumeMounts: k8s.V1VolumeMount[] = [
    stateVolume.volumeMount,
    { name: "config", mountPath: "/config", readOnly: true },
    { name: "pod-secrets", mountPath: "/data/secrets" },
    { name: "encryption-key", mountPath: "/etc/openclaw/encryption-key", readOnly: true },
    { name: "projected-identity", mountPath: "/var/run/opencrane/tokens", readOnly: true },
    { name: "tmp", mountPath: "/tmp" },
  ];

  // 3. Volumes — state volume comes from the adapter; rest are provider-agnostic.
  const volumes: k8s.V1Volume[] = [
    stateVolume.volume,
    { name: "config", configMap: { name: `openclaw-${name}-config` } },
    { name: "pod-secrets", emptyDir: { medium: "Memory", sizeLimit: "10Mi" } },
    { name: "encryption-key", secret: { secretName: `openclaw-${name}-encryption-key` } },
    {
      name: "projected-identity",
      projected: {
        sources: [
          {
            serviceAccountToken: {
              path: "obot-gateway.token",
              expirationSeconds: config.projectedTokenTtlSeconds,
              audience: "obot-gateway",
            },
          },
          {
            serviceAccountToken: {
              path: "skill-registry.token",
              expirationSeconds: config.projectedTokenTtlSeconds,
              audience: "skill-registry",
            },
          },
          {
            serviceAccountToken: {
              path: "control-plane.token",
              expirationSeconds: config.projectedTokenTtlSeconds,
              audience: "control-plane",
            },
          },
        ],
      },
    },
    { name: "tmp", emptyDir: {} },
  ];

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
      // Recreate is required because the state PVC is ReadWriteOnce — only one
      // pod can mount it at a time. RollingUpdate (the default) would deadlock:
      // new pod can't attach the disk until old pod releases it, but old pod
      // isn't terminated until new pod is Ready.
      strategy: { type: "Recreate" },
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
          // Roll the pod when the tenant config changes (OpenClaw reads openclaw.json
          // only at startup). Omitted when no checksum is supplied (suspend path).
          ...(configChecksum ? { annotations: { "opencrane.io/config-checksum": configChecksum } } : {}),
        },
        spec: {
          // 4. Pod defaults — enforce the baseline runtime hardening profile
          //    without changing the existing service-account or storage model.
          //    Scheduling keys are spread in only when the parent ClusterTenant
          //    pins a dedicated pool; on the default path the spread is empty so
          //    no nodeSelector/tolerations keys appear at all.
          ...(scheduling.nodeSelector ? { nodeSelector: scheduling.nodeSelector } : {}),
          ...(scheduling.tolerations ? { tolerations: scheduling.tolerations } : {}),
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
