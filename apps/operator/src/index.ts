// OpenTelemetry must initialise before any instrumented module is imported.
import "./instrument.js";

import * as k8s from "@kubernetes/client-node";

import { ___BindConsole, ___CreateLogger, ___ShutdownTelemetry, ___DoWithTrace } from "@opencrane/observability";

import { _LoadOperatorConfig } from "./config.js";
import { ObotHealthChecker } from "./mcp-gateway/obot-health-checker.js";
import { RuntimePlaneDriftRepairer } from "./runtime-planes/drift-repairer.js";
import { _CreateTenantOperator, IdleChecker } from "./tenants/index.js";
import { _CreateClusterTenantOperator } from "./cluster-tenants/index.js";
import { PolicyOperator } from "./policies/operator.js";
import { _ReadTenantRolloutConfig, TenantUpdateWithCanaryStrategyController } from "./tenant-rollout/tenant-update-with-canary-strategy.controller.js";
import { GatewayProxyServer } from "./gateway-proxy/server.js";

/** Root logger for the opencrane-operator process — structured JSON, trace-correlated. */
const log = ___CreateLogger("operator");

// Route any stray console.* output through the structured logger.
const _unbindConsole = ___BindConsole(log);

/** Reference to the idle checker, set during startup for shutdown access. */
let _idleCheckerRef: IdleChecker | null = null;

/** Reference to the drift repairer, set during startup for shutdown access. */
let _driftRepairerRef: RuntimePlaneDriftRepairer | null = null;

/** Reference to the in-process gateway proxy server, for graceful shutdown. */
let _gatewayProxyRef: GatewayProxyServer | null = null;

/**
 * Bootstrap and start both the Tenant and Policy operator watch loops,
 * plus the idle-checker for auto-suspending inactive tenants.
 */
async function main(): Promise<void>
{
  log.info("starting opencrane operator");

  const config = _LoadOperatorConfig();
  log.info({ config }, "loaded operator config");

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const tenantOperator = _CreateTenantOperator(kc, config, log);
  const policyOperator = new PolicyOperator(kc, config, log);
  // Reconciles the cluster-scoped ClusterTenant CR (org) from `pending` to `ready`:
  // binds the namespace boundary and (gated) the per-org domain. Without this, an
  // org created via the control plane would sit `pending` forever.
  const clusterTenantOperator = _CreateClusterTenantOperator(kc, config, log);
  const idleChecker = new IdleChecker(kc, config, log);

  // Start tenant rollout canary release polling when auto-update is enabled
  const tenantRolloutConfig = _ReadTenantRolloutConfig();
  if (tenantRolloutConfig.autoUpdateEnabled)
  {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const tenantRolloutController = new TenantUpdateWithCanaryStrategyController(
      customApi,
      appsApi,
      log,
      config.watchNamespace,
      tenantRolloutConfig,
    );
    log.info(
      { releaseTag: tenantRolloutConfig.releaseTag, canaryTimeoutMs: tenantRolloutConfig.canaryTimeoutMs },
      "tenant rollout canary controller enabled",
    );

    // Poll npm registry for new releases; the controller handles rollout internally.
    // Each tick is a traced `tenant.rollout.poll` operation so a slow/failing
    // registry probe is attributable in the trace timeline.
    setInterval(function _pollRelease()
    {
      void ___DoWithTrace("tenant.rollout.poll", { releaseTag: tenantRolloutConfig.releaseTag }, async function _poll()
      {
        try
        {
          const latest = await tenantRolloutController.getLatestRelease();
          if (latest !== null)
          {
            log.debug({ latest }, "tenant rollout release poll");
          }
        }
        catch (err)
        {
          log.warn({ err }, "tenant rollout release poll failed; will retry next interval");
        }
      });
    }, 15 * 60 * 1000); // every 15 minutes
  }
  else
  {
    log.info("tenant rollout auto-update disabled (OPENCRANE_AUTO_UPDATE_ENABLED not set to true)");
  }

  // Start Obot MCP gateway health checker (Obot self-syncs catalog via OBOT_SERVER_PROVIDER_REGISTRIES;
  // the operator monitors reachability and logs warnings on failures).
  if (config.mcpGatewayUrl)
  {
    const obotHealthChecker = new ObotHealthChecker(config.mcpGatewayUrl, log);
    obotHealthChecker.start();
  }

  // Start runtime-plane drift repairer — periodically compares Obot MCP Gateway and
  // skill-registry Deployment env vars against control-plane intent and patches back
  // any manual edits so the planes stay wired to the correct control-plane endpoints.
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const driftRepairer = new RuntimePlaneDriftRepairer(appsApi, config, log);
  _driftRepairerRef = driftRepairer;
  driftRepairer.start();

  // Start idle-checker (runs on a timer, non-blocking)
  _idleCheckerRef = idleChecker;
  idleChecker.start();

  // Start the in-process identity-routing gateway proxy (DOMAIN.T4) when enabled. It
  // serves the gateway WebSocket on its own port: the per-org Ingress routes the WS
  // upgrade here, the proxy delegates auth to the control plane (/auth/gateway-resolve),
  // injects the verified X-Forwarded-User, and reverse-proxies to the user's pod. It
  // holds no Kubernetes client and no secrets.
  if (config.gatewayProxyEnabled)
  {
    const gatewayProxy = new GatewayProxyServer({
      port: config.gatewayProxyPort,
      controlPlaneUrl: config.controlPlaneInternalUrl,
      gatewayPort: config.gatewayPort,
      clusterDomain: config.clusterDomain,
      userHeader: config.gatewayTrustedProxyUserHeader,
      allowedOrigins: config.gatewayProxyAllowedOrigins,
      allowedOriginBaseDomains: config.gatewayProxyAllowedOriginBaseDomains,
      rateLimitPerMinute: config.gatewayProxyRateLimitPerMinute,
    }, log);
    gatewayProxy.start();
    _gatewayProxyRef = gatewayProxy;
  }
  else
  {
    log.info("in-operator gateway proxy disabled (GATEWAY_PROXY_ENABLED not true)");
  }

  // Start all watchers concurrently
  await Promise.all([tenantOperator.start(), policyOperator.start(), clusterTenantOperator.start()]);
}

/**
 * Perform a graceful shutdown: stop the timers, flush buffered spans to the
 * collector, restore console, then exit. A hard-exit timer guards a stuck flush.
 * @param signal - The signal that triggered shutdown.
 */
async function _shutdown(signal: string): Promise<void>
{
  log.info({ signal }, "shutting down");
  _idleCheckerRef?.stop();
  _driftRepairerRef?.stop();

  const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
  hardExit.unref();

  try
  {
    await _gatewayProxyRef?.stop();
    await ___ShutdownTelemetry();
  }
  finally
  {
    _unbindConsole();
    process.exit(0);
  }
}

process.on("SIGTERM", function _onSigterm() { void _shutdown("SIGTERM"); });
process.on("SIGINT", function _onSigint() { void _shutdown("SIGINT"); });

main().catch(function (err)
{
  log.fatal({ err }, "operator crashed");
  process.exit(1);
});
