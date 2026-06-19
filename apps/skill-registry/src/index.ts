// OpenTelemetry must initialise before any instrumented module is imported.
import "./instrument.js";

import { randomUUID } from "node:crypto";

import express from "express";
import * as k8s from "@kubernetes/client-node";
import { pinoHttp } from "pino-http";

import { ___BindConsole, ___CreateLogger, ___GetContext, ___RequestContext, ___ShutdownTelemetry } from "@opencrane/observability";

import { _LoadConfig } from "./config.js";
import { _BuildRouter } from "./routes.js";

/** Root logger for the skill-registry — structured JSON, trace-correlated. */
const log = ___CreateLogger("skill-registry");

// Route any stray console.* output through the structured logger.
const _unbindConsole = ___BindConsole(log);

async function main(): Promise<void>
{
  const config = _LoadConfig();

  // Build the Kubernetes client from the in-cluster service account.
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const authApi = kc.makeApiClient(k8s.AuthenticationV1Api);

  const app = express();
  // Seed the per-request correlation context before pino-http so every request
  // log (and the control-plane call it makes) shares one requestId.
  app.use(___RequestContext());
  app.use(pinoHttp({ logger: log, genReqId: function _genReqId() { return ___GetContext()?.requestId ?? randomUUID(); } }));
  app.use(_BuildRouter(authApi, config.controlPlaneUrl, log));

  const server = app.listen(config.port, function _onListen()
  {
    log.info({ port: config.port }, "skill-registry listening");
  });

  /**
   * Drain the server, flush spans, restore console, then exit.
   * @param signal - The signal that triggered shutdown.
   */
  async function _shutdown(signal: string): Promise<void>
  {
    log.info({ signal }, "shutting down skill-registry");
    const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
    hardExit.unref();
    try
    {
      await new Promise<void>(function _close(resolve) { server.close(function _done() { resolve(); }); });
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
}

main().catch(function _onError(err: unknown)
{
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
