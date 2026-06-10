import express from "express";
import * as k8s from "@kubernetes/client-node";
import pino from "pino";
import { pinoHttp } from "pino-http";

import { _LoadConfig } from "./config.js";
import { _BuildRouter } from "./routes.js";

const log = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function main(): Promise<void>
{
  const config = _LoadConfig();

  // Build the Kubernetes client from the in-cluster service account.
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const authApi = kc.makeApiClient(k8s.AuthenticationV1Api);

  const app = express();
  app.use(pinoHttp({ logger: log }));
  app.use(_BuildRouter(authApi, config.controlPlaneUrl, log));

  app.listen(config.port, function _onListen()
  {
    log.info({ port: config.port }, "skill-registry listening");
  });
}

main().catch(function _onError(err: unknown)
{
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
