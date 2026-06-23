/** One entry in the LiteLLM model_prices_and_context_window.json. */
export interface LiteLlmCostMapEntry
{
  litellm_provider?: string;
  mode?: string;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  [key: string]: unknown;
}

/** The full LiteLLM cost map — an object keyed by model name (e.g. "gpt-4o"). */
export type LiteLlmCostMap = Record<string, LiteLlmCostMapEntry>;

/** One model entry from the models.dev api.json. */
export interface ModelsDevModel
{
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  /** Per-million-token costs (models.dev convention). */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  release_date?: string;
  knowledge?: string;
  open_weights?: boolean;
}

/**
 * models.dev api.json shape.
 * Top-level keys are provider names ("openai", "anthropic", …).
 * Each provider has a `models` record keyed by model id.
 */
export type ModelsDevApiJson = Record<string, { models?: Record<string, ModelsDevModel>; [k: string]: unknown }>;

/** Stats returned from a single catalog-reconcile run. */
export interface CatalogReconcileRunResult
{
  added: number;
  updated: number;
  deprecated: number;
  pricingChanges: number;
  total: number;
  durationMs: number;
}
