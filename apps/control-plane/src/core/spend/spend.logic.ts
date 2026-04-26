import type { PrismaClient } from "@prisma/client";

import type { UserLLMSpent } from "./spend.interface.js";

/**
 * Shared logic for resolving tenant spend from LiteLLM with local fallback.
 */
export class SpendLogic
{
  /** Prisma ORM client used for tenant and fallback budget/usage lookups. */
  private prisma: PrismaClient;

  /**
   * Create a spend-logic instance with a bound Prisma client.
   */
  constructor(prisma: PrismaClient)
  {
    this.prisma = prisma;
  }

  /**
   * Returns normalized spend data for a tenant from LiteLLM.
   */
  async getTenantSpend(tenantName: string): Promise<UserLLMSpent>
  {
    const endpoint = process.env.LITELLM_ENDPOINT ?? "http://litellm:4000";
    const masterKey = process.env.LITELLM_MASTER_KEY ?? "";
    const pathTemplate = process.env.LITELLM_SPEND_PATH_TEMPLATE ?? "/spend/tenant/{tenant}";

    if (!masterKey)
    {
      throw new Error("LITELLM_MASTER_KEY is not configured");
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { name: tenantName } });
    if (!tenant)
    {
      throw new Error("TENANT_NOT_FOUND");
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
      throw new Error(`LiteLLM spend request failed (${response.status}): ${await response.text()}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const totalCostUsd       = _pickNumber(payload, ["total_cost", "totalCost", "cost", "spend"], 0) ?? 0;
    const monthlyBudgetUsd   = _pickNumber(payload, ["max_budget", "monthly_budget", "budget"], null);
    const remainingBudgetUsd = monthlyBudgetUsd !== null ? Math.max(0, monthlyBudgetUsd - totalCostUsd) : null;
    const topModels          = _extractTopModels(payload);

    return {
      tenantName,
      endpoint,
      totalCostUsd,
      remainingBudgetUsd,
      monthlyBudgetUsd,
      topModels,
      raw: payload,
    };
  }
}

/** Pick the first numeric property found from a list of candidate keys. */
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

/** Extract a normalized top-model spend list from common LiteLLM response shapes. */
function _extractTopModels(payload: Record<string, unknown>): UserLLMSpent["topModels"]
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
