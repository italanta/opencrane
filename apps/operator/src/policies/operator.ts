import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig } from "../config.js";
import type { AccessPolicy } from "./types.js";
import { applyResource, deleteResource } from "../infra/k8s.js";
import { _RunWatchLoop } from "../shared/watch-runner.js";
import { PolicyResourceBuilder } from "./policy-resource-builder.js";

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

  /** Client for patching AccessPolicy status subresource. */
  private customApi: k8s.CustomObjectsApi;

  /** Watch client for streaming AccessPolicy CR events. */
  private watch: k8s.Watch;

  /** Scoped logger for policy-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

  /** Builder for policy-managed network resources. */
  private resourceBuilder: PolicyResourceBuilder;

  /**
   * Create a new PolicyOperator bound to the given KubeConfig.
   */
  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger)
  {
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.watch = new k8s.Watch(kc);
    this.config = config;
    this.resourceBuilder = new PolicyResourceBuilder();
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

    await _RunWatchLoop<AccessPolicy>({
      watch: this.watch,
      path,
      log: this.log,
      startMessage: "starting access policy watch",
      reconnectMessage: "policy watch lost, reconnecting...",
      failedMessage: "policy watch failed, retrying...",
      onEvent: async (type: string, policy: AccessPolicy) => {
        await this.handleEvent(type, policy);
      },
    });
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

    switch (type)
    {
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
    if (policy.spec.egressRules?.length)
    {
      const netpol = this.resourceBuilder.buildNetworkPolicy(policy, namespace);
      await applyResource(this.objectApi, netpol, this.log);
    }

    // If Cilium is available and domain rules are specified, create CiliumNetworkPolicy
    if (policy.spec.domains?.allow?.length)
    {
      const ciliumPolicy = this.resourceBuilder.buildCiliumPolicy(policy, namespace);
      try
      {
        await applyResource(this.objectApi, ciliumPolicy, this.log);
      }
      catch (err)
      {
        // Cilium CRDs may not be installed — log and skip
        this.log.warn(
          { name },
          "could not apply CiliumNetworkPolicy (Cilium may not be installed)",
        );
      }
    }

    await this._patchPolicyStatus(policy, namespace);
  }

  /**
   * Patch the status subresource of an AccessPolicy CR with the last reconciled timestamp.
   *
   * This requires a dedicated call rather than being written inline during `applyResource`
   * because the AccessPolicy CRD declares `subresources: status: {}`. When a CRD has a
   * status subresource, the API server splits the resource into two independent endpoints:
   *
   *   - Main endpoint  (.../accesspolicies/{name})        — spec writes only
   *   - Status endpoint (.../accesspolicies/{name}/status) — status writes only
   *
   * Any `status` field sent to the main endpoint is silently stripped. The only way to
   * write status is via `patchNamespacedCustomObjectStatus`, which targets the `/status`
   * subresource path directly. This is intentional: spec is owned by users and GitOps
   * tooling; status is owned exclusively by the operator, and the split prevents either
   * side from accidentally overwriting the other.
   */
  private async _patchPolicyStatus(policy: AccessPolicy, namespace: string): Promise<void>
  {
    const name = policy.metadata!.name!;
    try
    {
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { status: { lastReconciled: new Date().toISOString() } },
      });
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to update access policy status");
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

}
