import * as k8s from "@kubernetes/client-node";

import pino from "pino";
import { pinoHttp } from "pino-http";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";

import { ___AuthRouter } from "./infra/auth/auth.router.js";
import { _BuildGatewayAdmin } from "./core/connections/gateway-admin.js";
import { ___CreateOidcAuthService } from "./infra/auth/oidc.service.js";
import { ___CreatePrismaClient } from "./infra/db/db.js";
import { ___AuthMiddleware } from "./infra/middleware/auth.middleware.js";
import { _TransportSecurity } from "./infra/middleware/transport-security.middleware.js";
import { _ErrorHandler } from "./middleware/error-handler.js";

import { _RegisterRoutes } from "./routes.js";
import { _SeedModels } from "./core/model-routing/seed-models.js";

/** Application logger instance. */
const log = pino({ name: "ctrl" });

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
  const authService = ___CreateOidcAuthService(log, prisma);

  // Middleware
  app.set("trust proxy", 1);
  // Transport security first: HSTS on HTTPS responses + optional HTTP→HTTPS redirect,
  // before any body parsing or session handling.
  app.use(_TransportSecurity());
  app.use(express.json());
  app.use(pinoHttp({ logger: log }));
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

app.listen(port, function _onListen()
{
  log.info({ port }, "control plane listening");
});

// Idempotently seed the global model registry from MODEL_REGISTRY_SEED (opt-in; empty by
// default). Best-effort and non-fatal — a seed failure must never block the control plane
// from serving, so we log and continue rather than crash on startup.
void _SeedModels(prisma, log).catch(function _onSeedError(err: unknown)
{
  log.warn({ err }, "model registry seed failed (non-fatal)");
});
