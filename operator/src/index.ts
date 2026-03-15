import * as k8s from "@kubernetes/client-node";
import pino from "pino";
import { loadOperatorConfig } from "./types.js";
import { TenantOperator } from "./tenant-operator.js";
import { PolicyOperator } from "./policy-operator.js";

const log = pino({ name: "opencrane-operator" });

async function main() {
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

// Graceful shutdown
function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  log.fatal({ err }, "operator crashed");
  process.exit(1);
});
