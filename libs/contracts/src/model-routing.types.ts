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

/**
 * Providers a BYOK upstream key may be set for. Unlike {@link ProviderCredential} (a reference to
 * an externally-synced Secret), a BYOK key is set with its RAW value over HTTPS, persisted to a
 * k8s Secret, and registered with LiteLLM's `/credentials` dynamic path. Add providers here as the
 * runtime gains routing support for them.
 */
export const ByokProvider = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Gemini: "gemini",
  Mistral: "mistral",
  Deepseek: "deepseek",
  Glm: "glm",
} as const;

/** Union of the {@link ByokProvider} values. */
export type ByokProvider = (typeof ByokProvider)[keyof typeof ByokProvider];

/**
 * Set/refresh body for a BYOK provider key. Carries the RAW upstream key — accepted only over
 * HTTPS, written straight to a k8s Secret and LiteLLM, and NEVER echoed back by any read endpoint.
 */
export interface ProviderKeySetRequest
{
  /** The raw upstream provider API key (e.g. `sk-...`). */
  apiKey: string;
}

/** Read-side status of a BYOK provider key. Carries no key material — presence and timestamps only. */
export interface ProviderKeyStatus
{
  /** The provider this status describes. */
  provider: ByokProvider;
  /** Whether a key is currently set for this provider in this silo. */
  configured: boolean;
  /** Whether the key was accepted by LiteLLM's `/credentials` dynamic path (false ⇒ Secret-only). */
  litellmRegistered: boolean;
  /** When the key was last set (ISO-8601); null when not configured. */
  updatedAt: string | null;
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

/**
 * A skill's model-selection posture. `pinned` uses the skill's `pinnedModel`; `auto` routes within
 * the skill's auto config; absence means the skill inherits the scope default. Mirrors Prisma `SkillModelMode`.
 */
export const SkillModelMode = {
  Pinned: "pinned",
  Auto: "auto",
} as const;

/** Union of the {@link SkillModelMode} values. */
export type SkillModelMode = (typeof SkillModelMode)[keyof typeof SkillModelMode];

/** Optimization objective for an `auto` routing decision. */
export const AutoRoutingObjective = {
  CheapestPassingBar: "cheapest-passing-bar",
  BestQualityWithinBudget: "best-quality-within-budget",
  Balanced: "balanced",
} as const;

/** Union of the {@link AutoRoutingObjective} values. */
export type AutoRoutingObjective = (typeof AutoRoutingObjective)[keyof typeof AutoRoutingObjective];

/**
 * The opt-in "auto" routing configuration surface. Stores the knobs only — the runtime optimizer
 * that consumes them (judge → OPE → propose) is a later track item (AIR.7). Auto routing applies
 * ONLY when a skill (or scope default) selects it; otherwise the explicit/pinned model is used verbatim.
 */
export interface AutoRoutingConfig
{
  /** The optimization objective. */
  objective: AutoRoutingObjective;
  /** Cost↔quality dial for the `balanced` objective: 0 = cheapest … 10 = best. */
  costQualitySlider?: number;
  /** Minimum eval score a model must clear; defaults to the skill's own bar when omitted. */
  qualityFloor?: number;
  /** Hard per-decision spend ceiling in USD. */
  maxBudgetUsd?: number;
  /** Restrict auto to this subset of `publicModelName`s; must stay within the key's allowlist. */
  allowedModels?: string[];
  /** Reject/penalize models slower than this many milliseconds. */
  latencyCeilingMs?: number;
  /** Ordered fallback `publicModelName`s on failure/unavailability. */
  fallbacks?: string[];
  /** Keep the chosen model stable within a conversation to preserve prompt caches (default true). */
  sessionPin: boolean;
  /** Fraction of traffic to explore alternatives on (0 = pure exploit). */
  explorationRate: number;
}

/** A scope-level model + auto-config default, consulted when a skill declares no posture. */
export interface ModelRoutingDefault
{
  /** Stable identifier. */
  id: string;
  /** Whether this default is platform-wide or per-ClusterTenant. */
  scope: ModelRoutingScope;
  /** Owning ClusterTenant when `scope` is `clusterTenant`; null for Global. */
  clusterTenant: string | null;
  /** Default model `publicModelName` at this scope; null when unset. */
  defaultModel: string | null;
  /** Default auto-routing config at this scope; null when unset. */
  autoConfig: AutoRoutingConfig | null;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
  /** Last-update timestamp (ISO-8601). */
  updatedAt: string;
}

/** Create/update body for a {@link ModelRoutingDefault}. */
export interface ModelRoutingDefaultWrite
{
  /** Defaults to `global` when omitted. */
  scope?: ModelRoutingScope;
  /** Required when `scope` is `clusterTenant`. */
  clusterTenant?: string;
  /** Default model `publicModelName`. */
  defaultModel?: string;
  /** Default auto-routing config. */
  autoConfig?: AutoRoutingConfig;
}

/** A golden eval case for a skill — graded against the skill's quality bar (AIR.6). */
export interface RoutingEvalCase
{
  /** Stable identifier. */
  id: string;
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team (empty for org/global). */
  skillTeam: string;
  /** The prompt/inputs for this case. */
  input: unknown;
  /** Optional golden answer or grader rubric. */
  expected: unknown;
  /** Minimum judge score (0..1) a model must clear on this case. */
  qualityBar: number;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
  /** Last-update timestamp (ISO-8601). */
  updatedAt: string;
}

/** Create/update body for a {@link RoutingEvalCase}. */
export interface RoutingEvalCaseWrite
{
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team (defaults to empty). */
  skillTeam?: string;
  /** The prompt/inputs for this case. */
  input: unknown;
  /** Optional golden answer or grader rubric. */
  expected?: unknown;
  /** Minimum judge score (0..1); defaults to 0.8. */
  qualityBar?: number;
}

/** A shadow-mode savings measurement for one skill (AIR.6 output), with a bootstrap CI. */
export interface RoutingMeasurement
{
  /** Stable identifier. */
  id: string;
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team. */
  skillTeam: string;
  /** The cheaper candidate model evaluated against the current default. */
  candidateModel: string | null;
  /** Number of logged calls sampled + shadow-graded. */
  sampledCalls: number;
  /** Fraction of sampled traffic the candidate served at-or-above the skill's bar. */
  atBarCheapFraction: number;
  /** Point estimate of % spend saved at equal quality. */
  projectedSavingsPct: number;
  /** Lower bound of the bootstrap 95% CI on projected savings. */
  ciLowPct: number;
  /** Upper bound of the bootstrap 95% CI on projected savings. */
  ciHighPct: number;
  /** Token overhead of running the measurement, as % of the skill's serve spend. */
  overheadPct: number;
  /** Skill content version coordinate: the `Skill.contentHash` at run time; null if unresolved (best-effort). */
  skillContentHash: string | null;
  /** Skill content version coordinate: the live published `SkillBundle.digest` at run time; null when no published bundle (best-effort). */
  skillDigest: string | null;
  /** Model deployment coordinate: the candidate's stable `litellmModelId`; null if unresolved (best-effort). */
  candidateModelId: string | null;
  /** Model deployment coordinate: the candidate's `upstreamModel`; null if unresolved (best-effort). */
  candidateUpstreamModel: string | null;
  /** When the measurement ran (ISO-8601). */
  runAt: string;
}

/** Lifecycle of a {@link RoutingProposal}. Mirrors Prisma `RoutingProposalStatus`. */
export const RoutingProposalStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Applied: "applied",
} as const;

/** Union of the {@link RoutingProposalStatus} values. */
export type RoutingProposalStatus = (typeof RoutingProposalStatus)[keyof typeof RoutingProposalStatus];

/**
 * A frontend-facing savings recommendation for one skill (AIR.11). Joins the skill's latest
 * {@link RoutingMeasurement} with any open Pending {@link RoutingProposal} on the same compound key,
 * so a UI can surface "switch X to the cheaper Y, saving ~Z%" and link the one-click approval.
 */
export interface SavingsRecommendation
{
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team (empty for org/global). */
  skillTeam: string;
  /** The skill's model-selection posture: `pinned`, `auto`, or null (inherits the scope default) — lets
   * the console phrase a fixed-model advisory distinctly ("this pinned skill could save N%"). */
  modelMode: SkillModelMode | null;
  /** The model the skill resolves to today — proposal `fromModel`, else the skill's pin, else null. */
  currentModel: string | null;
  /** The cheaper model recommended — proposal `proposedModel`, else the measurement candidate, else null. */
  recommendedModel: string | null;
  /** Stable deployment id of the recommended model — proposal `proposedModelId`, else the measurement's `candidateModelId`, else null. */
  recommendedModelId: string | null;
  /** Skill content version coordinate the evidence was gathered at — lets the console flag stale evidence ("evidence is for skill content vX"); null if unresolved. */
  skillContentHash: string | null;
  /** Live published `SkillBundle.digest` the evidence was gathered at; null when none. */
  skillDigest: string | null;
  /** Point estimate of % spend saved at equal quality (from the latest measurement). */
  projectedSavingsPct: number;
  /** Lower bound of the bootstrap 95% CI on projected savings. */
  ciLowPct: number;
  /** Upper bound of the bootstrap 95% CI on projected savings. */
  ciHighPct: number;
  /** True when an open Pending proposal exists for this skill — the UI can offer one-click approval. */
  hasOpenProposal: boolean;
  /** Id of the open Pending proposal, when one exists; null otherwise. */
  proposalId: string | null;
  /** Id of the latest measurement this recommendation is derived from. */
  measurementId: string;
  /** When the latest measurement ran (ISO-8601). */
  runAt: string;
}

/** A human-gated routing-change proposal (AIR.7) — applied only after explicit approval. */
export interface RoutingProposal
{
  /** Stable identifier. */
  id: string;
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team. */
  skillTeam: string;
  /** The model the skill resolves to today (null when unset). */
  fromModel: string | null;
  /** The cheaper model the loop proposes switching to. */
  proposedModel: string;
  /** Point estimate of % spend saved at equal quality. */
  projectedSavingsPct: number;
  /** Lower bound of the bootstrap 95% CI on projected savings (must exclude zero to propose). */
  ciLowPct: number;
  /** Upper bound of the bootstrap 95% CI. */
  ciHighPct: number;
  /** Skill content version coordinate: the `Skill.contentHash` at proposal time; null if unresolved (best-effort). */
  skillContentHash: string | null;
  /** Skill content version coordinate: the live published `SkillBundle.digest` at proposal time; null when none (best-effort). */
  skillDigest: string | null;
  /** Model deployment coordinate: the proposed model's stable `litellmModelId`; null if unresolved (best-effort). */
  proposedModelId: string | null;
  /** The measurement that produced this proposal. */
  measurementId: string | null;
  /** Lifecycle status. */
  status: RoutingProposalStatus;
  /** Principal who approved/rejected, when decided. */
  decidedBy: string | null;
  /** When the proposal was decided (ISO-8601). */
  decidedAt: string | null;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
}
