/**
 * A single declarative model-registry seed entry, decoded from the `MODEL_REGISTRY_SEED`
 * JSON array. Each entry registers ONE Global {@link import("@opencrane/contracts").ModelDefinition}
 * idempotently on control-plane startup. Supports user-defined models + custom endpoints: any
 * `apiKeyEnvRef` and any `apiBase` are accepted so operators can point at their own provider.
 */
export interface ModelSeedEntry
{
  /** The routable public slug callers request, e.g. `anthropic/claude-sonnet-4-6`. */
  publicModelName: string;
  /** The upstream model the LiteLLM deployment targets, e.g. `anthropic/claude-sonnet-4-6`. */
  upstreamModel: string;
  /** Env var name LiteLLM reads the provider key from — becomes `os.environ/<apiKeyEnvRef>`. */
  apiKeyEnvRef: string;
  /** Optional non-default API base for OSS / self-hosted / proxied endpoints. */
  apiBase?: string | null;
  /** When true, also marks this slug as the Global `ModelRoutingDefault.defaultModel`. */
  isDefault?: boolean;
}
