/**
 * Contract types for the model catalog (discovery layer).
 *
 * A ModelCatalogEntry represents a model that *exists* (available for
 * enablement), NOT one that is callable.  Distinct from ModelDefinition
 * (a registered LiteLLM deployment).  Populated by the catalog-reconcile
 * cron; never directly callable.
 *
 * Canonical identity: the LiteLLM cost-map key (`litellmKey`).
 * Billing rates: from the LiteLLM map (re-read every reconcile, audited on change).
 * Enrichment: modalities + capability flags from models.dev, joined on litellmKey.
 */

/** A discovered catalog entry — available but not yet enabled. */
export interface ModelCatalogEntry
{
  /** Stable surrogate key. */
  id: string;
  /** Canonical identity = LiteLLM cost-map key (e.g. "gpt-4o", "claude-3-5-sonnet-20241022"). */
  litellmKey: string;
  /** LiteLLM provider string (e.g. "openai", "anthropic", "vertex_ai"). */
  provider: string;
  /** Inference mode: "chat" | "embedding" | "rerank" | null when unclassified. */
  mode: string | null;

  // Billable pricing — from the LiteLLM map, re-read every reconcile.
  /** Input cost per token in USD (billing spine from LiteLLM map). */
  inputCostPerToken: string | null;
  /** Output cost per token in USD (billing spine from LiteLLM map). */
  outputCostPerToken: string | null;
  /** Maximum input context tokens. */
  maxInputTokens: number | null;
  /** Maximum output tokens. */
  maxOutputTokens: number | null;

  // Enrichment — from models.dev, joined on litellmKey; null when unmatched.
  /** models.dev model id (e.g. "openai/gpt-4o"); null when unmatched. */
  modelsDevId: string | null;
  /** Input modalities, e.g. ["text", "image"]. */
  modalitiesIn: string[];
  /** Output modalities, e.g. ["text"]. */
  modalitiesOut: string[];
  /** Capability flags: { tool_call, reasoning, attachment, structured_output }; null when unmatched. */
  capabilities: Record<string, boolean | null> | null;
  /** Cache-read cost per token (from models.dev, display-only). */
  cacheReadCost: string | null;
  /** Cache-write cost per token (from models.dev, display-only). */
  cacheWriteCost: string | null;
  /** Model release date string (e.g. "2024-10-22"); null when unknown. */
  releaseDate: string | null;
  /** Training knowledge cutoff date string; null when unknown. */
  knowledgeCutoff: string | null;
  /** Whether the model weights are public/open; null when unknown. */
  openWeights: boolean | null;

  // Data residency.
  /**
   * Provider hosting regions, e.g. ["eu-west", "eu-central"].
   * Empty array = unknown / not yet classified.
   */
  hostingRegions: string[];

  // Lifecycle.
  /** When billable rates last changed; null until first change after discovery. */
  pricingUpdatedAt: string | null;
  /** When this entry was first discovered (ISO-8601). */
  firstSeenAt: string;
  /** When the entry was last seen in the LiteLLM map (ISO-8601). */
  lastSeenAt: string;
  /** Set when the key dropped out of the LiteLLM map (soft-delete); null while active. */
  deprecatedAt: string | null;
}

/** Stats returned from a single catalog-reconcile run. */
export interface CatalogReconcileResult
{
  /** Number of new entries added. */
  added: number;
  /** Number of existing entries whose metadata was updated. */
  updated: number;
  /** Number of entries soft-deprecated (dropped out of the LiteLLM map). */
  deprecated: number;
  /** Number of pricing-change audit entries written. */
  pricingChanges: number;
  /** Total LiteLLM map keys processed (= added + updated). */
  total: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}
