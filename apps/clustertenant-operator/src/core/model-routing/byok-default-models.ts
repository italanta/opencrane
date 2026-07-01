/**
 * Per-provider model catalog seeded when a provider's BYOK key is set.
 *
 * Hierarchy — one provider ⇒ one key ⇒ many models: setting a provider's key writes ONE k8s Secret
 * and ONE LiteLLM `/credentials` entry, then registers every class below bound to that single
 * credential. So all of a provider's model classes authenticate with the same key, and LiteLLM can
 * switch freely across tiers on it (the routing layer picks; the {@link ByokProviderCatalog.defaultClass}
 * model only claims the silo default when no default exists yet).
 *
 * Slugs are current production LiteLLM ids verified 2026-07-01 — tune here as providers ship models.
 * `litellmProvider` is LiteLLM's `custom_llm_provider` (and slug prefix); it equals the BYOK provider
 * key EXCEPT GLM, which is `zai` in LiteLLM (the `zhipu/` prefix is rejected). A registration with an
 * unknown slug simply fails to route until corrected — it never affects the stored key.
 *
 * Notes: DeepSeek's current V4 family is Pro + Flash only (two classes, not three). Gemini's flagship
 * may require the `-preview` suffix on some LiteLLM builds (`gemini/gemini-3.1-pro-preview`) — the
 * best-effort registration isolates a 404 to that one model.
 */

/** Capability/cost tier a catalogued model occupies. */
export type ByokModelClassName = "flagship" | "balanced" | "fast";

/** One model class within a provider's catalog. */
export interface ByokModelClass
{
  /** The tier this model occupies. */
  className: ByokModelClassName;
  /** LiteLLM `litellm_params.model` slug (provider-prefixed); also used as the public model name. */
  slug: string;
}

/** A provider's model catalog: one credential (key) shared across several model classes. */
export interface ByokProviderCatalog
{
  /** LiteLLM `custom_llm_provider` for the credential + slug prefix (`glm` ⇒ `zai`). */
  litellmProvider: string;
  /** The class whose model claims the silo default when no Global default exists yet. */
  defaultClass: ByokModelClassName;
  /** Model classes for this provider (≥1); ALL share the provider's single credential/key. */
  models: readonly ByokModelClass[];
}

/** BYOK provider key → its model catalog. Absent providers set a key but seed no model. */
export const _BYOK_PROVIDER_CATALOG: Readonly<Record<string, ByokProviderCatalog>> = {
  openai: {
    litellmProvider: "openai",
    defaultClass: "flagship",
    models: [
      { className: "flagship", slug: "openai/gpt-5.5" },
      { className: "balanced", slug: "openai/gpt-5.4" },
      { className: "fast", slug: "openai/gpt-5.4-nano" },
    ],
  },
  anthropic: {
    litellmProvider: "anthropic",
    defaultClass: "flagship",
    models: [
      { className: "flagship", slug: "anthropic/claude-opus-4-8" },
      { className: "balanced", slug: "anthropic/claude-sonnet-5" },
      { className: "fast", slug: "anthropic/claude-haiku-4-5" },
    ],
  },
  gemini: {
    litellmProvider: "gemini",
    defaultClass: "flagship",
    models: [
      { className: "flagship", slug: "gemini/gemini-3.1-pro" },
      { className: "balanced", slug: "gemini/gemini-3.5-flash" },
      { className: "fast", slug: "gemini/gemini-3.1-flash-lite" },
    ],
  },
  mistral: {
    litellmProvider: "mistral",
    defaultClass: "flagship",
    models: [
      { className: "flagship", slug: "mistral/mistral-large-latest" },
      { className: "balanced", slug: "mistral/mistral-medium-latest" },
      { className: "fast", slug: "mistral/mistral-small-latest" },
    ],
  },
  deepseek: {
    litellmProvider: "deepseek",
    defaultClass: "flagship",
    // DeepSeek's current V4 family is Pro + Flash only — two classes.
    models: [
      { className: "flagship", slug: "deepseek/deepseek-v4-pro" },
      { className: "fast", slug: "deepseek/deepseek-v4-flash" },
    ],
  },
  glm: {
    // GLM (Zhipu) is `zai` in LiteLLM — `zhipu/` is rejected ("LLM Provider NOT provided").
    litellmProvider: "zai",
    defaultClass: "flagship",
    models: [
      { className: "flagship", slug: "zai/glm-4.7" },
      { className: "balanced", slug: "zai/glm-4.6" },
      { className: "fast", slug: "zai/glm-4.5-flash" },
    ],
  },
};
