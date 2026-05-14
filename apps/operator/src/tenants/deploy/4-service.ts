import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the stable in-cluster Service for the tenant gateway.
 *
 * The Service gives the tenant Deployment a predictable DNS name so Ingress
 * rules and any cluster-local callers can target the tenant without coupling
 * to pod IPs or rollout churn.
 */
export function _BuildService(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1Service
{
  const name = tenant.metadata!.name!;
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: `openclaw-${name}`,
      namespace,
      labels: _BuildTenantLabels(name),
    },
    spec: {
      selector: { "opencrane.io/tenant": name },
      ports: [
        {
          name: "gateway",
          port: config.gatewayPort,
          targetPort: config.gatewayPort as never,
        },
      ],
    },
  };
}