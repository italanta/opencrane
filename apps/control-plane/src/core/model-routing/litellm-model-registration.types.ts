import type { ModelRoutingScope } from "@opencrane/contracts";

/**
 * Inputs for a best-effort LiteLLM `POST /model/new` GLOBAL registration. The raw provider
 * key is never passed — only an `os.environ/<KEY>` reference name, resolved by LiteLLM itself.
 */
export interface LiteLlmModelRegistration
{
  /** The routable public slug callers request, e.g. `openai/gpt-4o`. */
  publicModelName: string;
  /** The upstream model the deployment targets, e.g. `openai/gpt-4o`. */
  upstreamModel: string;
  /** The scope the model is owned at; folded into the deterministic placeholder id for uniqueness. */
  scope: ModelRoutingScope;
  /** Owning ClusterTenant when scope is `clusterTenant`; null/undefined for Global. */
  clusterTenant?: string | null;
  /** Optional non-default API base for self-hosted / proxied endpoints. */
  apiBase?: string | null;
  /** Optional environment variable name LiteLLM reads the provider key from (`os.environ/<ref>`). */
  apiKeyEnvRef?: string | null;
}
