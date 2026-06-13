import type * as k8s from "@kubernetes/client-node";

import type { IngressBinding } from "../../hosting/index.js";
import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildIngressHost } from "./ingress-host.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the tenant Ingress that exposes the gateway on its assigned hostname.
 *
 * Ingress class and provider annotations come from the hosting adapter's IngressBinding,
 * so the builder stays provider-agnostic: nginx on-prem, gce on GKE, etc. When
 * `ingressTlsEnabled`, a `tls:` block is added referencing the shared wildcard cert
 * Secret (`ingressTlsSecretName`, populated by cert-manager — see CONN.8), so the
 * browser reaches `wss://<host>` over TLS the ingress terminates.
 */
export function _BuildIngress(config: OpenClawTenantOperatorConfig, ingressBinding: IngressBinding, tenant: Tenant, namespace: string): k8s.V1Ingress
{
  const name = tenant.metadata!.name!;
  const host = _BuildIngressHost(name, config.ingressDomain);

  // TLS termination: reference the shared wildcard Secret for this host. The Secret is
  // provisioned once by cert-manager (a wildcard Certificate); per-tenant Ingresses do
  // not request their own cert, so adding a tenant needs no new issuance.
  const tls: k8s.V1IngressTLS[] | undefined = config.ingressTlsEnabled
    ? [{ hosts: [host], secretName: config.ingressTlsSecretName }]
    : undefined;

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `openclaw-${name}`,
      namespace,
      labels: _BuildTenantLabels(name),
      annotations: ingressBinding.annotations,
    },
    spec: {
      ingressClassName: ingressBinding.ingressClassName,
      ...(tls ? { tls } : {}),
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
