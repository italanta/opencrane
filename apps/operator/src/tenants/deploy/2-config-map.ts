import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build a ConfigMap containing merged OpenClaw JSON configuration.
 */
export function _BuildConfigMap(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1ConfigMap
{
  const name = tenant.metadata!.name!;
  const baseConfig = {
    gateway: {
      mode: "local",
      port: config.gatewayPort,
      bind: "lan",
    },
    agents: {
      defaults: {
        thinking: "medium",
      },
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
      "openclaw.json": JSON.stringify(merged, null, 2),
    },
  };
}