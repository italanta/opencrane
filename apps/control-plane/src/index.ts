import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as k8s from "@kubernetes/client-node";

import pino from "pino";
import { pinoHttp } from "pino-http";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";

import { ___AuthRouter } from "./infra/auth/auth.router.js";
import { ___CreateOidcAuthService } from "./infra/auth/oidc.service.js";
import { ___CreatePrismaClient } from "./infra/db/db.js";
import { ___AuthMiddleware } from "./infra/middleware/auth.middleware.js";

import { _RegisterRoutes } from "./routes.js";

/** Application logger instance. */
const log = pino({ name: "ctrl" });

/**
 * Creates and configures the Express application with all middleware and routes.
 * Exported for use in tests with injected dependencies.
 * @param prisma - Prisma ORM client
 * @param customApi - Kubernetes Custom Objects API client
 * @param coreApi - Kubernetes Core V1 API client
 * @returns Configured Express application
 */
export function createApp(prisma: PrismaClient, customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api): Express
{
  const app = express();
  const authService = ___CreateOidcAuthService(log);

  // Middleware
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(pinoHttp({ logger: log }));
  app.use(authService.createSessionMiddleware());
  app.use("/api/auth", ___AuthRouter(authService));
  app.use(___AuthMiddleware());

  // Register API routes
  _RegisterRoutes(app, prisma, customApi, coreApi);

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packageDirectory = resolve(currentDirectory, "..");
  const uiDirectory = resolve(packageDirectory, "../control-plane-ui/dist/control-plane-ui/browser");
  const hasUiBuild = existsSync(uiDirectory);

  if (hasUiBuild)
  {
    log.info({ uiDirectory }, "serving control-plane UI static assets");
    app.use(express.static(uiDirectory));
    app.get(/^(?!\/api|\/healthz).*/, function _spaFallback(req, res)
    {
      res.sendFile(join(uiDirectory, "index.html"));
    });
  }
  else
    log.warn({ uiDirectory }, "control-plane UI build directory not found; serving API routes only");

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

// Build and start app
const app = createApp(prisma, customApi, coreApi);

log.info({ port }, "starting opencrane control plane");

app.listen(port, function _onListen()
{
  log.info({ port }, "control plane listening");
});
