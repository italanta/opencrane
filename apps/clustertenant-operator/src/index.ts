// OpenTelemetry must be initialised before any instrumented module is imported,
// so this side-effecting import stays first in the file (and is also preloaded
// via NODE_OPTIONS=--import in the container).
import "./instrument.js";

import { randomUUID } from "node:crypto";

import * as k8s from "@kubernetes/client-node";

import { pinoHttp } from "pino-http";
import express, { type Express } from "express";
import type { PrismaClient } from "@prisma/client";

import { ___BindConsole, ___GetContext, ___RequestContext, ___ShutdownTelemetry, ___DoWithTrace } from "@opencrane/observability";
import { ___AuthMiddleware } from "@opencrane/infra-auth";
import { _ErrorHandler, _RateLimit } from "@opencrane/infra-http";

import { ___AuthRouter } from "./infra/auth/auth.router.js";
import { _BuildGatewayAdmin } from "./core/connections/gateway-admin.js";
import { ___CreateOidcAuthService } from "./infra/auth/oidc.service.js";
import { ___CreatePrismaClient } from "./infra/db/db.js";
import { _TransportSecurity } from "./infra/middleware/transport-security.middleware.js";
import { _log as log } from "./log.js";
import { _RegisterRoutes } from "./routes.js";
import { TenantProjectionRepairer } from "./infra/tenant-projection-repairer.js";

// In-silo controllers (Stage 5). The silo runs every in-silo reconcile loop over its OWN
// namespace, so a silo stands on its own; the fleet-manager watches only the cluster-scoped
// ClusterTenant CR and nothing inside a silo.
import { _LoadOperatorConfig } from "./config.js";
import type { OpenClawTenantOperatorConfig } from "./config.js";
import { _ProvisionByokKey } from "./core/model-routing/provision-byok-key.js";
import { _CreateTenantOperator, IdleChecker } from "./tenants/index.js";
import { PolicyOperator } from "./policies/operator.js";
import { RuntimePlaneDriftRepairer } from "./runtime-planes/drift-repairer.js";
import { _ReadTenantRolloutConfig, TenantUpdateWithCanaryStrategyController } from "./tenant-rollout/tenant-update-with-canary-strategy.controller.js";
import { GatewayProxyServer } from "./gateway-proxy/server.js";
import { ObotHealthChecker } from "./mcp-gateway/obot-health-checker.js";
import { _SeedOwnDefaultTenant } from "./core/cluster-tenants/seed-own-default-tenant.js";

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
  // Per-IP rate limit, before the auth router + routes, so every DB-backed / authz-gated
  // endpoint is covered. Generous cap — a DoS backstop, not a functional limit; /healthz,
  // /readyz, and /api/internal (the high-frequency pod-poll surface) are exempt.
  app.use(_RateLimit());
  // Seed the per-request correlation context BEFORE pino-http so every request
  // log (and every downstream service log) shares one requestId.
  app.use(___RequestContext());
  // ___RequestContext() (mounted above) always seeds the id; the ?? is only a
  // type-level fallback so genReqId never returns undefined.
  app.use(pinoHttp({ logger: log, genReqId: function _genReqId() { return ___GetContext()?.requestId ?? randomUUID(); } }));
  app.use(...authService.createSessionMiddleware());

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

/** Idle-checker handle, set during controller bootstrap for shutdown access. */
let _idleCheckerRef: IdleChecker | null = null;

/** Runtime-plane drift repairer handle, for graceful shutdown. */
let _driftRepairerRef: RuntimePlaneDriftRepairer | null = null;

/** In-process gateway proxy server handle, for graceful shutdown. */
let _gatewayProxyRef: GatewayProxyServer | null = null;

/**
 * Start every in-silo reconcile loop over this silo's OWN namespace (Stage 5).
 *
 * The fleet-manager stops at ClusterTenant lifecycle; the silo owns the tenant runtime:
 * the TenantOperator (openclaw pods/ConfigMaps/Services + LiteLLM keys), the PolicyOperator
 * (AccessPolicy → NetworkPolicy), the idle-suspend checker, the runtime-plane drift repairer,
 * the rollout canary controller, the Obot health checker, and the identity-routing gateway
 * proxy — all scoped to `config.watchNamespace` (this silo's namespace). Because the operator
 * is DB-less, its internal-API calls hit the silo's OWN API (its own Service), so a silo is
 * self-contained.
 *
 * Fail-soft: a controller bootstrap error is logged but never crashes the pod — the silo's
 * management API + health endpoint stay up so the misconfiguration is diagnosable rather than
 * crash-looping.
 */
/**
 * Optional boot-time bootstrap of this silo's OpenAI BYOK key, gated on the
 * `OPENCRANE_BOOTSTRAP_OPENAI_KEY` env var (injected from a deploy Secret — never hardcoded). When
 * set, provisions it as the silo's Global OpenAI key via the same path as the BYOK route: writes the
 * encrypted Secret, registers the LiteLLM credential, and seeds a default model. Idempotent (upsert)
 * so re-running on every boot is safe, and best-effort so a hiccup never blocks controller startup.
 *
 * Intended for short-lived testing: populate the deploy Secret to light a silo up, then delete it to
 * stop re-applying (the live key is removed via the BYOK delete endpoint / Model Keys UI, not by
 * clearing the env). The raw key is never logged.
 *
 * @param config - Operator config; supplies the operator's own namespace for the Secret write.
 */
async function _BootstrapProviderKeyIfConfigured(config: OpenClawTenantOperatorConfig): Promise<void>
{
  const apiKey = process.env.OPENCRANE_BOOTSTRAP_OPENAI_KEY?.trim();
  if (!apiKey)
  {
    return;
  }

  try
  {
    const result = await _ProvisionByokKey({ prisma, coreApi, operatorNamespace: config.operatorNamespace, provider: "openai", apiKey, log });
    log.info({ provider: "openai", litellmRegistered: result.litellmRegistered }, "bootstrap provider key provisioned for silo");
  }
  catch (err)
  {
    log.warn({ err }, "bootstrap provider key provisioning failed; continuing boot");
  }
}

async function _startInSiloControllers(): Promise<void>
{
  try
  {
    const config = _LoadOperatorConfig();
    log.info({ watchNamespace: config.watchNamespace }, "starting in-silo controllers");

    // Optional test bootstrap — provision this silo's OpenAI BYOK key from an injected env var
    // (sourced from a deploy Secret), BEFORE the default-tenant seed so the model it seeds satisfies
    // the seed's ≥1-model onboarding gate and the silo comes up usable. Awaited for that ordering.
    await _BootstrapProviderKeyIfConfigured(config);

    // Seed this silo's own `<org>-default` workspace Tenant from its ClusterTenant CR owner.
    // Use config.watchNamespace (the namespace the operators below reconcile in) so the seed
    // lands where the TenantOperator will pick it up — not the projection-repair namespace,
    // which is derived independently and could diverge under manual env overrides.
    void _SeedOwnDefaultTenant(customApi, prisma, config.watchNamespace, log);

    const tenantOperator = _CreateTenantOperator(kc, config, log);
    const policyOperator = new PolicyOperator(kc, config, log);

    const idleChecker = new IdleChecker(kc, config, log);
    _idleCheckerRef = idleChecker;
    idleChecker.start();

    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const driftRepairer = new RuntimePlaneDriftRepairer(appsApi, config, log);
    _driftRepairerRef = driftRepairer;
    driftRepairer.start();

    // Tenant rollout canary release polling (only when auto-update is enabled).
    const tenantRolloutConfig = _ReadTenantRolloutConfig();
    if (tenantRolloutConfig.autoUpdateEnabled)
    {
      const rolloutCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const rolloutController = new TenantUpdateWithCanaryStrategyController(rolloutCustomApi, appsApi, log, config.watchNamespace, tenantRolloutConfig);
      log.info({ releaseTag: tenantRolloutConfig.releaseTag }, "tenant rollout canary controller enabled");
      setInterval(function _pollRelease()
      {
        void ___DoWithTrace("tenant.rollout.poll", { releaseTag: tenantRolloutConfig.releaseTag }, async function _poll()
        {
          try
          {
            const latest = await rolloutController.getLatestRelease();
            if (latest !== null) log.debug({ latest }, "tenant rollout release poll");
          }
          catch (err)
          {
            log.warn({ err }, "tenant rollout release poll failed; will retry next interval");
          }
        });
      }, 15 * 60 * 1000);
    }
    else
    {
      log.info("tenant rollout auto-update disabled (OPENCRANE_AUTO_UPDATE_ENABLED not set to true)");
    }

    // Obot MCP gateway health checker (Obot self-syncs its catalog; this only monitors reachability).
    if (config.mcpGatewayUrl)
    {
      new ObotHealthChecker(config.mcpGatewayUrl, log).start();
    }

    // In-process identity-routing gateway proxy (DOMAIN.T4): serves the gateway WebSocket,
    // delegates auth to the silo control plane, injects X-Forwarded-User, reverse-proxies to
    // the user's pod. Holds no Kubernetes client and no secrets.
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
      log.info("in-silo gateway proxy disabled (GATEWAY_PROXY_ENABLED not true)");
    }

    // Start the watch loops concurrently — these reconcile Tenant + AccessPolicy CRs in the
    // silo's own namespace.
    await Promise.all([tenantOperator.start(), policyOperator.start()]);
  }
  catch (err)
  {
    log.error({ err }, "in-silo controller bootstrap failed; the silo API stays up but the tenant runtime is NOT reconciling");
  }
}

void _startInSiloControllers();

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

  // Stop the projection-repair loop + in-silo controllers so no sweep races the disconnect below.
  tenantProjectionRepairer.stop();
  _idleCheckerRef?.stop();
  _driftRepairerRef?.stop();
  await _gatewayProxyRef?.stop();

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
