import type { PrismaClient } from "@prisma/client";
import { _log } from "../../log.js";
import type {
  CatalogReconcileRunResult,
  LiteLlmCostMap,
  LiteLlmCostMapEntry,
  ModelsDevApiJson,
  ModelsDevModel,
} from "./catalog-reconcile.types.js";

const LITELLM_COST_MAP_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30_000;

/** Fetch JSON from `url`; returns null on any error (network, timeout, non-2xx). */
async function _fetchJson<T>(url: string, label: string): Promise<T | null>
{
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try
  {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok)
    {
      _log.warn({ url, status: res.status }, `catalog-reconcile: ${label} fetch failed`);
      return null;
    }
    return (await res.json()) as T;
  }
  catch (err)
  {
    _log.warn({ url, err }, `catalog-reconcile: ${label} fetch error`);
    return null;
  }
  finally
  {
    clearTimeout(timer);
  }
}

/**
 * Build a lookup from models.dev entry identifiers → enrichment payload.
 *
 * Indexes each model under two keys so the join succeeds for both the
 * "provider/model-id" form (e.g. "openai/gpt-4o") and the bare model-id
 * form (e.g. "gpt-4o") that LiteLLM uses as its canonical key.
 * Full-id entries are written first so they take priority on exact match.
 */
function _buildModelsDevIndex(
  data: ModelsDevApiJson,
): Map<string, ModelsDevModel & { modelsDevId: string }>
{
  const index = new Map<string, ModelsDevModel & { modelsDevId: string }>();
  for (const [provider, providerData] of Object.entries(data))
  {
    for (const [modelId, model] of Object.entries(providerData.models ?? {}))
    {
      const fullId = `${provider}/${modelId}`;
      const entry = { ...model, modelsDevId: fullId };
      if (!index.has(fullId)) index.set(fullId, entry);
      if (!index.has(modelId)) index.set(modelId, entry);
    }
  }
  return index;
}

/** True when `next` differs from `prev` (both null counts as no change). */
function _rateChanged(
  prev: { toString(): string } | null | undefined,
  next: number | null | undefined,
): boolean
{
  const p = prev != null ? prev.toString() : null;
  const n = next != null ? String(next) : null;
  return p !== n;
}

/** Convert a per-million-token cost (models.dev convention) to per-token. */
function _perToken(perMillion: number | null | undefined): number | null
{
  return perMillion != null ? perMillion / 1_000_000 : null;
}

/**
 * Reconcile the model catalog from the LiteLLM cost map + models.dev.
 *
 * Design (see model-registry-discovery-design.md):
 * - LiteLLM map = spine: every key becomes/updates a ModelCatalogEntry; its
 *   rates are the BILLABLE pricing, re-read each run.
 * - models.dev = enrichment: modalities, capability flags, display-only cache
 *   pricing, release / knowledge dates — joined onto the LiteLLM key.
 * - Pricing changes stamp `pricingUpdatedAt` and write an AuditEntry.
 * - Keys that vanish from the LiteLLM map are soft-deprecated (`deprecatedAt`).
 *
 * Called from POST /api/internal/catalog-reconcile (triggered by a
 * Kubernetes CronJob; also callable manually by operators).
 */
export async function _ReconcileCatalog(prisma: PrismaClient): Promise<CatalogReconcileRunResult>
{
  const startedAt = Date.now();
  const runTs = new Date(startedAt);

  // 1. Fetch both sources in parallel; models.dev is best-effort.
  const [litellmMap, modelsDevData] = await Promise.all([
    _fetchJson<LiteLlmCostMap>(LITELLM_COST_MAP_URL, "LiteLLM cost map"),
    _fetchJson<ModelsDevApiJson>(MODELS_DEV_URL, "models.dev"),
  ]);

  if (!litellmMap)
  {
    throw new Error("catalog-reconcile: LiteLLM cost map unavailable — aborting");
  }

  const modelsDevIndex = modelsDevData
    ? _buildModelsDevIndex(modelsDevData)
    : new Map<string, ModelsDevModel & { modelsDevId: string }>();

  if (!modelsDevData)
  {
    _log.warn("catalog-reconcile: models.dev unavailable — enrichment skipped this run");
  }

  // 2. Load all existing entries for diff comparison (pricing change detection).
  const existing = await prisma.modelCatalogEntry.findMany();
  const existingByKey = new Map(existing.map(e => [e.litellmKey, e]));

  let added = 0, updated = 0, deprecated = 0, pricingChanges = 0;
  const seenKeys = new Set<string>();

  // 3. Upsert one entry per LiteLLM map key.
  for (const [litellmKey, rawEntry] of Object.entries(litellmMap))
  {
    // "sample_spec" is a schema-documentation entry that ships inside the map.
    if (litellmKey === "sample_spec") continue;
    if (typeof rawEntry !== "object" || !rawEntry) continue;

    const entry = rawEntry as LiteLlmCostMapEntry;
    seenKeys.add(litellmKey);

    const provider = entry.litellm_provider
      ?? (litellmKey.includes("/") ? litellmKey.split("/")[0] : "unknown")
      ?? "unknown";
    const mode = entry.mode ?? null;
    const inputCost = entry.input_cost_per_token ?? null;
    const outputCost = entry.output_cost_per_token ?? null;
    const maxIn = entry.max_input_tokens ?? entry.max_tokens ?? null;
    const maxOut = entry.max_output_tokens ?? null;

    const enrichment = modelsDevIndex.get(litellmKey) ?? null;
    const capabilities = enrichment
      ? {
          tool_call: enrichment.tool_call ?? null,
          reasoning: enrichment.reasoning ?? null,
          attachment: enrichment.attachment ?? null,
          structured_output: enrichment.structured_output ?? null,
        }
      : null;

    const prev = existingByKey.get(litellmKey);
    const isPriceChanged =
      prev != null &&
      (_rateChanged(prev.inputCostPerToken, inputCost) ||
        _rateChanged(prev.outputCostPerToken, outputCost));

    const sharedData = {
      provider,
      mode,
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
      maxInputTokens: maxIn,
      maxOutputTokens: maxOut,
      modelsDevId: enrichment?.modelsDevId ?? null,
      modalitiesIn: enrichment?.modalities?.input ?? [],
      modalitiesOut: enrichment?.modalities?.output ?? [],
      capabilities,
      cacheReadCost: _perToken(enrichment?.cost?.cache_read),
      cacheWriteCost: _perToken(enrichment?.cost?.cache_write),
      releaseDate: enrichment?.release_date ?? null,
      knowledgeCutoff: enrichment?.knowledge ?? null,
      openWeights: enrichment?.open_weights ?? null,
      lastSeenAt: runTs,
      deprecatedAt: null,
      ...(isPriceChanged ? { pricingUpdatedAt: runTs } : {}),
    };

    if (!prev)
    {
      await prisma.modelCatalogEntry.create({
        data: { litellmKey, firstSeenAt: runTs, ...sharedData },
      });
      added++;
    }
    else
    {
      await prisma.modelCatalogEntry.update({ where: { litellmKey }, data: sharedData });
      updated++;
    }

    if (isPriceChanged)
    {
      pricingChanges++;
      await prisma.auditEntry.create({
        data: {
          action: "catalog.pricing.changed",
          resource: `model_catalog_entries/${litellmKey}`,
          message: `Billable pricing updated for ${litellmKey}`,
          metadata: {
            litellmKey,
            prev: {
              input: prev!.inputCostPerToken?.toString() ?? null,
              output: prev!.outputCostPerToken?.toString() ?? null,
            },
            next: { input: inputCost, output: outputCost },
          },
        },
      });
    }
  }

  // 4. Soft-deprecate entries whose key has vanished from the LiteLLM map.
  const toDeprecate = existing.filter(e => !seenKeys.has(e.litellmKey) && !e.deprecatedAt);
  if (toDeprecate.length > 0)
  {
    await prisma.modelCatalogEntry.updateMany({
      where: { litellmKey: { in: toDeprecate.map(e => e.litellmKey) } },
      data: { deprecatedAt: runTs },
    });
    deprecated = toDeprecate.length;
  }

  const result: CatalogReconcileRunResult = {
    added,
    updated,
    deprecated,
    pricingChanges,
    total: seenKeys.size,
    durationMs: Date.now() - startedAt,
  };
  _log.info(result, "catalog-reconcile: run complete");
  return result;
}
