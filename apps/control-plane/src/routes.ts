import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import { PrismaClient } from "@prisma/client/extension";

import { policiesRouter } from "./routes/policies.js";
import { auditRouter } from "./routes/audit.js";

import { aiBudgetRouter } from "./routes/ai-budget.js";
import { metricsRouter } from "./routes/metrics.js";

import { providerKeysRouter } from "./routes/provider-keys.js";

import { skillsRouter } from "./routes/skills.js";
import { tenantsRouter } from "./routes/tenants.js";

import { tokenUsageRouter } from "./routes/token-usage.js";
import { accessTokensRouter } from "./routes/access-tokens.js";

import { _CheckDbHealth } from "./infra/db/healtcheck-db.js";

/**
 * Registers all API routes on the given Express application instance.
 * 
 * @param app       - Express application to register routes on
 * @param prisma    - Prisma ORM client for database access in route handlers
 * @param customApi - Kubernetes Custom Objects API client for tenant and policy management
 * @param coreApi   - Kubernetes Core V1 API client for AI budget management
 *
 * @returns The Express application instance with registered routes (for chaining)
 */
export function _RegisterRoutes(app: Express, prisma: PrismaClient, customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api)
{
  // API routes
  // 1. Infra Management
     // Server Management
  app.use("/api/metrics",   metricsRouter(prisma));
    // TODO - Investigate
  app.use("/api/audit",     auditRouter(prisma));

  // 2. Org & Tenant Management
     // Ability to create and review tenants
  app.use("/api/tenants",   tenantsRouter(customApi, prisma));  
     // Set org-wide security policies
  app.use("/api/policies",  policiesRouter(customApi, prisma));
     // Manage spent at the org level
  app.use("/api/ai-budget",   aiBudgetRouter(coreApi, prisma));
  app.use("/api/token-usage", tokenUsageRouter(prisma));

  // 3. Organisations & Collaboration
     // Deploying and sharing of skills
  app.use("/api/skills",    skillsRouter(prisma));
  
     // Provider management
  app.use("/api/access-tokens",  accessTokensRouter(prisma));
  app.use("/api/providers/keys", providerKeysRouter(prisma));

   // Misc
   // 4. Health check — returns 200 if DB is reachable, 503 if degraded
   app.get("/healthz", _CheckDbHealth(prisma));

  return app;
}
