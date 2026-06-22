import * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/** Namespace label every Kubernetes namespace carries (`kubernetes.io/metadata.name`). */
const _NAMESPACE_NAME_LABEL = "kubernetes.io/metadata.name";

/** Component label the identity-routing gateway proxy pods carry (Helm). */
const _PROXY_COMPONENT_LABEL = "app.kubernetes.io/component";

/**
 * Build the NetworkPolicy that locks a tenant pod's OpenClaw gateway port to the
 * identity-routing gateway proxy (OC-2 / CONN.4 safeguard).
 *
 * Trusted-proxy auth trusts the user-identity header only from a configured proxy
 * source — but that trust is only sound if **nothing else can reach the gateway
 * port directly**. Now that per-user Ingresses are retired and every gateway socket
 * is reverse-proxied by the in-cluster gateway proxy (DOMAIN.T4), this policy admits
 * the gateway port solely from the gateway-proxy pods in the proxy's namespace, so no
 * other in-cluster pod can connect and assert an arbitrary `X-Forwarded-User`. It
 * scopes a single port; kubelet health probes are exempt under GKE Dataplane V2.
 *
 * @param config    - Operator config (the gateway port + the proxy's namespace).
 * @param tenant    - The tenant whose pod the policy selects.
 * @param namespace - Namespace the policy is created in.
 */
export function _BuildGatewayNetworkPolicy(
  config: OpenClawTenantOperatorConfig,
  tenant: Tenant,
  namespace: string,
): k8s.V1NetworkPolicy
{
  const name = tenant.metadata!.name!;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `openclaw-${name}-gateway`,
      namespace,
      labels: _BuildTenantLabels(name),
    },
    spec: {
      // Select this tenant's pod(s) by the standard tenant labels.
      podSelector: { matchLabels: _BuildTenantLabels(name) },
      policyTypes: ["Ingress"],
      ingress: [
        {
          // `_from` is the @kubernetes/client-node property name; it serialises to
          // the NetworkPolicy `from` field on the wire. Admit only the gateway-proxy
          // pods (by component label) in the proxy's namespace.
          _from: [{
            namespaceSelector: { matchLabels: { [_NAMESPACE_NAME_LABEL]: config.gatewayProxyNamespace } },
            podSelector: { matchLabels: { [_PROXY_COMPONENT_LABEL]: "gateway-proxy" } },
          }],
          ports: [{ protocol: "TCP", port: config.gatewayPort }],
        },
      ],
    },
  };
}
