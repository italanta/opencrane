// OpenTelemetry must be initialised before any instrumented module is imported,
// so this side-effecting import stays first in the file (and is also preloaded
// via NODE_OPTIONS=--import in the container).
import "./instrument.js";

import { randomUUID } from "node:crypto";

import * as k8s from "@kubernetes/client-node";

import { pinoHttp } from "pino-http";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";

import { ___BindConsole, ___GetContext, ___RequestContext, ___ShutdownTelemetry } from "@opencrane/observability";

import { ___AuthRouter } from "./infra/auth/auth.router.js";
import { _BuildGatewayAdmin } from "./core/connections/gateway-admin.js";
import { ___CreateOidcAuthService } from "./infra/auth/oidc.service.js";
import { ___CreatePrismaClient } from "./infra/db/db.js";
import { ___AuthMiddleware } from "@opencrane/infra-auth";
import { _TransportSecurity } from "./infra/middleware/transport-security.middleware.js";
import { _ErrorHandler } from "./middleware/error-handler.js";

import { _log as log } from "./log.js";
import { _RegisterRoutes } from "./routes.js";
import { TenantProjectionRepairer } from "./infra/tenant-projection-repairer.js";

// Route any stray console.* call (first-party or third-party) through the
// structured logger so nothing reaches stdout unstructured / uncorrelated.
const _unbindConsole = ___BindConsole(log);

/**
 * Creates and configures the Express application with all middleware and routes.
 * Exported for use in tests with injected dependencies.
 * @param prisma    - Prisma ORM client
 * @param customApi - Kubernetes Custom Objects API client
 * @param coreApi   - Kubernetes Core V1 API client
 * @param authApi   - Kubernetes Authentication API for tenant contract TokenReview
 * @returns Configured Express application
 */
export function createApp(prisma: PrismaClient, customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api, authApi: k8s.AuthenticationV1Api): Express
{
  const app = express();
  const authService = ___CreateOidcAuthService(log, prisma, customApi);

  // Middleware
  app.set("trust proxy", 1);
  // Transport security first: HSTS on HTTPS responses + optional HTTP→HTTPS redirect,
  // before any body parsing or session handling.
  app.use(_TransportSecurity());
  app.use(express.json());
  // Seed the per-request correlation context BEFORE pino-http so every request
  // log (and every downstream service log) shares one requestId.
  app.use(___RequestContext());
  // ___RequestContext() (mounted above) always seeds the id; the ?? is only a
  // type-level fallback so genReqId never returns undefined.
  app.use(pinoHttp({ logger: log, genReqId: function _genReqId() { return ___GetContext()?.requestId ?? randomUUID(); } }));
  app.use(authService.createSessionMiddleware());

  // Auth router is mounted before the auth middleware so its endpoints are
  // inherently public — the device-flow activate handler enforces its own
  // session check internally.
  app.use("/api/v1/auth", ___AuthRouter(authService, prisma, coreApi, _BuildGatewayAdmin()));

  // Pass prisma so DB-issued access tokens (from `oc auth login` and
  // POST /access-tokens) are validated in addition to the env-var token.
  app.use(___AuthMiddleware(prisma));

  // Register API routes
  _RegisterRoutes(app, prisma, customApi, coreApi, authApi);

  // Global error handler — must be registered after all routes.
  app.use(_ErrorHandler(log));

  return app;
}

/** HTTP port the server listens on. */
const port = Number(process.env.PORT ?? "8080");

// Initialize Prisma
const prisma = ___CreatePrismaClient(log);

// Initialize Kubernetes client
/** Kubernetes configuration loaded from the default context. */
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

/** Kubernetes Custom Objects API client. */
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

/** Kubernetes Core V1 API client. */
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

/** Kubernetes Authentication API client — used for tenant contract TokenReview validation. */
const authApi = kc.makeApiClient(k8s.AuthenticationV1Api);

// Build and start app
const app = createApp(prisma, customApi, coreApi, authApi);

log.info({ port }, "starting opencrane control plane");

const server = app.listen(port, function _onListen()
{
  log.info({ port }, "control plane listening");
});

// NOTE: the single-tenant ClusterTenant boot-seed moved to the fleet-manager (Stage 4) — the
// fleet owns the ClusterTenant registry. The silo receives its ClusterTenant read-model via CR
// projection, not a local boot-seed.

// Periodic Tenant-projection repair (Stage 4). The fleet-manager creates each org's
// `<org>-default` Tenant CRD on ready; the silo has no operator watch, so this loop reconciles
// its Postgres projection to the namespace's Tenant CRDs (creating missing rows) so fleet-seeded
// workspaces appear in the silo's management API. Idempotent + fail-soft; interval from
// OPENCRANE_PROJECTION_REPAIR_INTERVAL_SECONDS (default 60; 0 disables).
const _projectionRepairNamespace = process.env.NAMESPACE ?? "default";
const _projectionRepairIntervalMs = Number(process.env.OPENCRANE_PROJECTION_REPAIR_INTERVAL_SECONDS ?? "60") * 1000;
const tenantProjectionRepairer = new TenantProjectionRepairer(customApi, prisma, _projectionRepairNamespace, log, _projectionRepairIntervalMs);
tenantProjectionRepairer.start();

/**
 * Gracefully drain the server, disconnect Prisma, flush telemetry, and restore
 * console before exiting. A hard-exit timer guards against a stuck close so the
 * pod terminates within the kubelet grace period.
 * @param signal - The signal that triggered shutdown.
 */
async function _shutdown(signal: string): Promise<void>
{
  log.info({ signal }, "shutting down control plane");

  // 1. Force exit if graceful shutdown stalls, so we never exceed the grace period.
  const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
  hardExit.unref();

  // Stop the projection-repair loop so no sweep races the Prisma disconnect below.
  tenantProjectionRepairer.stop();

  try
  {
    // 2. Stop accepting new connections and let in-flight requests finish.
    await new Promise<void>(function _close(resolve) { server.close(function _done() { resolve(); }); });
    // 3. Release the DB pool so Postgres connections aren't leaked.
    await prisma.$disconnect();
    // 4. Flush any buffered spans to the collector before the process dies.
    await ___ShutdownTelemetry();
  }
  catch (err)
  {
    log.error({ err }, "error during graceful shutdown");
  }
  finally
  {
    // 5. Restore the original console methods last, then exit cleanly.
    _unbindConsole();
    process.exit(0);
  }
}

process.on("SIGTERM", function _onSigterm() { void _shutdown("SIGTERM"); });
process.on("SIGINT", function _onSigint() { void _shutdown("SIGINT"); });
