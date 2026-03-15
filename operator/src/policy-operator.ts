import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";
import type { AccessPolicy, OperatorConfig } from "./types.js";
import { applyResource, deleteResource } from "./reconciler.js";

const API_GROUP = "opencrane.io";
const API_VERSION = "v1alpha1";
const PLURAL = "accesspolicies";

export class PolicyOperator {
  private objectApi: k8s.KubernetesObjectApi;
  private watch: k8s.Watch;
  private log: Logger;
  private config: OperatorConfig;

  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger) {
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.watch = new k8s.Watch(kc);
    this.config = config;
    this.log = log.child({ component: "policy-operator" });
  }

  async start(): Promise<void> {
    const ns = this.config.watchNamespace;
    const path = ns
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${ns}/${PLURAL}`
      : `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}`;

    this.log.info({ path }, "starting access policy watch");

    const watchLoop = async () => {
      try {
        await this.watch.watch(
          path,
          {},
          (type: string, policy: AccessPolicy) => {
            this.handleEvent(type, policy).catch((err) => {
              this.log.error(
                { err, policy: policy.metadata?.name },
                "policy reconcile failed",
              );
            });
          },
          (err) => {
            if (err) {
              this.log.error({ err }, "policy watch lost, reconnecting...");
            }
            setTimeout(watchLoop, 5000);
          },
        );
      } catch (err) {
        this.log.error({ err }, "policy watch failed, retrying...");
        setTimeout(watchLoop, 5000);
      }
    };

    await watchLoop();
  }

  private async handleEvent(
    type: string,
    policy: AccessPolicy,
  ): Promise<void> {
    const name = policy.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "access policy event");

    switch (type) {
      case "ADDED":
      case "MODIFIED":
        await this.reconcilePolicy(policy);
        break;
      case "DELETED":
        await this.cleanupPolicy(policy);
        break;
    }
  }

  async reconcilePolicy(policy: AccessPolicy): Promise<void> {
    const name = policy.metadata!.name!;
    const namespace = policy.metadata!.namespace ?? "default";

    // Build a standard Kubernetes NetworkPolicy from the AccessPolicy spec
    if (policy.spec.egressRules?.length) {
      const netpol = this.buildNetworkPolicy(policy, namespace);
      await applyResource(this.objectApi, netpol, this.log);
    }

    // If Cilium is available and domain rules are specified, create CiliumNetworkPolicy
    if (policy.spec.domains?.allow?.length) {
      const ciliumPolicy = this.buildCiliumPolicy(policy, namespace);
      try {
        await applyResource(this.objectApi, ciliumPolicy, this.log);
      } catch (err) {
        // Cilium CRDs may not be installed — log and skip
        this.log.warn(
          { name },
          "could not apply CiliumNetworkPolicy (Cilium may not be installed)",
        );
      }
    }
  }

  private async cleanupPolicy(policy: AccessPolicy): Promise<void> {
    const name = policy.metadata!.name!;
    const namespace = policy.metadata!.namespace ?? "default";

    await deleteResource(
      this.objectApi,
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: `opencrane-policy-${name}`, namespace },
      },
      this.log,
    );

    await deleteResource(
      this.objectApi,
      {
        apiVersion: "cilium.io/v2",
        kind: "CiliumNetworkPolicy",
        metadata: { name: `opencrane-policy-${name}`, namespace },
      },
      this.log,
    );
  }

  private buildNetworkPolicy(
    policy: AccessPolicy,
    namespace: string,
  ): k8s.V1NetworkPolicy {
    const name = policy.metadata!.name!;
    const selector = this.buildPodSelector(policy);

    const egressRules: k8s.V1NetworkPolicyEgressRule[] =
      (policy.spec.egressRules ?? []).map((rule) => ({
        to: [{ ipBlock: { cidr: rule.cidr } }],
        ports: (rule.ports ?? [443]).map((port) => ({
          port,
          protocol: rule.protocol ?? "TCP",
        })),
      }));

    // Always allow DNS
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

  private buildCiliumPolicy(
    policy: AccessPolicy,
    namespace: string,
  ): k8s.KubernetesObject & Record<string, unknown> {
    const name = policy.metadata!.name!;
    const selector = this.buildPodSelector(policy);
    const allowedDomains = policy.spec.domains?.allow ?? [];

    // CiliumNetworkPolicy for FQDN-based egress filtering
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
            toFQDNs: allowedDomains.map((domain) =>
              domain.includes("*")
                ? { matchPattern: domain }
                : { matchName: domain },
            ),
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

  private buildPodSelector(
    policy: AccessPolicy,
  ): Record<string, string> {
    const selector: Record<string, string> = {
      "app.kubernetes.io/component": "tenant",
    };

    if (policy.spec.tenantSelector?.matchLabels) {
      Object.assign(selector, policy.spec.tenantSelector.matchLabels);
    }
    if (policy.spec.tenantSelector?.matchTeam) {
      selector["opencrane.io/team"] = policy.spec.tenantSelector.matchTeam;
    }

    return selector;
  }
}
