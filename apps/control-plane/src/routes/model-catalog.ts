import { Router } from "express";
import type { PrismaClient, ModelCatalogEntry as PrismaModelCatalogEntry } from "@prisma/client";
import type { ModelCatalogEntry } from "@opencrane/contracts";
import { _ReconcileCatalog } from "../core/model-routing/catalog-reconcile.js";
import { _log } from "../log.js";

/**
 * Project a persisted ModelCatalogEntry row into its contract DTO.
 * Decimal fields are serialised as strings (Prisma's Decimal.toString()).
 */
function _toContract(row: PrismaModelCatalogEntry): ModelCatalogEntry
{
  return {
    id: row.id,
    litellmKey: row.litellmKey,
    provider: row.provider,
    mode: row.mode,
    inputCostPerToken: row.inputCostPerToken?.toString() ?? null,
    outputCostPerToken: row.outputCostPerToken?.toString() ?? null,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    modelsDevId: row.modelsDevId,
    modalitiesIn: row.modalitiesIn,
    modalitiesOut: row.modalitiesOut,
    capabilities: row.capabilities as Record<string, boolean | null> | null,
    cacheReadCost: row.cacheReadCost?.toString() ?? null,
    cacheWriteCost: row.cacheWriteCost?.toString() ?? null,
    releaseDate: row.releaseDate,
    knowledgeCutoff: row.knowledgeCutoff,
    openWeights: row.openWeights,
    hostingRegions: row.hostingRegions,
    pricingUpdatedAt: row.pricingUpdatedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    deprecatedAt: row.deprecatedAt?.toISOString() ?? null,
  };
}

/**
 * Public (authenticated) router for browsing the model catalog.
 *
 * GET /api/v1/model-catalog         — list entries (filter: provider, deprecated)
 * GET /api/v1/model-catalog/:id     — get one entry by id
 *
 * @param prisma - Prisma client.
 */
export function modelCatalogRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /**
   * List catalog entries.
   * Query params:
   *   provider     — filter by provider string (exact match)
   *   deprecated   — "true" to include deprecated entries (default: exclude)
   *   mode         — filter by mode ("chat", "embedding", …)
   */
  router.get("/", async function _listCatalog(req, res)
  {
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const includeDeprecated = req.query.deprecated === "true";

    const rows = await prisma.modelCatalogEntry.findMany({
      where: {
        ...(provider ? { provider } : {}),
        ...(mode ? { mode } : {}),
        ...(!includeDeprecated ? { deprecatedAt: null } : {}),
      },
      orderBy: [{ provider: "asc" }, { litellmKey: "asc" }],
    });
    res.json(rows.map(_toContract));
  });

  /** Get a single catalog entry by id. */
  router.get("/:id", async function _getCatalogEntry(req, res)
  {
    const row = await prisma.modelCatalogEntry.findUnique({ where: { id: req.params.id } });
    if (!row)
    {
      res.status(404).json({ error: "Catalog entry not found", code: "CATALOG_ENTRY_NOT_FOUND" });
      return;
    }
    res.json(_toContract(row));
  });

  return router;
}

/**
 * Internal (network-policy-guarded) router for catalog management.
 * Mounted at /api/internal/catalog-reconcile — no auth middleware.
 * Access is enforced by the Kubernetes NetworkPolicy that restricts
 * this path to the catalog-reconcile CronJob pod only.
 *
 * POST /api/internal/catalog-reconcile — trigger a reconcile run.
 *
 * @param prisma - Prisma client.
 */
export function internalCatalogRouter(prisma: PrismaClient): Router
{
  const router = Router();

  router.post("/", async function _triggerReconcile(req, res)
  {
    _log.info("catalog-reconcile: triggered via internal endpoint");
    try
    {
      const result = await _ReconcileCatalog(prisma);
      res.json(result);
    }
    catch (err)
    {
      _log.error({ err }, "catalog-reconcile: run failed");
      res.status(500).json({
        error: "Catalog reconcile failed",
        code: "CATALOG_RECONCILE_FAILED",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
