/**
 * Starter default model per BYOK provider — the model auto-seeded (best-effort) when a provider's
 * key is first set, so the silo has a working routable model + default without a separate
 * model-registry call. The first provider configured becomes the silo's default model.
 *
 * These are sensible flagship defaults expressed as LiteLLM `provider/model` slugs; they are the
 * single place to tune which model a freshly-set key lights up. Adjust per the models the silo's
 * LiteLLM actually serves — an unknown slug simply fails to route until corrected, it does not
 * affect the key itself (the key is persisted independently of this seed).
 *
 * A provider absent from this map sets its key but seeds no model (the admin registers one via the
 * model-registry instead).
 */
export const _BYOK_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: "openai/gpt-4o",
  anthropic: "anthropic/claude-sonnet-4-5",
  gemini: "gemini/gemini-2.5-pro",
  mistral: "mistral/mistral-large-latest",
  deepseek: "deepseek/deepseek-chat",
  glm: "openai/glm-4.6",
};
