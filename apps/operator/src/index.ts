import * as k8s from "@kubernetes/client-node";
import pino from "pino";

import { _LoadOperatorConfig } from "./config.js";
import { _CreateTenantOperator, IdleChecker } from "./tenants/index.js";
import { PolicyOperator } from "./policies/operator.js";
import { FleetCanaryController, _ReadFleetUpdateConfig } from "./fleet/fleet-canary.controller.js";

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

  // Start fleet canary release polling when auto-update is enabled
  const fleetConfig = _ReadFleetUpdateConfig();
  if (fleetConfig.autoUpdateEnabled)
  {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const fleetController = new FleetCanaryController(customApi, appsApi, log, config.watchNamespace, fleetConfig);
    log.info({ releaseTag: fleetConfig.releaseTag, canaryTimeoutMs: fleetConfig.canaryTimeoutMs }, "fleet canary controller enabled");

    // Poll npm registry for new releases; the controller handles rollout internally
    setInterval(async function _pollRelease()
    {
      try
      {
        const latest = await fleetController.getLatestRelease();
        if (latest !== null)
        {
          log.debug({ latest }, "fleet release poll");
        }
      }
      catch (err)
      {
        log.warn({ err }, "fleet release poll failed; will retry next interval");
      }
    }, 15 * 60 * 1000); // every 15 minutes
  }
  else
  {
    log.info("fleet auto-update disabled (OPENCRANE_AUTO_UPDATE_ENABLED not set to true)");
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
