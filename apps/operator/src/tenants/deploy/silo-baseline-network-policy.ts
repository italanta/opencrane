import * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";

/** Namespace label every Kubernetes namespace carries (`kubernetes.io/metadata.name`). */
const _NAMESPACE_NAME_LABEL = "kubernetes.io/metadata.name";

/** The cluster DNS namespace whose kube-dns/CoreDNS every pod must be able to reach. */
const _DNS_NAMESPACE = "kube-system";

/**
 * Build the per-silo baseline NetworkPolicy — the default-deny edge of a
 * ClusterTenant namespace (S2 / silo Phase 1, task_08734d58 + task_d6404452).
 *
 * An empty `podSelector` selects EVERY pod in the silo namespace, and naming both
 * `Ingress` and `Egress` in `policyTypes` flips the namespace to **default-deny**:
 * anything not explicitly allowed below is dropped. The allow-list is the minimum a
 * silo needs to function while staying isolated from every OTHER silo (east-west
 * default-deny — no silo→silo path exists because no rule names another silo):
 *
 * - **Ingress** from the same silo namespace (intra-silo) and from the
 *   control-plane/operator namespace (the super-admin plane is the only principal
 *   allowed to reach in — it brokers the gateway connection).
 * - **Egress** to cluster DNS, to the same silo namespace, to the control-plane
 *   namespace (the shared planes — control-plane, Obot/MCP, skill-registry, LiteLLM,
 *   Cognee — live there in the shared tier), and to external HTTPS (LLM/MCP/Git).
 *
 * This replaces the old single `opencrane-tenant-default` policy that sat in the
 * install namespace and (mis)selected tenant pods cluster-wide; the operator now
 * emits one correctly-scoped policy per silo namespace it provisions. The companion
 * {@link _BuildGatewayNetworkPolicy} narrows the gateway PORT to the operator on top
 * of this baseline (NetworkPolicy rules are additive, so the two compose).
 *
 * NOTE: this is an L3/L4 namespace-scoped floor — the identity-based (SPIFFE/Cilium)
 * enforcement of the silo model lands later (S5). It only takes effect on a
 * NetworkPolicy-enforcing CNI; GKE Autopilot/Dataplane V2 enforces it inherently.
 *
 * @param namespace - The silo (ClusterTenant) namespace the policy is created in.
 * @param clusterTenantName - Parent ClusterTenant name, recorded as a label.
 * @param config - Operator config; supplies the control-plane/operator namespace.
 * @returns The default-deny baseline NetworkPolicy for the silo namespace.
 */
export function _BuildSiloBaselineNetworkPolicy(
  namespace: string,
  clusterTenantName: string,
  config: OpenClawTenantOperatorConfig,
): k8s.V1NetworkPolicy
{
  // The control-plane + shared planes live in the operator's own namespace in the
  // shared tier; it is the only namespace a silo may talk to besides itself + DNS.
  const platformNamespace = config.operatorNamespace;

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `opencrane-${clusterTenantName}-silo-baseline`,
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-operator",
        "app.kubernetes.io/component": "silo-isolation",
        "opencrane.io/cluster-tenant": clusterTenantName,
      },
    },
    spec: {
      // Empty selector → every pod in the silo namespace; both types → default-deny.
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          // `_from` (NOT `from`): `from` is an ES reserved word, so the generated
          // client model prefixes it with an underscore and maps it back to the JSON
          // `from` on the wire. Writing `from` here would be dropped by the serializer,
          // leaving an empty `from` that matches ALL sources — a silent fail-open.
          _from: [
            // Intra-silo: pods within this same namespace may talk to each other.
            { podSelector: {} },
            // The control-plane/operator super-admin plane (the only cross-silo principal).
            { namespaceSelector: { matchLabels: { [_NAMESPACE_NAME_LABEL]: platformNamespace } } },
          ],
        },
      ],
      egress: [
        // Cluster DNS — without this every name lookup fails and the pod is dead.
        {
          to: [{ namespaceSelector: { matchLabels: { [_NAMESPACE_NAME_LABEL]: _DNS_NAMESPACE } } }],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        // Intra-silo + the shared platform planes (control-plane, Obot, skills, LiteLLM, Cognee).
        {
          to: [
            { podSelector: {} },
            { namespaceSelector: { matchLabels: { [_NAMESPACE_NAME_LABEL]: platformNamespace } } },
          ],
        },
        // External HTTPS — the agent legitimately calls out to LLM/MCP/Git endpoints.
        {
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    },
  };
}
