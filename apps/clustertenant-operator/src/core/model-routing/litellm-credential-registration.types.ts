/**
 * Inputs for a best-effort LiteLLM `/credentials` upsert — the BYOK "dynamic no-restart path".
 *
 * Unlike {@link LiteLlmModelRegistration} (which references a key via `os.environ/<ref>` — the
 * env baseline), a credential carries the RAW provider key inline. LiteLLM persists it in its
 * own DB-backed store encrypted with `LITELLM_SALT_KEY`, so a model that references the credential
 * by name picks up the key with no pod restart and the key never lands in OpenClaw's config.
 */
export interface LiteLlmCredentialUpsert
{
  /** The credential name models reference via `litellm_params.litellm_credential_name`. */
  credentialName: string;
  /** The LiteLLM provider this key authenticates, e.g. `openai`, `anthropic`, `gemini`. */
  provider: string;
  /** The raw upstream provider API key. Never logged, never returned to a caller. */
  apiKey: string;
}
