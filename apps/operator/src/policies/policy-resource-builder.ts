import * as k8s from "@kubernetes/client-node";

import type { AccessPolicy } from "./types.js";

/**
 * Pure resource builder for policy-managed network objects.
 */
export class PolicyResourceBuilder
{
  /**
   * Build a Kubernetes NetworkPolicy from AccessPolicy egress rules.
   */
  buildNetworkPolicy(policy: AccessPolicy, namespace: string): k8s.V1NetworkPolicy
  {
    const name = policy.metadata!.name!;
    const selector = this._buildPodSelector(policy);

    const egressRules: k8s.V1NetworkPolicyEgressRule[] =
      (policy.spec.egressRules ?? []).map(function (rule)
      {
        return {
          to: [{ ipBlock: { cidr: rule.cidr } }],
          ports: (rule.ports ?? [443]).map(function (port)
          {
            return {
              port,
              protocol: rule.protocol ?? "TCP",
            };
          }),
        };
      });

    egressRules.unshift({
      ports: [
        { port: 53, protocol: "UDP" },
        { port: 53, protocol: "TCP" },
      ],
    });

    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: `opencrane-policy-${name}`,
        namespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "app.kubernetes.io/managed-by": "opencrane-operator",
          "opencrane.io/policy": name,
        },
      },
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ["Egress"],
        egress: egressRules,
      },
    };
  }

  /**
   * Build a CiliumNetworkPolicy for FQDN-based egress filtering.
   */
  buildCiliumPolicy(policy: AccessPolicy, namespace: string): k8s.KubernetesObject & Record<string, unknown>
  {
    const name = policy.metadata!.name!;
    const selector = this._buildPodSelector(policy);
    const allowedDomains = policy.spec.domains?.allow ?? [];

    return {
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: {
        name: `opencrane-policy-${name}`,
        namespace,
        labels: {
          "app.kubernetes.io/part-of": "opencrane",
          "opencrane.io/policy": name,
        },
      },
      spec: {
        endpointSelector: { matchLabels: selector },
        egress: [
          {
            toFQDNs: allowedDomains.map(function (domain)
            {
              return domain.includes("*")
                ? { matchPattern: domain }
                : { matchName: domain };
            }),
            toPorts: [
              {
                ports: [{ port: "443", protocol: "TCP" }],
              },
            ],
          },
        ],
      },
    } as k8s.KubernetesObject & Record<string, unknown>;
  }

  /**
   * Build a pod label selector from AccessPolicy tenant selector rules.
   */
  private _buildPodSelector(policy: AccessPolicy): Record<string, string>
  {
    const selector: Record<string, string> = {
      "app.kubernetes.io/component": "tenant",
    };

    if (policy.spec.tenantSelector?.matchLabels)
    {
      Object.assign(selector, policy.spec.tenantSelector.matchLabels);
    }

    if (policy.spec.tenantSelector?.matchTeam)
    {
      selector["opencrane.io/team"] = policy.spec.tenantSelector.matchTeam;
    }

    return selector;
  }
}
