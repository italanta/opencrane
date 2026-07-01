import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { accessTokensRouter } from "./routes/access-tokens.js";
import { aiBudgetRouter } from "./routes/ai-budget.js";
import { auditRouter } from "./routes/audit.js";
import { groupsRouter } from "./routes/groups.js";
import { _RegisterInternalBundles } from "./routes/internal/skill-bundles.js";
import { _RegisterInternalTenantContract } from "./routes/internal/tenant-contract.js";
import { _RegisterInternalTenantModels } from "./routes/internal/tenant-models.js";
import { _RegisterInternalParticipation } from "./routes/internal/participation.js";
import { mcpOperatorRouter } from "./routes/mcp-operator.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { metricsRouter } from "./routes/metrics.js";
import { policiesRouter } from "./routes/policies.js";
import { prometheusMetricsRouter } from "./routes/prometheus-metrics.js";
import { providerKeysRouter } from "./routes/provider-keys.js";
import { providerCredentialsRouter } from "./routes/provider-credentials.js";
import { providerByokRouter } from "./routes/provider-byok.js";
import { modelRegistryRouter } from "./routes/model-registry.js";
import { modelRoutingDefaultsRouter } from "./routes/model-routing-defaults.js";
import { modelRoutingRecommendationsRouter } from "./routes/model-routing-recommendations.js";
import { modelRoutingMetricsRouter } from "./routes/model-routing-metrics.js";
import { routingEvalCasesRouter } from "./routes/routing-eval-cases.js";
import { routingMeasurementsRouter } from "./routes/routing-measurements.js";
import { routingProposalsRouter } from "./routes/routing-proposals.js";
import { _BuildShadowSeams } from "./core/model-routing/shadow-seams.js";
import { resourceSharesRouter } from "./routes/resource-shares.js";
import { sharesRouter } from "./routes/shares.js";
import { skillCatalogRouter } from "./routes/skill-catalog.js";
import { skillModelPostureRouter } from "./routes/skill-model-posture.js";
import { tenantsRouter } from "./routes/tenants.js";
import { thirdPartySourcesRouter } from "./routes/third-party-sources.js";
import { tokenUsageRouter } from "./routes/token-usage.js";
import { OciBundleStore } from "./core/oci/oci-bundle-store.js";
import { _BuildGatewayAdmin } from "./core/connections/gateway-admin.js";
import { _BuildDocMergeReconciler } from "./core/personalisation/reconciler.js";
import { companyDocsRouter } from "./routes/company-docs.js";
import { awarenessRolloutRouter } from "./routes/awareness-rollout.js";
import { awarenessParticipationRouter } from "./routes/awareness-participation.js";
import { sessionsRouter } from "./routes/sessions.js";
import { spendRouter } from "./routes/spend.js";
import { _CheckDbHealth, _OpenapiRouter } from "@opencrane/infra-http";
import { spec } from "./openapi/spec.js";

/**
 * Build the optional OCI (Zot) skill-bundle store from the environment.
 *
 * Returns null when `SKILL_OCI_REGISTRY_URL` is unset, in which case skill delivery
 * serves DB `content` only (today's behaviour). When set, publish dual-writes to the
 * store and delivery reads from it first, falling back to DB content (P4D.2 cutover).
 */
function _BuildOciBundleStore(): OciBundleStore | null
{
  const registryUrl = process.env.SKILL_OCI_REGISTRY_URL?.trim();
  if (!registryUrl)
  {
    return null;
  }
  return new OciBundleStore({ registryUrl, repository: process.env.SKILL_OCI_REPOSITORY?.trim() || "skills" });
}

/**
 * Registers all API routes on the given Express application instance.
 * All business routes are namespaced under /api/v1/.
 * Infrastructure routes (/healthz, /prom) remain at the root.
 *
 * @param app       - Express application to register routes on.
 * @param prisma    - Prisma ORM client for database access in route handlers.
 * @param customApi - Kubernetes Custom Objects API client for tenant and policy management.
 * @param coreApi   - Kubernetes Core V1 API client for AI budget management.
 * @param authApi   - Kubernetes Authentication API for tenant contract TokenReview validation.
 * @returns The Express application instance with registered routes.
 */
export function _RegisterRoutes(app: Express, prisma: PrismaClient, customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api, authApi: k8s.AuthenticationV1Api): Express
{
  // Internal routes — mounted before ___AuthMiddleware and not behind any token check.
  // Access is enforced by Kubernetes NetworkPolicy: only the Obot, skill-registry, and
  // tenant pods can reach the control-plane service on the cluster network.
  // @see apps/clustertenant-platform/templates/networkpolicy-planes.yaml — runtime-plane policies.
  // @see apps/clustertenant-platform/templates/obot-mcp-gateway-deployment.yaml — OBOT_SERVER_PROVIDER_REGISTRIES wiring.
  // Optional OCI store for skill-bundle content (P4D.2); null → DB-only delivery.
  const ociBundleStore = _BuildOciBundleStore();

  // Gateway admin for the connection kill-switch (CONN.5); no-op until a
  // control-plane operator device is paired (CONN.4 — needs live infra).
  const gatewayAdmin = _BuildGatewayAdmin();

  app.use("/api/internal/bundles", _RegisterInternalBundles(prisma, ociBundleStore));
  // NetworkPolicy-only (no auth/TokenReview): the operator fetches a tenant's
  // allowed model set + effective default at reconcile. Best-effort — never 404/500.
  app.use("/api/internal/tenant-models", _RegisterInternalTenantModels(prisma));
  // Note: /api/internal/contract enforces per-tenant identity via TokenReview — not NetworkPolicy-only.
  app.use("/api/internal/contract", _RegisterInternalTenantContract(prisma, authApi));
  app.use("/api/internal/awareness/participation", _RegisterInternalParticipation(prisma, authApi));

  app.use("/api/v1/metrics", metricsRouter(customApi, prisma));
  app.use("/api/v1/audit", auditRouter(prisma));
  app.use("/api/v1/tenants", tenantsRouter(customApi, prisma, coreApi, gatewayAdmin));
  app.use("/api/v1/policies", policiesRouter(customApi, prisma));
  app.use("/api/v1/ai-budget", aiBudgetRouter(coreApi, prisma));
  app.use("/api/v1/token-usage", tokenUsageRouter(prisma));
  app.use("/api/v1/groups", groupsRouter(prisma));
  app.use("/api/v1/mcp-servers", mcpServersRouter(prisma));
  app.use("/api/v1/mcp", mcpOperatorRouter(prisma));
  app.use("/api/v1/shares", sharesRouter(prisma));
  app.use("/api/v1/resource-shares", resourceSharesRouter(prisma));
  app.use("/api/v1/skills/catalog", skillCatalogRouter(prisma, ociBundleStore));
  app.use("/api/v1/skills/posture", skillModelPostureRouter(prisma));
  app.use("/api/v1/model-routing/defaults", modelRoutingDefaultsRouter(prisma));
  app.use("/api/v1/model-routing/eval-cases", routingEvalCasesRouter(prisma));
  app.use("/api/v1/model-routing/measurements", routingMeasurementsRouter(prisma, _BuildShadowSeams));
  app.use("/api/v1/model-routing/proposals", routingProposalsRouter(prisma));
  app.use("/api/v1/model-routing/recommendations", modelRoutingRecommendationsRouter(prisma));
  app.use("/api/v1/model-routing/metrics", modelRoutingMetricsRouter(prisma));
  app.use("/api/v1/third-party-sources", thirdPartySourcesRouter(prisma));
  app.use("/api/v1/org/workspace-docs", companyDocsRouter(prisma, _BuildDocMergeReconciler()));
  // NOTE: the fleet / super-admin surfaces — ClusterTenant lifecycle, billing accounts, org
  // membership, platform DNS, and Zitadel administration — have moved to the cluster-wide
  // fleet-manager (Stage 4). The silo keeps ClusterTenant + OrgMembership as local READ-MODELS
  // (for per-org login + the org-admin gate) but no longer SERVES their management API.
  app.use("/api/v1/awareness/rollout", awarenessRolloutRouter(prisma));
  app.use("/api/v1/awareness/participation", awarenessParticipationRouter(prisma));
  app.use("/api/v1/sessions", sessionsRouter(prisma));
  app.use("/api/v1/spend", spendRouter(prisma));
  app.use("/api/v1/access-tokens", accessTokensRouter(prisma));
  app.use("/api/v1/providers/keys", providerKeysRouter(prisma));
  app.use("/api/v1/providers/credentials", providerCredentialsRouter(prisma));
  // BYOK raw-key path — writes the silo's provider key Secret in the operator's own namespace
  // (POD_NAMESPACE, downward-API populated; "default" fallback mirrors config._readOwnNamespace).
  app.use("/api/v1/providers/byok", providerByokRouter(prisma, coreApi, process.env.POD_NAMESPACE?.trim() || "default"));
  app.use("/api/v1/models", modelRegistryRouter(prisma));
  app.use("/api/v1/openapi.json", _OpenapiRouter(spec));
  app.get("/healthz", _CheckDbHealth(prisma));
  app.use("/prom", prometheusMetricsRouter(prisma, customApi));
  return app;
}
