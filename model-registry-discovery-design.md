# Model registry: discovery, enablement, and naming

Design note for keeping OpenCrane's model registry current as new models ship constantly,
without a hand-maintained `model_list`. Slots into the existing `model-routing` core
(`apps/control-plane/src/core/model-routing/`). Status: proposal, not built.

## Problem

New models are published weekly. Each one needs an identity, specs (context window,
pricing, modalities, capabilities), a provider route, and a credential. A frozen,
hand-edited list rots immediately; auto-registering everything creates orphan models
pointing at missing keys and surprise spend. We want "new models show up ready to enable"
without "patch the list every week."

## The three layers (keep them separate)

Conflating these is what creates the maintenance treadmill. Each moves on its own cadence.

| Layer | Question | Cadence | Today in OpenCrane |
|---|---|---|---|
| **Discovery** | What models exist + their specs? | Automatic, frequent | **MISSING** |
| **Enablement** | Which are callable here, with which key? | Deliberate, key-gated | `ModelDefinition` → `ProviderCredential` |
| **Naming / routing** | What does the app request? | Rare (policy change) | `ModelRoutingDefault` + `Skill` posture |

The naming layer is the treadmill-killer: apps request a stable slug (`publicModelName`) or a
scope/skill **floor** (`ModelRoutingDefault.defaultModel`), never a pinned upstream ID. A new
model next week is a mapping change, not a code change. OpenCrane already has this indirection
— `publicModelName`, per-skill `modelMode`/`pinnedModel`/`autoConfig`, scope defaults, and the
AIR.7 safe-rollout spine (routing proposals are never auto-applied). The enablement layer also
exists: `ModelDefinition` records a registered LiteLLM deployment (`litellmModelId` from
`POST /model/new`, via `_RegisterLiteLlmModel`) wired to a `ProviderCredential` (a reference to
an External-Secrets-synced k8s Secret — the raw key is never stored).

**The only missing layer is discovery.** We're missing a catalog of *available* models with
specs, decoupled from whether they're enabled.

## How other systems solve discovery

- **Maintained metadata catalog (crowdsourced static file).** LiteLLM's own
  `model_prices_and_context_window.json` — PR-updated, shipped per release **plus** a live raw
  URL with a bundled backup. Pull live, fall back to bundled. Lags new models by days; pricing
  can be stale. Metadata only (no keys, no endpoints).
- **Vendor-run live registry API.** OpenRouter `/api/v1/models`; gateways (Portkey, Vercel AI
  Gateway, Cloudflare AI Gateway, Kong, Databricks) maintain a server-side catalog as a product.
- **Provider list APIs.** OpenAI/Anthropic `GET /v1/models`, Bedrock `ListFoundationModels`,
  Vertex Model Garden, Azure AI catalog, HF Hub. Authoritative for *availability with your key*,
  but usually return IDs only — no pricing/capabilities. Join with a metadata catalog.
- **GitOps + automation.** `model_list` in version control; a Renovate-style watcher diffs the
  cost-map and opens a PR. Humans decide; automation surfaces.

**Robust pattern: a periodic reconcile.** Sync the metadata catalog (∪ provider list APIs) into
a local catalog table, marking new entries "available, not enabled." Discovery automatic;
nothing callable or billable by surprise.

## Sources we can sync with (assessed 2026-06-23)

| Source | Endpoint | License | Coverage | Richness | Role |
|---|---|---|---|---|---|
| **models.dev** | `https://models.dev/api.json` (also `/models.json`, `/catalog.json`) | **MIT** | ~1,675 models | modalities in/out, `tool_call`/`reasoning`/`attachment`/`structured_output`, `limit.context`/`output`, cost incl. `cache_read`/`cache_write`, `release_date`, `knowledge`, `open_weights` | **Primary metadata catalog** |
| **LiteLLM cost map** | `model_prices_and_context_window.json` (live URL + bundled backup in the litellm pkg) | **MIT** | ~1000s | `max_input/output_tokens`, `input/output_cost_per_token`, `mode`, `supports_*`, `litellm_provider` | **Pricing-for-billing truth** (what the gateway meters against) |
| **Provider list APIs** | OpenAI/Anthropic `GET /v1/models`, Bedrock `ListFoundationModels`, Vertex, Azure | provider ToS | only what the key sees | sparse (IDs, sometimes context) | **Reachability gate** (needs BYOK key; optional v1) |
| **OpenRouter** | `/api/v1/models` | commercial ToS | 400+ | rich | **AVOID as a data source** (ToS + inspiration-only stance) |

models.dev JSON is keyed `provider → models → { id, name, family, limit{context,output}, cost{input,output,cache_read,cache_write} (per-million), modalities{input[],output[]}, attachment, reasoning, tool_call, structured_output, release_date, knowledge, open_weights }`. Maintained by sst/OpenCode (TOML source, schema-validated PRs); other registries (e.g. `llm-registry`) already sync from it weekly.

**Chosen approach: a two-source join (both MIT, AGPL-safe), keyed on LiteLLM.**
- **LiteLLM cost map is the spine.** Its model keys are the **canonical identity** of a catalog
  entry, and its rates are the **billable** pricing — both because LiteLLM is what actually routes
  and meters, so enablement (`POST /model/new`) and billing line up with the catalog by
  construction ("follow LiteLLM keys"). The LiteLLM map therefore defines the *universe* of
  catalog entries.
- **models.dev enriches** each entry (richer modalities + capability flags + cache pricing +
  release/knowledge dates), joined onto the canonical LiteLLM key. Where models.dev has no match,
  the entry still exists from the LiteLLM map; the enrichment fields are just null.
- **Id normalization** is the join step: normalize models.dev `xai/grok-4` and provider-native ids
  onto the LiteLLM key. Unmatched models.dev rows are ignored in v1 (not invented as entries).
- **Provider list APIs are out of scope for v1** ("map-only first") — added later as a reachability
  gate per BYOK key.

## Proposal

### 1. `ModelCatalogEntry` table (the discovery/catalog layer)

A row per *known* model — distinct from `ModelDefinition` (a *callable* deployment). Reconciled
from a source; never directly callable.

The canonical identity is the **LiteLLM map key** (`litellmKey`); models.dev fills the enrichment
fields. Pricing is reconciled on every run (it drifts), so billable rates track the LiteLLM map
over time — material price changes are audited (see reconcile job).

```
model ModelCatalogEntry {
  id              String   @id @default(cuid())
  litellmKey      String   @unique          // CANONICAL id = LiteLLM cost-map key ("follow LiteLLM keys")
  provider        String                    // litellm_provider
  mode            String?                    // chat | embedding | rerank | ...
  // --- billable pricing: from the LiteLLM map, re-read every reconcile ---
  inputCostPerToken  Decimal? @db.Decimal(20, 12)
  outputCostPerToken Decimal? @db.Decimal(20, 12)
  maxInputTokens  Int?
  maxOutputTokens Int?
  // --- enrichment: from models.dev, joined on litellmKey (null when unmatched) ---
  modelsDevId     String?                    // e.g. "xai/grok-4"
  modalitiesIn    String[]                   // ["text","image"]
  modalitiesOut   String[]
  capabilities    Json?                      // {tool_call, reasoning, attachment, structured_output, ...}
  cacheReadCost   Decimal? @db.Decimal(20, 12)
  cacheWriteCost  Decimal? @db.Decimal(20, 12)
  releaseDate     String?
  knowledgeCutoff String?
  openWeights     Boolean?
  // --- data residency: where this provider hosts inference (data-residency gate input) ---
  hostingRegions  String[]                   // one or more, e.g. ["eu-west","eu-central"] | ["us-east"]; empty = unknown
  // --- lifecycle ---
  pricingUpdatedAt DateTime?                 // last time a rate actually changed
  firstSeenAt     DateTime @default(now())
  lastSeenAt      DateTime                   // bumped each reconcile; staleness = lastSeenAt drift
  deprecatedAt    DateTime?                  // set when it drops out of the LiteLLM map
}
```

### 2. Reconcile job (discovery)

A **control-plane cron** (not the operator reconcile loop — decided) that each run:
1. Fetches the **LiteLLM cost map** (live URL → bundled backup on failure — cache + fallback).
   This is the spine: every key becomes/updates a `ModelCatalogEntry`, and its rates set the
   **billable** pricing.
2. Fetches **models.dev `/api.json`** and joins it onto the LiteLLM keys (id-normalized) to fill
   the enrichment fields. Unmatched models.dev rows are skipped in v1.
3. **Reconciles pricing over time** — not just discovery of new models. Re-reads rates every run;
   when a rate actually changes, updates the entry, stamps `pricingUpdatedAt`, and writes an
   `AuditEntry` (price drift is billing-relevant, so the change is recorded, not silent).
4. Upserts entries; bumps `lastSeenAt`; sets `deprecatedAt` for keys that dropped out of the
   LiteLLM map. New models appear automatically as *available, not enabled*.

**Provider list APIs are out of scope for v1 (map-only first — decided);** added later as a
reachability gate per BYOK key.

Lives alongside the routing core, e.g. `model-routing/catalog-reconcile.ts`, scheduled as a
control-plane cron.

### 3. Enablement gate — fully opt-in, attach key at enable (decided)

**No model is enabled by default** — nothing is registered on deploy. The catalog is purely
*available*; an operator explicitly opts a model in. Enablement = today's flow:
`_RegisterLiteLlmModel` → `POST /model/new` → record a `ModelDefinition` wired to a
`ProviderCredential`. The credential is **attached at enable time** (BYOK), not pre-provisioned.
**Fail-closed**: refuse to enable an entry whose provider has no `ProviderCredential` in scope (no
orphan models pointing at missing keys). A `ModelRoutingDefault.defaultModel` (floor) may only
reference an *enabled* `publicModelName`.

### Layer wiring summary

```
LiteLLM cost map (spine: keys + billable pricing)  ⨝  models.dev (enrichment)
   │  control-plane cron reconcile (automatic; pricing re-read + audited each run)
   ▼
ModelCatalogEntry        ── available, NOT enabled
   │  opt-in enable (deliberate; attach BYOK ProviderCredential; fail-closed)
   ▼
ModelDefinition          ── callable LiteLLM deployment (existing)
   │  referenced by
   ▼
ModelRoutingDefault / Skill posture   ── stable names + floors (existing)
```

## Principles carried from the field

- **Metadata source ≠ access source.** Specs/pricing from the maps; reachability from provider
  APIs + our keys. Join them — though reachability is deferred past v1 (map-only first).
- **Don't trust crowdsourced pricing for billing.** Verify/pin the prices we actually bill on
  rather than trusting `ModelCatalogEntry.*CostPerToken` blindly.
- **Cache + fallback** (LiteLLM's live-URL-with-bundled-backup shape): current, not down.
- **Enablement is fail-closed and key-gated.**
- **Avoid OpenRouter as a *data* source** here, consistent with the "OpenRouter = inspiration
  only" stance; use LiteLLM's own map.

## Decisions (locked 2026-06-23)

- **Reconcile transport: control-plane cron.** Not the operator reconcile loop.
- **No default-enabled set.** Fully opt-in; the operator attaches a BYOK credential at enable time.
- **v1 is map-only.** No provider list-API reachability checks; add later as a reachability gate.
- **Pricing: LiteLLM map for billing, reconciled over time.** Rates are re-read every run and
  audited on change (`pricingUpdatedAt` + `AuditEntry`); models.dev pricing is display-only.
- **Canonical id = LiteLLM map keys** ("follow LiteLLM keys"). models.dev is joined onto them;
  unmatched models.dev rows are ignored in v1.

### Still open

- Cron cadence (e.g. hourly vs. daily) and where the schedule is configured.
- Threshold for what counts as a "material" price change worth an `AuditEntry`.
- When provider list-API reachability lands (v1.5) and how it gates enablement.

## See also

- `litellm-byok-byom-research.md`, `litellm-router-autonomous-improvement-research.md` (router + BYOK)
- `apps/control-plane/src/core/model-routing/` (registration, skill resolution, shadow measure)
- `apps/control-plane/prisma/schema.prisma` — `ModelDefinition`, `ProviderCredential`,
  `ModelRoutingDefault`, `Skill`, `ModelRoutingScope`
