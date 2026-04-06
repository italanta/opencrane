import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

/**
 * Shape of the normalized spend response returned by the control-plane API.
 */
interface SpendResponse
{
  tenantName: string;
  endpoint: string;
  totalCostUsd: number;
  remainingBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  topModels: Array<{
    model: string;
    costUsd: number;
    requests: number;
  }>;
  raw: unknown;
}

/**
 * Creates a router for querying tenant spend from LiteLLM.
 *
 * Endpoint behavior is configurable through environment variables so we can
 * adapt to LiteLLM API shape changes without code changes:
 * - LITELLM_ENDPOINT (default: http://litellm:4000)
 * - LITELLM_MASTER_KEY (required)
 * - LITELLM_SPEND_PATH_TEMPLATE (default: /spend/tenant/{tenant})
 */
export function spendRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /**
   * Returns a tenant spend summary sourced from LiteLLM usage APIs.
   */
  router.get("/:tenantName", async function _getTenantSpend(req, res)
  {
    const tenantName = req.params.tenantName;
    const endpoint = process.env.LITELLM_ENDPOINT ?? "http://litellm:4000";
    const masterKey = process.env.LITELLM_MASTER_KEY ?? "";
    const pathTemplate = process.env.LITELLM_SPEND_PATH_TEMPLATE ?? "/spend/tenant/{tenant}";

    if (!masterKey)
    {
      res.status(503).json({ error: "LITELLM_MASTER_KEY is not configured" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { name: tenantName } });
    if (!tenant)
    {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const requestPath = pathTemplate.replace("{tenant}", encodeURIComponent(tenantName));
    const requestUrl = `${endpoint}${requestPath}`;

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
    });

    if (!response.ok)
    {
      const body = await response.text();
      res.status(502).json({ error: `LiteLLM spend request failed (${response.status})`, details: body });
      return;
    }

    const payload = await response.json() as Record<string, unknown>;
    const totalCostUsd = _pickNumber(payload, ["total_cost", "totalCost", "cost", "spend"], 0) ?? 0;
    const monthlyBudgetUsd = _pickNumber(payload, ["max_budget", "monthly_budget", "budget"], null);
    const remainingBudgetUsd = monthlyBudgetUsd !== null ? Math.max(0, monthlyBudgetUsd - totalCostUsd) : null;
    const topModels = _extractTopModels(payload);

    const result: SpendResponse = {
      tenantName,
      endpoint,
      totalCostUsd,
      remainingBudgetUsd,
      monthlyBudgetUsd,
      topModels,
      raw: payload,
    };

    res.json(result);
  });

  return router;
}

/**
 * Pick the first numeric property found from a list of candidate keys.
 */
function _pickNumber(payload: Record<string, unknown>, keys: string[], fallback: number | null): number | null
{
  for (const key of keys)
  {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value))
    {
      return value;
    }
  }

  return fallback;
}

/**
 * Extract a normalized top-model spend list from common LiteLLM response shapes.
 */
function _extractTopModels(payload: Record<string, unknown>): SpendResponse["topModels"]
{
  const source = payload.top_models ?? payload.models ?? payload.model_breakdown;
  if (!Array.isArray(source))
  {
    return [];
  }

  return source.map(function _mapModel(row)
  {
    const item = row as Record<string, unknown>;
    return {
      model: String(item.model ?? item.name ?? "unknown"),
      costUsd: typeof item.cost === "number"
        ? item.cost
        : typeof item.total_cost === "number"
          ? item.total_cost
          : 0,
      requests: typeof item.requests === "number"
        ? item.requests
        : typeof item.count === "number"
          ? item.count
          : 0,
    };
  }).sort(function _sortByCost(a, b)
  {
    return b.costUsd - a.costUsd;
  });
}
