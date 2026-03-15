import * as k8s from "@kubernetes/client-node";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import pino from "pino";

import { authMiddleware } from "./middleware/auth.js";
import { auditRouter } from "./routes/audit.js";
import { policiesRouter } from "./routes/policies.js";
import { skillsRouter } from "./routes/skills.js";
import { tenantsRouter } from "./routes/tenants.js";

/** Application logger instance. */
const log = pino({ name: "opencrane-control-plane" });

/** HTTP port the server listens on. */
const port = Number(process.env.PORT ?? "8080");

// Initialize Kubernetes client
/** Kubernetes configuration loaded from the default context. */
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

/** Kubernetes Custom Objects API client. */
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

/** Kubernetes Core V1 API client. */
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

// Build Hono app
/** Root Hono application instance. */
const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", authMiddleware());

// Health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

// API routes
app.route("/api/tenants", tenantsRouter(customApi));
app.route("/api/skills", skillsRouter());
app.route("/api/policies", policiesRouter(customApi));
app.route("/api/audit", auditRouter(coreApi));

// Start server
log.info({ port }, "starting opencrane control plane");

serve({ fetch: app.fetch, port }, (info) => {
  log.info({ port: info.port }, "control plane listening");
});
