/** Per-model spend breakdown entry returned by tenant spend endpoints. */
export interface TenantSpendModel
{
  /** Model identifier from the upstream usage payload. */
  model: string;

  /** USD spend attributed to this model. */
  costUsd: number;

  /** Number of requests attributed to this model. */
  requests: number;
}

/** Tenant-level spend and budget summary for the dashboard. */
export interface TenantSpendSummary
{
  /** Tenant name used for lookup. */
  tenantName: string;

  /** Total spend in USD for the current budget period. */
  totalCostUsd: number;

  /** Configured monthly budget in USD, or null when not configured. */
  monthlyBudgetUsd: number | null;

  /** Remaining budget in USD, or null when no budget exists. */
  remainingBudgetUsd: number | null;

  /** Top model usage contributors ordered by spend. */
  topModels: TenantSpendModel[];
}