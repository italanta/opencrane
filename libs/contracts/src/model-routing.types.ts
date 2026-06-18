/**
 * Shared types for the model-routing registry (Track AIR): provider credentials and
 * model definitions. Provider keys are owned at control-plane (Global) or ClusterTenant
 * scope — never per openclaw tenant — and OpenCrane stores only a reference to the
 * External-Secrets-synced k8s Secret, never the raw key.
 */

/**
 * Scope at which a provider credential or model definition is owned.
 * Mirrors the Prisma `ModelRoutingScope` enum.
 */
export const ModelRoutingScope = {
  Global: "global",
  ClusterTenant: "clusterTenant",
} as const;

/** Union of the {@link ModelRoutingScope} values. */
export type ModelRoutingScope = (typeof ModelRoutingScope)[keyof typeof ModelRoutingScope];

/** A provider API credential reference (the raw key lives in a k8s Secret, not here). */
export interface ProviderCredential
{
  /** Stable identifier. */
  id: string;
  /** Whether the credential is platform-wide or owned by one ClusterTenant. */
  scope: ModelRoutingScope;
  /** Owning ClusterTenant when `scope` is `clusterTenant`; null for Global. */
  clusterTenant: string | null;
  /** Free-text provider key (e.g. `openai`, `anthropic`, `bedrock`). */
  provider: string;
  /** Name of the External-Secrets-synced k8s Secret carrying the provider key. */
  secretRef: string;
  /** LiteLLM `/credentials` name when registered for the dynamic path; null for the env baseline. */
  litellmCredentialName: string | null;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
  /** Last-update timestamp (ISO-8601). */
  updatedAt: string;
}

/** Create/update body for a {@link ProviderCredential}. */
export interface ProviderCredentialWrite
{
  /** Defaults to `global` when omitted. */
  scope?: ModelRoutingScope;
  /** Required when `scope` is `clusterTenant`. */
  clusterTenant?: string;
  /** Free-text provider key. */
  provider: string;
  /** Name of the External-Secrets-synced k8s Secret carrying the provider key. */
  secretRef: string;
  /** Optional LiteLLM `/credentials` name for the dynamic no-restart path. */
  litellmCredentialName?: string;
}

/** A routable model registered in LiteLLM (BYOM). */
export interface ModelDefinition
{
  /** Stable identifier. */
  id: string;
  /** Whether the model is platform-wide or owned by one ClusterTenant. */
  scope: ModelRoutingScope;
  /** Owning ClusterTenant when `scope` is `clusterTenant`; null for Global. */
  clusterTenant: string | null;
  /** The routable public slug callers request, e.g. `openai/gpt-4o`. */
  publicModelName: string;
  /** Deployment id returned by LiteLLM `/model/new`. */
  litellmModelId: string;
  /** Upstream model the deployment targets, e.g. `openai/gpt-4o`. */
  upstreamModel: string;
  /** Optional non-default API base for self-hosted / proxied endpoints. */
  apiBase: string | null;
  /** Whether this is the default model at its scope. */
  isDefault: boolean;
  /** The provider credential backing this model, when set. */
  providerCredentialId: string | null;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
  /** Last-update timestamp (ISO-8601). */
  updatedAt: string;
}

/** Create/update body for a {@link ModelDefinition}. */
export interface ModelDefinitionWrite
{
  /** Defaults to `global` when omitted. */
  scope?: ModelRoutingScope;
  /** Required when `scope` is `clusterTenant`. */
  clusterTenant?: string;
  /** The routable public slug, e.g. `openai/gpt-4o`. */
  publicModelName: string;
  /** Upstream model the deployment targets. */
  upstreamModel: string;
  /** Optional non-default API base. */
  apiBase?: string;
  /** Whether this is the default model at its scope. */
  isDefault?: boolean;
  /** Provider credential backing this model. */
  providerCredentialId?: string;
}
