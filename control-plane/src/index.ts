import * as k8s from "@kubernetes/client-node";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { pinoHttp } from "pino-http";

import { createPrismaClient, checkDbHealth } from "./db.js";
import { authMiddleware } from "./middleware/auth.js";
import { auditRouter } from "./routes/audit.js";
import { policiesRouter } from "./routes/policies.js";
import { skillsRouter } from "./routes/skills.js";
import { tenantsRouter } from "./routes/tenants.js";

/** Application logger instance. */
const log = pino({ name: "opencrane-control-plane" });

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

  // Middleware
  app.use(express.json());
  app.use(pinoHttp({ logger: log }));
  app.use(authMiddleware());

  // Health check (before routes, includes DB connectivity)
  app.get("/healthz", async function _healthCheck(req, res)
  {
    const dbHealthy = await checkDbHealth(prisma);
    const status = dbHealthy ? "ok" : "degraded";
    const statusCode = dbHealthy ? 200 : 503;

    res.status(statusCode).json({ status, db: dbHealthy });
  });

  // API routes
  app.use("/api/tenants", tenantsRouter(customApi, prisma));
  app.use("/api/skills", skillsRouter(prisma));
  app.use("/api/policies", policiesRouter(customApi, prisma));
  app.use("/api/audit", auditRouter(prisma));

  return app;
}

/** HTTP port the server listens on. */
const port = Number(process.env.PORT ?? "8080");

// Initialize Prisma
const prisma = createPrismaClient(log);

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
