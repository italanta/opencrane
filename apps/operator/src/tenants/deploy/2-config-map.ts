import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the tenant ConfigMap that carries both OpenClaw runtime configuration
 * and the OpenCrane managed-runtime contract.
 *
 * The generated ConfigMap serves two separate purposes:
 * - `openclaw.json` provides the effective OpenClaw gateway/runtime config
 *   after OpenCrane defaults are merged with any tenant overrides.
 * - `opencrane-managed-runtime.json` gives the tenant runtime an explicit
 *   description of the platform context it is running under so later runtime
 *   behavior can key off a stable contract instead of inferred env vars.
 */
export function _BuildConfigMap(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1ConfigMap
{
  const name = tenant.metadata!.name!;

  // 1. Base runtime config — establish the OpenClaw gateway defaults that every
  //    tenant needs before any tenant-specific overrides are applied.
  const baseConfig: Record<string, unknown> = {
    gateway: {
      mode: "local",
      port: config.gatewayPort,
      bind: "lan",
    },
    ...(config.liteLlmEnabled
      ? {
          llmProxy: {
            endpoint: config.liteLlmEndpoint,
            apiKey: "${LITELLM_API_KEY}",
          },
        }
      : {}),
  };

  // 2. Managed-runtime contract — publish OpenCrane-owned capabilities and
  //    tenant context in a machine-readable form for future runtime features.
  const runtimeContract = {
    version: "opencrane-runtime/v1alpha1",
    platform: "opencrane",
    mode: "managed",
    tenant: {
      name,
      team: tenant.spec.team ?? null,
      policyRef: tenant.spec.policyRef ?? null,
      requestedSkills: tenant.spec.skills ?? [],
    },
    capabilities: {
      liteLlmProxy: config.liteLlmEnabled,
      sharedSkills: true,
      storageProvider: config.storageProvider || "pvc",
      persistentState: true,
      ephemeralSecrets: true,
      autoSuspend: config.idleTimeoutMinutes > 0,
      mcpPolicyEnforced: false,
    },
  };

  // 3. Tenant overrides — preserve the current shallow-merge behavior so the
  //    operator does not unexpectedly rewrite existing tenant customization semantics.
  const merged = tenant.spec.configOverrides
    ? { ...baseConfig, ...tenant.spec.configOverrides }
    : baseConfig;

  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `openclaw-${name}-config`,
      namespace,
      labels: _BuildTenantLabels(name),
    },
    data: {
      // OpenClaw consumes this file directly at tenant runtime startup.
      "openclaw.json": JSON.stringify(merged, null, 2),

      // OpenCrane-specific runtime metadata is kept separate so the tenant can
      // distinguish platform contract from OpenClaw's own config surface.
      "opencrane-managed-runtime.json": JSON.stringify(runtimeContract, null, 2),
    },
  };
}