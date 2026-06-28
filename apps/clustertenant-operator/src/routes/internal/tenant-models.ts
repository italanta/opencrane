import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { TenantModelSet } from "@opencrane/contracts";

/**
 * Resolve the effective default model for a tenant from the routing-default
 * precedence chain, falling back to the `isDefault` model in the allowed set.
 *
 * Precedence (highest first): the ClusterTenant-scoped `ModelRoutingDefault`
 * for the tenant's ClusterTenant, then the Global `ModelRoutingDefault`, then
 * the `publicModelName` of any allowed `ModelDefinition` flagged `isDefault`,
 * then null. A row may exist with a null `defaultModel`; that is not a usable
 * default, so the chain treats it as absent and continues to the next source.
 *
 * @param ctDefault    - ClusterTenant-scoped routing default's model, or null.
 * @param globalDefault - Global routing default's model, or null.
 * @param fallbackModel - publicModelName of an `isDefault` allowed model, or null.
 * @returns The resolved default model name, or null when nothing resolves.
 */
function _resolveDefaultModel(ctDefault: string | null, globalDefault: string | null, fallbackModel: string | null): string | null
{
  // 1. ClusterTenant default wins when present — it is the most specific scope.
  if (ctDefault)
  {
    return ctDefault;
  }

  // 2. Global default is the platform-wide fallback when no CT default exists.
  if (globalDefault)
  {
    return globalDefault;
  }

  // 3. An `isDefault` model in the allowed set is the last positive signal
  //    before giving up; the operator falls back to its own default on null.
  return fallbackModel;
}

/**
 * Internal router that exposes a tenant's allowed model set and effective
 * default model so the operator can scope the tenant's routing at reconcile.
 *
 * **This router is NOT behind `___AuthMiddleware`** and does not run a
 * TokenReview. Access is enforced purely at the network layer: only platform
 * pods (the operator among them) can reach the control-plane service under the
 * cluster NetworkPolicy. It mounts alongside `/api/internal/bundles`, which
 * shares that NetworkPolicy-only posture.
 *
 * The endpoint is best-effort: an unknown tenant or a tenant with no
 * ClusterTenant still returns the Global allowlist and Global default rather
 * than a 404/500, because the operator calls it on a reconcile hot path and
 * must always get a usable answer.
 *
 * @see apps/clustertenant-platform/templates/networkpolicy-planes.yaml — NetworkPolicy that
 *   governs which pods may reach this endpoint.
 *
 * @param prisma - Prisma client for database access.
 */
export function _RegisterInternalTenantModels(prisma: PrismaClient): Router
{
  const router = Router();

  /**
   * Return the allowed model set and effective default for `:tenant`.
   *
   * Route parameters:
   *   - `:tenant` — the tenant name whose model allowlist should be returned.
   */
  router.get("/:tenant", async function _getTenantModels(req, res, next)
  {
    try
    {
      const { tenant } = req.params;

      // 1. Resolve the tenant to its ClusterTenant ref. A missing tenant is not
      //    an error here: best-effort means we degrade to the Global-only set so
      //    the operator's reconcile loop always receives a usable allowlist.
      const tenantRow = await prisma.tenant.findUnique({
        where: { name: tenant },
        select: { clusterTenantRef: true },
      });
      const clusterTenantRef = tenantRow?.clusterTenantRef ?? null;

      // 2. Fetch every ModelDefinition the tenant may use: all Global models,
      //    plus ClusterTenant-scoped models bound to this tenant's ClusterTenant.
      //    The CT clause is added only when a ref exists so the OR never matches
      //    rows with a null `clusterTenant`.
      const scopeFilter = clusterTenantRef
        ? [{ scope: "Global" as const }, { scope: "ClusterTenant" as const, clusterTenant: clusterTenantRef }]
        : [{ scope: "Global" as const }];

      const definitions = await prisma.modelDefinition.findMany({
        where: { OR: scopeFilter },
        select: { publicModelName: true, isDefault: true },
      });

      // 3. De-duplicate the public model names; the same name can appear at both
      //    Global and ClusterTenant scope (BYOM override), and the allowlist must
      //    list each model once.
      const models = Array.from(new Set(definitions.map(function _name(d) { return d.publicModelName; })));

      // 4. Read the routing defaults at both relevant scopes in parallel. The CT
      //    lookup is skipped (resolves to null) when the tenant has no ref so we
      //    never issue a query that cannot match. Prisma's compound-unique
      //    selector cannot express a null clusterTenant, so use findFirst on the
      //    pair (matches resolve-contract-skill-models.ts).
      const [ctDefaultRow, globalDefaultRow] = await Promise.all([
        clusterTenantRef
          ? prisma.modelRoutingDefault.findFirst({
              where: { scope: "ClusterTenant", clusterTenant: clusterTenantRef },
              select: { defaultModel: true },
            })
          : Promise.resolve(null),
        prisma.modelRoutingDefault.findFirst({
          where: { scope: "Global", clusterTenant: null },
          select: { defaultModel: true },
        }),
      ]);

      // 5. Pick the `isDefault` model from the allowed set as the final fallback,
      //    constraining it to `models` so we never surface a default the tenant
      //    is not entitled to use.
      const allowed = new Set(models);
      const isDefaultModel = definitions.find(function _flagged(d) { return d.isDefault && allowed.has(d.publicModelName); })?.publicModelName ?? null;

      // 6. Resolve the effective default across the precedence chain and return.
      const defaultModel = _resolveDefaultModel(
        ctDefaultRow?.defaultModel ?? null,
        globalDefaultRow?.defaultModel ?? null,
        isDefaultModel,
      );

      const response: TenantModelSet = { models, defaultModel };
      res.json(response);
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
