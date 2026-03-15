import * as k8s from "@kubernetes/client-node";
import pino from "pino";

import { loadOperatorConfig } from "./types.js";
import { TenantOperator } from "./tenant-operator.js";
import { PolicyOperator } from "./policy-operator.js";

/** Root logger for the opencrane-operator process. */
const log = pino({ name: "opencrane-operator" });

/**
 * Bootstrap and start both the Tenant and Policy operator watch loops.
 */
async function main(): Promise<void>
{
  log.info("starting opencrane operator");

  const config = loadOperatorConfig();
  log.info({ config }, "loaded operator config");

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const tenantOperator = new TenantOperator(kc, config, log);
  const policyOperator = new PolicyOperator(kc, config, log);

  // Start both watchers concurrently
  await Promise.all([tenantOperator.start(), policyOperator.start()]);
}

/**
 * Perform a graceful shutdown by logging the signal and exiting.
 */
function _shutdown(signal: string): void
{
  log.info({ signal }, "shutting down");
  process.exit(0);
}

process.on("SIGTERM", () => _shutdown("SIGTERM"));
process.on("SIGINT", () => _shutdown("SIGINT"));

main().catch(function (err)
{
  log.fatal({ err }, "operator crashed");
  process.exit(1);
});
