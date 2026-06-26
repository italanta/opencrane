import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { accessTokensRouter } from "./routes/access-tokens.js";
import { aiBudgetRouter } from "./routes/ai-budget.js";
import { auditRouter } from "./routes/audit.js";
import { billingAccountsRouter } from "./routes/billing-accounts.js";
import { groupsRouter } from "./routes/groups.js";
import { _RegisterInternalBundles } from "./routes/internal/skill-bundles.js";
import { _RegisterInternalTenantContract } from "./routes/internal/tenant-contract.js";
import { _RegisterInternalTenantModels } from "./routes/internal/tenant-models.js";
import { _RegisterInternalParticipation } from "./routes/internal/participation.js";
import { mcpOperatorRouter } from "./routes/mcp-operator.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { metricsRouter } from "./routes/metrics.js";
import { openapiRouter } from "./routes/openapi-route.js";
import { policiesRouter } from "./routes/policies.js";
import { prometheusMetricsRouter } from "./routes/prometheus-metrics.js";
import { providerKeysRouter } from "./routes/provider-keys.js";
import { providerCredentialsRouter } from "./routes/provider-credentials.js";
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
import { platformDnsRouter } from "./routes/platform-dns.js";
import { clusterTenantsRouter } from "./routes/cluster-tenants.js";
import { clusterTenantMembersRouter } from "./routes/cluster-tenant-members.js";
import { _BuildClusterTenantProvisionerRegistry } from "./core/cluster-tenants/registry.js";
import { _BuildZitadelManagementClient } from "./infra/zitadel/zitadel-client.js";
import { _BuildZitadelKeySecretStore } from "./infra/zitadel/key-secret-store.js";
import { zitadelKeyRouter } from "./routes/admin/zitadel-key.js";
import { zitadelReconcileRouter } from "./routes/admin/zitadel-reconcile.js";
import { _CheckDbHealth } from "./infra/db/healtcheck-db.js";

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
 * Read a boolean feature flag from the environment, defaulting ON.
 *
 * Single-tenant installs turn the multi-tenant self-service surfaces OFF
 * (`OPENCRANE_BILLING_ENABLED=false`, `OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED=false`).
 * The multi-tenant profile leaves them unset, so the default is ON — only an explicit
 * `false`/`0`/`off`/`no` disables the feature. Defaulting ON keeps existing
 * (multi-tenant) installs unchanged when the flag is absent.
 *
 * @param name - The environment variable name.
 * @returns True unless the variable is explicitly set to a falsey token.
 */
function _featureEnabled(name: string): boolean
{
  const raw = process.env[name]?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
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
  // @see platform/helm/templates/networkpolicy-planes.yaml — runtime-plane policies.
  // @see platform/helm/templates/obot-mcp-gateway-deployment.yaml — OBOT_SERVER_PROVIDER_REGISTRIES wiring.
  // Optional OCI store for skill-bundle content (P4D.2); null → DB-only delivery.
  const ociBundleStore = _BuildOciBundleStore();

  // Gateway admin for the connection kill-switch (CONN.5); no-op until a
  // control-plane operator device is paired (CONN.4 — needs live infra).
  const gatewayAdmin = _BuildGatewayAdmin();

  // Cluster-tenant provisioner registry (CT.6): the built-in shared provisioner
  // plus the external webhook backend when configured. Used by the management
  // API to gate which isolation tiers a customer may request.
  const clusterTenantRegistry = _BuildClusterTenantProvisionerRegistry();

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
  app.use("/api/v1/platform/dns", platformDnsRouter(customApi, coreApi));
  // Multi-tenant self-service surfaces. The single-tenant profile turns these OFF
  // (billing.enabled=false, clusterTenantManager.enabled=false in Helm): the org is
  // seeded directly at boot (see _SeedClusterTenant), so there is no self-service
  // billing or org management to expose. Default ON for the multi-tenant profile.
  if (_featureEnabled("OPENCRANE_BILLING_ENABLED"))
  {
    app.use("/api/v1/billing-accounts", billingAccountsRouter(prisma));
  }
  if (_featureEnabled("OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED"))
  {
    // Zitadel is a hard dependency of the multi-tenant path — built here (and only here)
    // so a single-cluster install (manager off) never requires it; fail-loud if unset.
    const zitadelClient = _BuildZitadelManagementClient();
    app.use("/api/v1/cluster-tenants", clusterTenantsRouter(prisma, clusterTenantRegistry, customApi, zitadelClient));
    // Org membership registry (the LOCAL rows the org-admin gate reads), mounted under
    // the parent org's `:name`. `mergeParams` carries `:name` into the child router.
    app.use("/api/v1/cluster-tenants/:name/members", clusterTenantMembersRouter(prisma));
    // Superadmin-gated rotation of the platform's Zitadel SA key (the master IdP credential).
    // Mounted here, on the manager-enabled path, because that is the ONLY place the live
    // Zitadel client exists; the key Secret is patched via the same CoreV1Api the app uses.
    app.use("/api/v1/admin/zitadel", zitadelKeyRouter(zitadelClient, _BuildZitadelKeySecretStore(coreApi)));
    // Idempotent reconcile/backfill (S3d): re-provision ClusterTenants whose Zitadel org is
    // missing/partial (created before Zitadel was configured, or a half-failed provision) and
    // heal the drift. Superadmin-gated; sibling of the SA-key router on the same live client.
    app.use("/api/v1/admin/zitadel", zitadelReconcileRouter(prisma, zitadelClient));
  }
  app.use("/api/v1/awareness/rollout", awarenessRolloutRouter(prisma));
  app.use("/api/v1/awareness/participation", awarenessParticipationRouter(prisma));
  app.use("/api/v1/sessions", sessionsRouter(prisma));
  app.use("/api/v1/access-tokens", accessTokensRouter(prisma));
  app.use("/api/v1/providers/keys", providerKeysRouter(prisma));
  app.use("/api/v1/providers/credentials", providerCredentialsRouter(prisma));
  app.use("/api/v1/models", modelRegistryRouter(prisma));
  app.use("/api/v1/openapi.json", openapiRouter());
  app.get("/healthz", _CheckDbHealth(prisma));
  app.use("/prom", prometheusMetricsRouter(prisma, customApi));
  return app;
}
