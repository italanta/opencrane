import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig } from "../../../config.js";
import { _ComputeLastActivityMs, _ListIdleCandidates, _ShouldSuspend } from "./idle-policy.js";
import type { Tenant } from "../../models/tenant.interface.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Periodically checks running tenant deployments for inactivity and
 * auto-suspends them by patching the Tenant CR's `spec.suspended` field.
 *
 * Inactivity is determined by using the Deployment condition transition
 * timestamps as a proxy for recent tenant activity.
 *
 * When a request hits a suspended tenant's Ingress, the operator's watch
 * loop detects the MODIFIED event when the user (or control-plane UI)
 * un-suspends the tenant, and reconcileTenant scales it back to 1.
 */
export class IdleChecker
{
  /** Client for reading and patching custom objects. */
  private customApi: k8s.CustomObjectsApi;

  /** Client for reading Deployment status. */
  private appsApi: k8s.AppsV1Api;

  /** Scoped logger for idle-checker messages. */
  private log: Logger;

  /** Operator runtime configuration. */
  private config: OperatorConfig;

  /** Handle returned by setInterval so the loop can be stopped. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new IdleChecker.
   */
  constructor(kc: k8s.KubeConfig, config: OperatorConfig, log: Logger)
  {
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
    this.config = config;
    this.log = log.child({ component: "idle-checker" });
  }

  /**
   * Start the periodic idle-check loop. Does nothing if idleTimeoutMinutes is 0.
   */
  start(): void
  {
    if (this.config.idleTimeoutMinutes <= 0)
    {
      this.log.info("idle auto-suspend disabled (IDLE_TIMEOUT_MINUTES=0)");
      return;
    }

    this.log.info(
      { timeoutMinutes: this.config.idleTimeoutMinutes, intervalSeconds: this.config.idleCheckIntervalSeconds },
      "starting idle-check loop",
    );

    this.intervalHandle = setInterval(
      () => { this._checkAll().catch((err) => this.log.error({ err }, "idle-check cycle failed")); },
      this.config.idleCheckIntervalSeconds * 1000,
    );
  }

  /**
   * Stop the idle-check loop.
   */
  stop(): void
  {
    if (this.intervalHandle)
    {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Scan all Tenant CRs and suspend any that have been idle too long.
   *
   * 1. Lists every Tenant CR (cluster-wide or namespace-scoped).
   * 2. Filters to only Running, non-suspended tenants.
   * 3. For each, reads the matching `openclaw-{name}` Deployment and
   *    inspects its status conditions (Available, Progressing, etc.).
   *    The most recent `lastTransitionTime` across all conditions is
   *    used as a proxy for the last meaningful activity on that pod.
   * 4. If the elapsed time since that timestamp exceeds the configured
   *    `idleTimeoutMinutes`, patches the Tenant CR to set
   *    `spec.suspended = true`.
   * 5. The operator's existing watch loop picks up the MODIFIED event
   *    and scales the Deployment to 0 replicas.
   * 6. On GKE Autopilot the now-idle node is automatically reclaimed.
   */
  private async _checkAll(): Promise<void>
  {
    const ns = this.config.watchNamespace;

    const response = ns
      ? await this.customApi.listNamespacedCustomObject({ group: API_GROUP, version: API_VERSION, namespace: ns, plural: PLURAL })
      : await this.customApi.listClusterCustomObject({ group: API_GROUP, version: API_VERSION, plural: PLURAL });

    const tenants = ((response as Record<string, unknown>).items ?? []) as Tenant[];
    const now = Date.now();
    const thresholdMs = this.config.idleTimeoutMinutes * 60 * 1000;

    for (const candidate of _ListIdleCandidates(tenants))
    {
      const isIdle = await this._isTenantIdle(candidate.name, candidate.namespace, now, thresholdMs);
      if (isIdle)
      {
        this.log.info({ name: candidate.name, namespace: candidate.namespace }, "auto-suspending idle tenant");
        await this._suspendTenant(candidate.name, candidate.namespace);
      }
    }
  }

  /**
   * Check if a tenant's deployment has been idle past the threshold.
   * Uses the deployment's last condition transition time as a proxy
   * for last activity.
   */
  private async _isTenantIdle(name: string, namespace: string, now: number, thresholdMs: number): Promise<boolean>
  {
    try
    {
      const deployment = await this.appsApi.readNamespacedDeployment({ name: `openclaw-${name}`, namespace });
      const lastActivity = _ComputeLastActivityMs(deployment.status?.conditions);
      return _ShouldSuspend(now, lastActivity, thresholdMs);
    }
    catch
    {
      return false;
    }
  }

  /**
   * Patch the Tenant CR to set spec.suspended = true.
   */
  private async _suspendTenant(name: string, namespace: string): Promise<void>
  {
    try
    {
      await this.customApi.patchNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { spec: { suspended: true } },
      });
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to auto-suspend tenant");
    }
  }
}
