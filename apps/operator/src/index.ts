import * as k8s from "@kubernetes/client-node";
import pino from "pino";

import { _LoadOperatorConfig } from "./config.js";
import { ObotHealthChecker } from "./mcp-gateway/obot-health-checker.js";
import { _CreateTenantOperator, IdleChecker } from "./tenants/index.js";
import { PolicyOperator } from "./policies/operator.js";
import { _ReadTenantRolloutConfig, TenantUpdateWithCanaryStrategyController } from "./tenant-rollout/tenant-update-with-canary-strategy.controller.js";

/** Root logger for the opencrane-operator process. */
const log = pino({ name: "opencrane-operator" });

/** Reference to the idle checker, set during startup for shutdown access. */
let _idleCheckerRef: IdleChecker | null = null;

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

    // Poll npm registry for new releases; the controller handles rollout internally
    setInterval(async function _pollRelease()
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

  // Start idle-checker (runs on a timer, non-blocking)
  _idleCheckerRef = idleChecker;
  idleChecker.start();

  // Start both watchers concurrently
  await Promise.all([tenantOperator.start(), policyOperator.start()]);
}

/**
 * Perform a graceful shutdown by logging the signal and exiting.
 */
function _shutdown(signal: string): void
{
  log.info({ signal }, "shutting down");
  _idleCheckerRef?.stop();
  process.exit(0);
}

process.on("SIGTERM", () => _shutdown("SIGTERM"));
process.on("SIGINT", () => _shutdown("SIGINT"));

main().catch(function (err)
{
  log.fatal({ err }, "operator crashed");
  process.exit(1);
});
