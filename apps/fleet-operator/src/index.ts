// OpenTelemetry must initialise before any instrumented module is imported.
import "./instrument.js";

import type { Server } from "node:http";

import * as k8s from "@kubernetes/client-node";
import express from "express";

import { ___BindConsole, ___ShutdownTelemetry } from "@opencrane/observability";
import { ___AuthMiddleware } from "@opencrane/infra-auth";
import { _ErrorHandler, _RateLimit } from "@opencrane/infra-http";

import { _LoadFleetOperatorConfig } from "./config.js";
import { _CreateClusterTenantOperator } from "./cluster-tenants/index.js";
import { _log as log } from "./log.js";
import { ___CreateFleetPrismaClient } from "./infra/db/db.js";
import { ___CreateFleetOidcAuthService } from "./infra/auth/oidc.service.js";
import { _SeedClusterTenant } from "./infra/cluster-tenant-seed.js";
import { ___FleetAuthRouter } from "./infra/auth/auth.router.js";
import { _RegisterFleetRoutes } from "./routes.js";
import type { PrismaClient } from "./generated/prisma/index.js";

// Route any stray console.* output through the structured logger.
const _unbindConsole = ___BindConsole(log);

/** Reference to the fleet-manager HTTP API server, for graceful shutdown. */
let _serverRef: Server | null = null;

/** Reference to the fleet registry Prisma client, for graceful shutdown. */
let _prismaRef: PrismaClient | null = null;

/**
 * Bootstrap the fleet-manager: the cluster-wide singleton that owns the
 * cross-silo super-admin surface (ClusterTenant lifecycle, billing, org
 * membership, platform DNS, Zitadel admin) plus the one reconcile loop the
 * fleet runs — the ClusterTenantOperator.
 *
 * Stage 5: the fleet stops at ClusterTenant lifecycle and watches NOTHING
 * inside a silo. Every in-silo controller (tenant runtime, policies, plane
 * drift-repair, rollout canary, Obot health, gateway proxy) now runs in the
 * per-silo clustertenant-platform over its own namespace, so a silo stands on
 * its own.
 */
async function main(): Promise<void>
{
  log.info("starting opencrane fleet-manager");

  const config = _LoadFleetOperatorConfig();
  log.info({ config }, "loaded fleet operator config");

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  // Fleet registry DB + HTTP API (ADR 0002 silo split). fleet-manager is the cluster-wide
  // singleton hosting the cross-silo super-admin surface: ClusterTenant lifecycle, billing,
  // org membership, platform DNS, and Zitadel admin (Stage 4). Started before the watch loop
  // so health checks come up promptly.
  const prisma = ___CreateFleetPrismaClient(log);
  _prismaRef = prisma;
  const authService = ___CreateFleetOidcAuthService(log, prisma);
  const app = express();
  // Trust the ingress proxy's X-Forwarded-* so cookie `secure` + host-derived redirect URIs
  // resolve correctly behind the load balancer.
  app.set("trust proxy", true);
  app.use(...authService.createSessionMiddleware());
  app.use(express.json());
  // Per-IP rate limit, before the auth router + auth middleware + routes, so every DB-backed /
  // authz-gated fleet endpoint (incl. the OIDC login flow below) is covered. Generous cap — a
  // DoS backstop, not a functional limit; /healthz, /readyz, and /api/internal are exempt.
  app.use(_RateLimit());
  // Browser OIDC login flow + session introspection. Mounted BEFORE ___AuthMiddleware so the
  // login routes are reachable without a valid session — no bypass hack required.
  app.use("/api/v1/auth", ___FleetAuthRouter(authService));
  // No DB access-token reader: the fleet registry has no AccessToken model, so auth is OIDC
  // session or the env-var token only.
  app.use(___AuthMiddleware());
  const fleetCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const fleetCoreApi = kc.makeApiClient(k8s.CoreV1Api);
  _RegisterFleetRoutes(app, prisma, fleetCustomApi, fleetCoreApi);
  // Global error handler — registered AFTER routes so route errors (incl. the authz gates'
  // `.catch(next)`) are structured-logged + returned as the standard envelope, not Express's
  // unlogged default 500.
  app.use(_ErrorHandler(log));
  const apiPort = Number(process.env.PORT ?? "8080");
  _serverRef = app.listen(apiPort, function _onApiListen() { log.info({ port: apiPort }, "fleet-manager API listening"); });

  // Single-tenant profile: seed the configured ClusterTenant + its owner membership into the
  // fleet registry directly (the seed pattern, NOT the billing-gated POST). A strict no-op when
  // no seed env is set, idempotent on re-run, and fail-soft so a seed error never stops startup.
  void _SeedClusterTenant(prisma, fleetCustomApi, log);

  // The fleet's one reconcile loop: drive the cluster-scoped ClusterTenant CR (org) from
  // `pending` to `ready` — bind the namespace boundary and (gated) the per-org domain. Without
  // this, an org created via the control plane would sit `pending` forever. The fleet watches
  // ONLY this cluster-scoped CR; everything inside a silo is the silo's own concern.
  const clusterTenantOperator = _CreateClusterTenantOperator(kc, config, log);
  await clusterTenantOperator.start();
}

/**
 * Perform a graceful shutdown: stop accepting connections, disconnect Prisma,
 * flush buffered spans to the collector, restore console, then exit. A
 * hard-exit timer guards a stuck flush.
 * @param signal - The signal that triggered shutdown.
 */
async function _shutdown(signal: string): Promise<void>
{
  log.info({ signal }, "shutting down");

  const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
  hardExit.unref();

  try
  {
    if (_serverRef)
    {
      await new Promise<void>(function _close(resolve) { _serverRef?.close(function _done() { resolve(); }); });
    }
    await _prismaRef?.$disconnect();
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
  log.fatal({ err }, "fleet-manager crashed");
  process.exit(1);
});
