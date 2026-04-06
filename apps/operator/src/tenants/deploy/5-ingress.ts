import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildIngressHost } from "./ingress-host.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build an Ingress resource routing external traffic to the tenant service.
 */
export function _BuildIngress(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1Ingress
{
  const name = tenant.metadata!.name!;
  const host = _BuildIngressHost(name, config.ingressDomain);

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `openclaw-${name}`,
      namespace,
      labels: _BuildTenantLabels(name),
      annotations: {
        "kubernetes.io/ingress.class": config.ingressClassName,
      },
    },
    spec: {
      ingressClassName: config.ingressClassName,
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
                    port: { number: config.gatewayPort },
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