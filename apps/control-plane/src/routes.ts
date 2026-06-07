import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { accessTokensRouter } from "./routes/access-tokens.js";
import { aiBudgetRouter } from "./routes/ai-budget.js";
import { auditRouter } from "./routes/audit.js";
import { groupsRouter } from "./routes/groups.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { metricsRouter } from "./routes/metrics.js";
import { openapiRouter } from "./routes/openapi-route.js";
import { policiesRouter } from "./routes/policies.js";
import { prometheusMetricsRouter } from "./routes/prometheus-metrics.js";
import { providerKeysRouter } from "./routes/provider-keys.js";
import { skillCatalogRouter } from "./routes/skill-catalog.js";
import { tenantsRouter } from "./routes/tenants.js";
import { thirdPartySourcesRouter } from "./routes/third-party-sources.js";
import { tokenUsageRouter } from "./routes/token-usage.js";
import { _CheckDbHealth } from "./infra/db/healtcheck-db.js";

/**
 * Registers all API routes on the given Express application instance.
 * All business routes are namespaced under /api/v1/.
 * Infrastructure routes (/healthz, /prom) remain at the root.
 *
 * @param app - Express application to register routes on.
 * @param prisma - Prisma ORM client for database access in route handlers.
 * @param customApi - Kubernetes Custom Objects API client for tenant and policy management.
 * @param coreApi - Kubernetes Core V1 API client for AI budget management.
 * @returns The Express application instance with registered routes.
 */
export function _RegisterRoutes(app: Express, prisma: PrismaClient, customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api): Express
{
  app.use("/api/v1/metrics", metricsRouter(customApi, prisma));
  app.use("/api/v1/audit", auditRouter(prisma));
  app.use("/api/v1/tenants", tenantsRouter(customApi, prisma));
  app.use("/api/v1/policies", policiesRouter(customApi, prisma));
  app.use("/api/v1/ai-budget", aiBudgetRouter(coreApi, prisma));
  app.use("/api/v1/token-usage", tokenUsageRouter(prisma));
  app.use("/api/v1/groups", groupsRouter(prisma));
  app.use("/api/v1/mcp-servers", mcpServersRouter(prisma));
  app.use("/api/v1/skills/catalog", skillCatalogRouter(prisma));
  app.use("/api/v1/third-party-sources", thirdPartySourcesRouter(prisma));
  app.use("/api/v1/access-tokens", accessTokensRouter(prisma));
  app.use("/api/v1/providers/keys", providerKeysRouter(prisma));
  app.use("/api/v1/openapi.json", openapiRouter());
  app.get("/healthz", _CheckDbHealth(prisma));
  app.use("/prom", prometheusMetricsRouter(prisma, customApi));
  return app;
}
