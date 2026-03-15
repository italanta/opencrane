import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { AccessPolicy, OperatorConfig } from "./types.js";
import { applyResource, deleteResource } from "./reconciler.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the AccessPolicy CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the AccessPolicy CRD. */
const PLURAL = "accesspolicies";

/**
 * Watches AccessPolicy custom resources and reconciles the corresponding
 * Kubernetes NetworkPolicy and optional CiliumNetworkPolicy resources.
 */
export class PolicyOperator
{
  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Watch client for streaming AccessPolicy CR events. */
  private watch: k8s.Watch;

  /** Scoped logger for policy-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

  /**
   * Create a new PolicyOperator bound to the given KubeConfig.
   */
  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger)
  {
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.watch = new k8s.Watch(kc);
    this.config = config;
    this.log = log.child({ component: "policy-operator" });
  }

  /**
   * Begin watching for AccessPolicy CR events and reconcile on each change.
   * Automatically reconnects on watch errors with a 5-second backoff.
   */
  async start(): Promise<void>
  {
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

  /**
   * Route a watch event to the appropriate reconciliation handler.
   */
  private async handleEvent(
    type: string,
    policy: AccessPolicy,
  ): Promise<void>
  {
    const name = policy.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "access policy event");

    switch (type) {
      case "ADDED":
      case "MODIFIED":
        await this.reconcilePolicy(policy);
        break;
      case "DELETED":
        await this._cleanupPolicy(policy);
        break;
    }
  }

  /**
   * Reconcile the NetworkPolicy (and optional CiliumNetworkPolicy) for
   * an AccessPolicy CR based on its egress and domain rules.
   */
  async reconcilePolicy(policy: AccessPolicy): Promise<void>
  {
    const name = policy.metadata!.name!;
    const namespace = policy.metadata!.namespace ?? "default";

    // Build a standard Kubernetes NetworkPolicy from the AccessPolicy spec
    if (policy.spec.egressRules?.length) {
      const netpol = this._buildNetworkPolicy(policy, namespace);
      await applyResource(this.objectApi, netpol, this.log);
    }

    // If Cilium is available and domain rules are specified, create CiliumNetworkPolicy
    if (policy.spec.domains?.allow?.length) {
      const ciliumPolicy = this._buildCiliumPolicy(policy, namespace);
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

  /**
   * Remove the NetworkPolicy and CiliumNetworkPolicy owned by the
   * given AccessPolicy CR.
   */
  private async _cleanupPolicy(policy: AccessPolicy): Promise<void>
  {
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

  /**
   * Build a Kubernetes NetworkPolicy from the AccessPolicy egress rules,
   * always including DNS egress as the first rule.
   */
  private _buildNetworkPolicy(
    policy: AccessPolicy,
    namespace: string,
  ): k8s.V1NetworkPolicy
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

  /**
   * Build a CiliumNetworkPolicy for FQDN-based egress filtering using
   * the allowed domains from the AccessPolicy spec.
   */
  private _buildCiliumPolicy(
    policy: AccessPolicy,
    namespace: string,
  ): k8s.KubernetesObject & Record<string, unknown>
  {
    const name = policy.metadata!.name!;
    const selector = this._buildPodSelector(policy);
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
   * Build a pod label selector from the AccessPolicy tenant selector,
   * always including the tenant component label as a base.
   */
  private _buildPodSelector(
    policy: AccessPolicy,
  ): Record<string, string>
  {
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
