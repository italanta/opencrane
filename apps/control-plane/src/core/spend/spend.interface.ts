/** Per-model spent and request metrics of a specific tenant */
export interface ModelSpent
{
  /** Model identifier reported by the upstream provider. */
  model: string;

  /** Spend in USD attributed to this model. */
  costUsd: number;

  /** Request count attributed to this model. */
  requests: number;
}

/**
 * LLM spent of a specific user/tenant over a defined period, with breakdowns and budget info.
 */
export interface UserLLMSpent
{
  /** Tenant name the spend summary belongs to. */
  tenantName: string;

  /** Upstream endpoint used for spend data collection. */
  endpoint: string;

  /** Total spend in USD for the requested period. */
  totalCostUsd: number;

  /** Remaining budget in USD, or `null` when no budget is configured. */
  remainingBudgetUsd: number | null;

  /** Configured monthly budget in USD, or `null` when not configured. */
  monthlyBudgetUsd: number | null;

  /** Model-level spend breakdown sorted by highest cost first. */
  topModels: Array<ModelSpent>;

  /** Raw upstream or fallback payload for debugging and diagnostics. */
  raw: unknown;
}
