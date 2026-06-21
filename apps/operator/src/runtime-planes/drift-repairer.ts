import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../config.js";

/** One env-var spec the repairer will enforce on a managed deployment. */
interface _EnvSpec
{
  /** Kubernetes env var name. */
  name: string;

  /** Expected literal value; undefined entries are ignored by the enforcer. */
  expected: string;
}

/**
 * Specification of a runtime-plane Deployment that the operator must keep
 * in sync with control-plane intent.
 *
 * **IAM note:** the operator repairs env vars only — it does not touch RBAC,
 * ServiceAccount annotations, or projected token volumes.  Those are set by
 * Helm and must be managed via the chart, not at runtime.
 */
interface _PlaneSpec
{
  /** Human-friendly plane label used in log messages. */
  label: string;

  /** Kubernetes Deployment name (without namespace). */
  deploymentName: string;

  /** Expected env vars to enforce; extra vars in the live spec are left alone. */
  envSpecs: _EnvSpec[];
}

/**
 * Periodically compares the live state of the Obot MCP Gateway and Skill Registry
 * Deployments against the control-plane's configuration intent, and patches any
 * drifted env vars back to their expected values.
 *
 * This provides the "detect + repair" guarantee required by P4A.2:
 * a manual `kubectl edit` of a managed deployment env var is reverted within
 * one check interval (default 60 s) without requiring a pod restart.
 *
 * **What is repaired:** critical env vars that keep the runtime planes correctly
 * wired (e.g. `CONTROL_PLANE_URL`, `OBOT_SERVER_MCPRUNTIME_BACKEND`).
 *
 * **What is NOT repaired:** image tags, replica counts, resource limits, or
 * any field not declared in `_EnvSpec`.  Use Helm for those.
 *
 * @see platform/helm/templates/obot-mcp-gateway-deployment.yaml
 * @see platform/helm/templates/skill-registry-deployment.yaml
 */
export class RuntimePlaneDriftRepairer
{
  /** Kubernetes Apps API client for deployment reads and patches. */
  private readonly _appsApi: k8s.AppsV1Api;

  /** Namespace where the managed deployments live. */
  private readonly _namespace: string;

  /** Ordered list of planes to watch and repair. */
  private readonly _planes: _PlaneSpec[];

  /** Scoped logger for repairer messages. */
  private readonly _log: Logger;

  /** Check interval in milliseconds. */
  private readonly _intervalMs: number;

  /** Active interval handle; null when stopped. */
  private _timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param appsApi    - Kubernetes Apps V1 API client.
   * @param config     - Operator runtime configuration.
   * @param log        - Pino logger instance; a child logger is created internally.
   * @param intervalMs - How often to run a drift check (default 60 000 ms).
   */
  constructor(
    appsApi: k8s.AppsV1Api,
    config: OpenClawTenantOperatorConfig,
    log: Logger,
    intervalMs = 60_000,
  )
  {
    this._appsApi = appsApi;
    this._namespace = config.watchNamespace || "opencrane";
    this._log = log.child({ component: "runtime-plane-drift-repairer" });
    this._intervalMs = intervalMs;

    const controlPlaneBaseUrl = config.controlPlaneInternalUrl;

    this._planes = [
      {
        label: "obot-mcp-gateway",
        deploymentName: config.obotDeploymentName,
        // OBOT_SERVER_PROVIDER_REGISTRIES was removed (P0.2): it is an LLM model-provider
        // knob, not an MCP catalogue, so enforcing it pointed Obot at a no-op endpoint.
        // Authentication is now a deploy-time Helm choice (mcpGateway.auth.enabled), so it
        // is not repaired here. Only the runtime backend is a load-bearing invariant.
        envSpecs: [
          { name: "OBOT_SERVER_MCPRUNTIME_BACKEND", expected: "kubernetes" },
        ],
      },
      {
        label: "skill-registry",
        deploymentName: config.skillRegistryDeploymentName,
        envSpecs: [
          { name: "CONTROL_PLANE_URL", expected: controlPlaneBaseUrl },
        ],
      },
    ];
  }

  /**
   * Start the periodic drift check loop.
   *
   * An immediate check fires on startup so issues surface without waiting
   * for the first interval tick.
   */
  start(): void
  {
    this._log.info(
      { planes: this._planes.map(function _label(p) { return p.label; }) },
      "runtime plane drift repairer started",
    );

    const repairer = this;
    this._timer = setInterval(function _tick()
    {
      void repairer._checkAndRepairAll();
    }, this._intervalMs);

    void this._checkAndRepairAll();
  }

  /**
   * Stop the drift check loop and release the interval handle.
   */
  stop(): void
  {
    if (this._timer !== null)
    {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run a drift check and repair cycle for every managed plane.
   */
  private async _checkAndRepairAll(): Promise<void>
  {
    for (const plane of this._planes)
    {
      try
      {
        await this._checkAndRepairPlane(plane);
      }
      catch (err)
      {
        // Log but do not propagate — one failing plane must not block the others.
        this._log.warn({ err, plane: plane.label }, "drift check failed for plane");
      }
    }
  }

  /**
   * Fetch the current Deployment spec for a plane, compare env vars against
   * intent, and patch back any that have drifted.
   *
   * @param plane - Specification of the plane to check and repair.
   */
  private async _checkAndRepairPlane(plane: _PlaneSpec): Promise<void>
  {
    // 1. Fetch current deployment spec.
    let deployment: k8s.V1Deployment;
    try
    {
      const result = await this._appsApi.readNamespacedDeployment({
        name: plane.deploymentName,
        namespace: this._namespace,
      });
      deployment = result;
    }
    catch (err)
    {
      // Deployment may not exist yet (e.g. during cluster bootstrap).
      this._log.debug({ plane: plane.label, err }, "deployment not found; skipping drift check");
      return;
    }

    const containers = deployment.spec?.template?.spec?.containers ?? [];
    if (containers.length === 0)
    {
      return;
    }

    const container = containers[0]!;
    const currentEnv: k8s.V1EnvVar[] = container.env ?? [];

    // 2. Identify drifted vars.
    const drifted: Array<{ name: string; current: string | undefined; expected: string }> = [];
    for (const spec of plane.envSpecs)
    {
      const live = currentEnv.find(function _match(e) { return e.name === spec.name; });
      if (live?.value !== spec.expected)
      {
        drifted.push({ name: spec.name, current: live?.value, expected: spec.expected });
      }
    }

    if (drifted.length === 0)
    {
      this._log.debug({ plane: plane.label }, "no drift detected");
      return;
    }

    // 3. Log the drift before repairing.
    this._log.warn(
      { plane: plane.label, drifted },
      "runtime plane env drift detected — repairing",
    );

    // 4. Build a patched env array by updating only the `value` field of drifted
    //    entries in-place.  This preserves `valueFrom.secretKeyRef` and other
    //    non-value fields on env vars that happened to drift.
    const driftMap = new Map(drifted.map(function _entry(d) { return [d.name, d.expected]; }));
    const repairedEnv: k8s.V1EnvVar[] = currentEnv.map(function _repairIfDrifted(e)
    {
      const expected = driftMap.get(e.name ?? "");
      return expected !== undefined ? { ...e, value: expected } : e;
    });

    // 5. Patch only the container env — use a strategic merge patch so we do
    //    not accidentally clobber unrelated fields.
    //    Cast via unknown because the strategic-merge patch body is a subset of
    //    V1DeploymentSpec and does not require the `selector` required field.
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [{ name: container.name, env: repairedEnv }],
          },
        },
      },
    } as unknown as k8s.V1Deployment;

    // Content-Type must be explicit — without it the client defaults to
    // json-patch+json, which expects an array; the server rejects our object
    // with a 400. The @kubernetes/client-node@1.x request object has no
    // `contentType` field; the strategy is set via the ConfigurationOptions
    // second argument (same idiom as idle-checker / policies operator).
    await this._appsApi.patchNamespacedDeployment(
      {
        name: plane.deploymentName,
        namespace: this._namespace,
        body: patch,
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
    );

    this._log.info(
      { plane: plane.label, repairedVars: drifted.map(function _name(d) { return d.name; }) },
      "runtime plane drift repaired",
    );
  }
}
