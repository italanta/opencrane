# OpenCrane — Completed Work

> This file is the historical record of completed phases and decisions.
> Active work lives in `plan.md`.

---

## Executive Summary (History)

**Current state**: Phase 1 baseline is now complete for go-live smoke validation. Core operator/API/UI, Helm deployments, Docker CI publish workflow, and k3d end-to-end reconciliation tests are in place and passing.

**Live update (2026-04-16)**:
- Phase II cost-control routing refactor is complete and validated.
- AI budget/spend/key management is consolidated under `/api/ai-budget`.
- Dedicated AI-budget router tests were added and are passing.
- Control-plane UI test pipeline is now fixed (Karma/Jasmine deps + spec config + baseline spec).
- Full workspace validation currently passes: `pnpm test` and `pnpm build`.

**Live update (2026-04-26)**:
- k3d end-to-end smoke test now passes via `platform/tests/k3d-e2e.sh`.
- Tenant reconciliation was stabilized for local-storage mode:
   - Added per-tenant state PVC creation before Deployment reconciliation.
   - Added operator RBAC permissions for `persistentvolumeclaims`.
   - Handled PVC immutability by skipping replace on `AlreadyExists` conflicts.
- Kubernetes API client usage was corrected:
   - Built-in resources now use typed clients (`CoreV1Api`, `AppsV1Api`, `NetworkingV1Api`).
   - BucketClaim CRD apply path now uses custom-resource client handling.
- Tenant status subresource patching now uses JSON Patch payload shape.
- Invalid default OpenClaw config field (`agents.defaults.thinking`) was removed from generated tenant config.
- Phase 2 execution started:
   - Added in-chart LiteLLM resources (`Deployment`, `Service`, and managed `Secret`) as baseline setup for cost routing.
   - Set chart defaults so cost routing is enabled by default, with production override guidance for master key handling.
   - Added Helm validation guard: non-dev installs fail fast if LiteLLM uses a placeholder/empty master key without `litellm.existingSecret`.

**Live update (2026-05-14)**:
- Removed duplicate LiteLLM rendering from the Helm chart so the root chart templates are the only deployment path.
- Added a full local k3d bootstrap path with PostgreSQL, control-plane, LiteLLM, and Prisma migrations.
- Added a `strict` local profile to exercise prod-style Helm validation and explicit LiteLLM secret wiring locally.
- Captured a parity checklist clarifying that local validates core stack wiring, while GCP remains the only path that exercises cloud identity, GCS, External Secrets, GCE ingress, and DNS. (Crossplane is superseded by the GoF Adapter hosting architecture — see `docs/hosting-architecture.md`.)
- Implemented deterministic tenant `policyRef` precedence in the operator: explicit `policyRef` wins, then single selector match, then configured default, with conflict and missing-policy error states written to Tenant status.
- Added detect-only drift reporting for Tenant and AccessPolicy CRDs versus PostgreSQL projection rows in the control-plane as the first P0 dual-write visibility slice.
- Published resolved AccessPolicy MCP allow/deny data into the tenant managed-runtime contract so runtime enforcement can consume concrete policy inputs instead of only a policy name.
- Enforced the managed-runtime MCP policy in the tenant entrypoint for shared skills, so a denied `skills` server now prevents org/team skill linking at startup.
- Implemented projection repair for Tenant and AccessPolicy rows: `POST /tenants/repair` and `POST /policies/repair` read CRDs as source of truth and upsert drifted PostgreSQL rows; dry-run by default, apply on `?dryRun=false`.
- Added `GET /api/metrics/projection-drift` so dashboards can poll detect-only Tenant and AccessPolicy mismatch counts from the existing drift detector.
- Added configurable threshold evaluation to `GET /api/metrics/projection-drift` so the API now exposes basic drift alert state alongside mismatch counts.
- Added projection lag metrics to `GET /api/metrics/projection-drift`, derived from drifted row `updatedAt` timestamps so dashboards can estimate how stale current mismatches are.

**Live update (2026-05-25)**:
- Memory architecture direction is now set: OpenClaw remains the source-system integration layer and writes through to Cognee for tenant-scoped memory orchestration.
- The earlier "uncertain strict tenancy fit" concern is retired for Cognee. Tenancy and RBAC are treated as supported via Cognee's dataset-level EBAC model.
- Memory adoption gate is now explicit: dataset granularity choice, AccessPolicy-to-Cognee permission mapping, source-permission propagation, and freshness invalidation strategy are mandatory before production cutover. Self-hosted audit parity is tracked as an operational hardening item.
- `docs/memory.md` is now the canonical target-state design for the memory layer.

**Live update (2026-06-10) — re-verified against working tree**:
- **Phase 5 is code-complete.** `terraform/modules/crossplane/` and `crossplane-provider.yaml` are deleted; `GcpHostingAdapter` + `GcpBucketClient` provision GCS buckets in-operator via `@google-cloud/storage` + Workload Identity; Terraform is split into `terraform/core/` + `terraform/cloud/gcp/`; `values.yaml` defaults to `hosting.provider: onprem`. Remaining: deploy-validation evidence (P5.2 on-prem, P5.3 GCP). Stale Crossplane comment + RBAC rule removed (P5.1 done).
- **Phase 4 Track A built & wired.** `apps/skill-registry/` (projected-token validation, get-by-digest-only, existence-hiding 404s, entitlement-checked); Obot gateway deploy + `/api/internal/obot-registry`; `/api/internal/bundles` content delivery; real grant compiler + `GET /tenants/:name/effective-contract`.
- **Phase 4 Track A residual gaps:** ingest scanning (P4A.1), runtime-plane drift repair (P4A.2), tenant-side re-pull loop (P4A.3).
- **Phase 4 Track B not started.** Awareness SDK, contract versioning/canary, golden-query harness, fleet skills-sharing protocol, awareness SLOs all absent.
- **Process:** Track-A + Phase-5 work committed on branch `phase-4-5-fixes`.

**Live update (2026-06-09) — _(partially superseded by 2026-06-10 above)_**:
- Phase 5 shipped (headless API + CLI). `oc` CLI, OpenAPI, generated `libs/contracts` client, and removal of `apps/control-plane-ui` in place.
- Phase 4 was paused mid-flight: org-index schema v2, Slack lineage/freshness, projected-token migration, and the control-plane MCP/Skills/third-party management layer built. Runtime enforcement planes and fleet-awareness track not built at that point.

---

## README Realization Track (2026-05-12)

### Vision-to-Execution Mapping

| README promise | Delivery status | Delivery phase |
|----------------|-----------------|----------------|
| Every employee gets an isolated assistant | Baseline in place | Phase 1 complete + hardening backlog |
| Cost governance and budget controls | Complete | Phase 2 |
| Retrieval plugin with RBAC-filtered org context | Foundation complete | Phase 2-3 |
| Company-wide harvesting agents + org index | Complete | Phase 2-3 |
| Self-service provisioning (web portal) | Complete (API + CLI) | Phase 3 / Phase 5 |
| Memory orchestration cutover (Cognee write-through) | Complete | Phase 3 |

### Steering Rule For Docs And Pitch

Use three labels consistently across README/pitch/sales material:
- **Available now**: only Phase 1–3 + Phase 5 validated and currently passing capabilities.
- **In progress**: Phase 4 deliverables under active implementation.
- **Planned**: Phase 4 Track B items not yet validated.

---

## Phase 1: Core Platform (Complete)

### Architecture Decisions (Locked)

1. **Helm Chart Structure** — Root chart owns LiteLLM directly; no separate LiteLLM subchart. PostgreSQL consumed via `DATABASE_URL` Secret wiring.
2. **Operator Deployment** — Single-replica baseline. RBAC and env wiring for storage provider, ingress, LiteLLM, and idle reconciliation are part of the shipped chart baseline.
3. **Tenant Pod Isolation** — On-prem path uses PVC fallback; GCP path uses GCS/Workload Identity via in-operator GcpHostingAdapter (Crossplane retired).
4. **Control Plane Deployment** — PostgreSQL-backed deployment flows; local provisions in-cluster database for full-stack bring-up.
5. **Terraform & IaC** — `terraform/core/` (cloud-agnostic) + `terraform/cloud/gcp/` (GCP-specific). Crossplane module retired.

### Completion Checklist

| Item | Status | Evidence |
|------|--------|----------|
| **Helm templates** (operator/control-plane + RBAC/services) | ✅ Complete | Deploys successfully in k3d via chart install |
| **Docker image CI publish workflow** | ✅ Complete | `.github/workflows/docker.yml` builds/tests/e2e and publishes on `main` |
| **Prisma migrations present** | ✅ Complete | `apps/control-plane/prisma/migrations/0001_init` committed |
| **Tenant runtime image + entrypoint** | ✅ Complete | `apps/tenant/deploy/Dockerfile` + `entrypoint.sh` exercised in k3d e2e |
| **k3d end-to-end smoke test** | ✅ Complete | `platform/tests/k3d-e2e.sh` passes and validates tenant reconcile |

### Success Criteria

- [x] Operator reconciles a Tenant CR end-to-end (ServiceAccount → Deployment → Ingress → status).
- [x] AccessPolicy CRD generation path is implemented and covered by tests.
- [x] `helm install opencrane platform/helm/` deploys operator + CRDs.
- [x] Tenant pod starts, mounts storage, links skills, starts OpenClaw gateway on port 18789.

### Local vs GCP Parity Checklist (2026-05-14)

| Capability | Local `default` | Local `strict` | GCP deploy |
|------------|-----------------|-------------------|------------|
| Operator + control-plane + LiteLLM + PostgreSQL | ✅ | ✅ | ✅ |
| Prisma migration job | ✅ | ✅ | ✅ |
| Production-style LiteLLM validation rules | ❌ | ✅ | ✅ |
| Explicit `opencrane-litellm` Secret control flow | ❌ | ✅ | ✅ |
| In-cluster database secret (`opencrane-db`) | ✅ | ✅ | ✅ |
| Tenant PVC fallback flow | ✅ | ✅ | ❌ |
| Workload Identity annotation path | ❌ | ❌ | ✅ |
| External Secrets / Secret Manager path | ❌ | ❌ | ✅ |
| GCE ingress + static IP + DNS wiring | ❌ | ❌ | ✅ |

---

## Phase 2: Cost Control + Retrieval Foundation (Complete)

### Architecture Decisions (Locked 2026-05-28)

1. **LiteLLM Deployment** — Same namespace (`opencrane`); shared platform PostgreSQL; chart-managed master key and database URL.
2. **Virtual Key Generation** — Sync during Tenant reconcile (step 4); static per tenant; revocation manual.
3. **Spend Tracking** — Per tenant (primary) + per model (secondary); real-time from LiteLLM API; hard enforcement via LiteLLM 429; 80% warning via spend endpoint.
4. **Tenant Config Injection** — `LITELLM_ENDPOINT` env var + `LITELLM_API_KEY` from tenant Secret; tenants cannot override cluster-local proxy endpoint.
5. **Observability & Alerts** — 503 when LiteLLM unreachable; `budgetAlertState: "warning"` at 80%.
6. **Org Knowledge Index** — Minimum schema with `source`, `sourceId`, `owner`, `teamScope`, `sensitivityTags`, `title`, `content`, `contentHash`, `embeddingReady`, `ingestedAt`, `updatedAt`. PostgreSQL-only for Phase 2. Target Phase 3+: Cognee orchestration.
7. **Retrieval Authorization** — AccessPolicy sole enforcement source; 403 on denied (not silent empty); direct OpenClaw/Clawdbot to Cognee (no control-plane proxy).
8. **Harvesting Agent** — Slack connector with cursor-based batch pull (15-minute interval); ingestion SLOs: lag < 30 min p95, failure rate < 1%.
9. **Single-Writer Ownership** — Operator sidecar owns PostgreSQL projection writes; request-path dual-writes retired in Phase 3.

### Success Criteria (All Met)

- [x] Helm chart deploys LiteLLM through the root chart with shared PostgreSQL integration.
- [x] On Tenant CR creation, operator creates a LiteLLM virtual key with monthly budget.
- [x] Tenant pod receives `LITELLM_API_KEY` and proxy endpoint.
- [x] Control Plane exposes spend endpoint; shows per-tenant usage + budget.
- [x] Retrieval path direct from OpenClaw/Clawdbot to Cognee.
- [x] One harvesting connector continuously ingests documents with measurable lag/error metrics.
- [x] AccessPolicy outcomes translated into Cognee dataset memberships via `/api/tenants/:name/datasets`.
- [x] MCP server allow/deny enforced at gateway level beyond startup.
- [x] Tenant skill distribution model: durable `skillAllowlist` field on Tenant CRD.
- [x] Projection drift measurable via metrics; repairable via `POST /tenants/repair` and `POST /policies/repair`.
- [x] External alert delivery: webhook fired when drift count exceeds threshold.

---

## Phase 3: Self-Service Provisioning + Memory Cutover (Complete)

### Architecture Decisions (Locked)

1. **Web Portal** — Embedded in Angular control-plane-ui (removed in Phase 5; admin surface now API + `oc` CLI only).
2. **Auth Baseline** — Bearer token for Phase 3; OIDC deferred to future work. Phase 5 delivered OIDC device flow.
3. **Tenant Provisioning** — Self-provisioning creates Tenant CRs directly; naming/team constraints policy-driven.
4. **Memory Cutover** — Hard switch to Cognee write-through for all tenants; OpenClaw responsible for source connectors and permission-aware copy semantics.
5. **Dataset Granularity** — org/team/project/personal; AccessPolicy as sole enforcement source; deny-by-default.

#### Phase 3 Decision Lock: AccessPolicy → Cognee Mapping

- AccessPolicy remains the sole authorization source for retrieval decisions.
- Dataset scopes are enforced as org/team/project/personal, with deny-by-default behavior.
- Explicit deny always overrides allow on scope conflicts.
- Retrieval path grants read access only to datasets explicitly allowed by effective policy.
- Write/share/delete permissions are disabled by default and require explicit policy authorization.
- Every retrieval authorization outcome must be audit-logged with principal, dataset scope, action, decision, and policy reason.

### Success Criteria (All Met)

- [x] Non-admin user can self-provision tenant via web form (ProvisionPageComponent + TenantApiService).
- [x] Tenant appears in Kubernetes as Tenant CR within 30s.
- [x] Dashboard shows health, spend, and last reconciled time per tenant.
- [x] Retrieval runtime cut over to Cognee write-through for all tenants.
- [x] AccessPolicy-compatible dataset permissions enforced through control-plane-managed Cognee subject memberships.
- [x] Dataset membership controls exposed for org/team/project/personal scopes.
- [x] Approval flow explicitly deferred; no Phase 3 blocker depends on approval route delivery.
- [x] Freshness/invalidation deferred to Sprint 3+ under Clawdbot control.

---

## Phase 5: Headless Control Plane (Code-Complete)

### Architecture Decisions (Locked)

1. **API as the single boundary** — Every capability reachable through `/api/v1`. OpenAPI emitted from build; CI drift gate enforced.
2. **CLI as a first-class surface** — `oc` CLI covers full administrative surface; authenticates via OIDC device flow (`oc auth login`); no static bearer token required by default.
3. **UI decoupled** — `apps/control-plane-ui` removed from this repo. Helm chart and installers no longer reference it. Platform operable via API + CLI only.
4. **Hosting adapter migration** — GoF Adapter pattern; `OnPremHostingAdapter` is default; `GcpHostingAdapter` provisions GCS buckets via `@google-cloud/storage` + Workload Identity (no Crossplane). Terraform split into `terraform/core/` + `terraform/cloud/gcp/`.

### Steps (All Complete)

**Step 1 — Hosting adapter migration** ✅
- `HostingAdapter` interface + `OnPremHostingAdapter` + `GcpHostingAdapter` in `apps/operator/src/hosting/`.
- Crossplane `BucketClaim` path deleted; `modules/crossplane/` and `crossplane-provider.yaml` removed.
- Terraform split: `terraform/core/` + `terraform/cloud/gcp/`; Crossplane module retired.
- `platform/helm/values/gcp.yaml` override added; `values.yaml` defaults to `hosting.provider: onprem`.

**Step 2 — API surface hardening + OpenAPI** ✅
- All business routes at `/api/v1/`. Consistent `{ error, code }` error envelopes. Cursor-based keyset pagination on audit.
- `openapi.json` emitted from `pnpm build`; `GET /api/v1/openapi.json` serves spec at runtime.
- CI drift gate: `pnpm emit-openapi && git diff --exit-code openapi.json`.

**Step 3 — Contract / SDK package + `oc` CLI** ✅
- `openapi-typescript` generates typed `paths` from `openapi.json` into `libs/contracts/src/generated/api.ts`.
- `createControlPlaneClient(baseUrl, token?)` factory in `libs/contracts/src/client.ts`.
- `apps/cli` (`oc` binary): command groups `tenants`, `policies`, `mcp`, `skills`, `budget`, `audit`, `tokens`, `providers`.

**Step 4 — Capability parity audit + auth alignment** ✅
- All UI-used endpoints documented in OpenAPI spec.
- `oc metrics server`, `oc metrics drift`, `oc auth me`, `oc auth logout` added.
- OIDC device flow (`POST /auth/device` → browser activation → poll `/auth/device/token` → credentials saved to `~/.config/opencrane/credentials.json`). Break-glass `--token` flag removed from CLI.

**Step 5 — UI extraction + chart cleanup** ✅
- `apps/control-plane-ui` removed from `pnpm-workspace.yaml` and deleted from repo.
- `docs/api.md`, `docs/cli.md`, `docs/integration-guide.md` published.

### Success Criteria

- [x] Platform fully operable with no admin UI (API + CLI only).
- [x] Every administrative capability has a documented API endpoint and `oc` CLI command.
- [x] OpenAPI emitted from build; CI drift gate enforced.
- [x] `libs/contracts` publishes a generated, versioned client consumed by the CLI.
- [x] `oc` CLI authenticates via OIDC device flow; no command requires a static bearer token by default.
- [x] `apps/control-plane-ui` removed; Helm chart/installers no longer reference it.
- [x] External repository can integrate as git submodule and drive every operation through the published contract.
- [x] GCP adapter provisions per-tenant GCS buckets directly in operator; no Crossplane dependency.
- [x] `terraform/core/` applies to any cluster; `terraform/cloud/gcp/` is the only GCP-specific path.
- [~] Clean Kubernetes cluster deploys with zero cloud env vars — code path in place; deploy-validation evidence pending (P5.2 in active plan).

---

## Implementation Status Update (2026-05-28)

All major Phase 2 items are now implemented. The following sessions were completed in this cycle:

### Session 1 — Phase 2 architecture decisions locked
All open Phase 2 decisions resolved with concrete outcomes.

### Session 2 — LiteLLM governance
Already complete from previous cycle. Key generation, budget enforcement, spend endpoint, and tenant injection validated.

### Session 3 — Retrieval foundation
- `OrgDocument` and `HarvestingCursor` models added to Prisma schema (migration `0002_retrieval_foundation`).
- Retrieval now goes directly from OpenClaw/Clawdbot to Cognee; control-plane retains dataset membership and Cognee permission synchronization.

### Session 4 — Harvesting-agent MVP
- `apps/harvesting-agent` workspace package with Slack source connector.
- Cursor-based incremental sync; normalizes to `NormalizedDocument` and upserts to `org_documents`.
- `/metrics` and `/healthz` HTTP endpoints.

### Session 5 — MCP + tenant skill governance
- `skillAllowlist` field added to Tenant CRD and `TenantSpec`.
- `mcpPolicy` field added for per-tenant invocation-level MCP enforcement.
- Operator injects `OPENCRANE_TENANT_MCP_ALLOW` and `OPENCRANE_TENANT_MCP_DENY` env vars.
- `entrypoint.sh` updated: tenant CRD deny wins over policy-level allow.

### Session 6 — Projection drift alerting + ownership
- Webhook delivery added to `GET /api/metrics/projection-drift`.
- Single-writer ownership: operator sidecar is the authoritative projector.

### Session 7 — runbook.md
- `docs/runbook.md` written with install, verification, upgrade, rollback, and incident-response procedures.

### Session 8 — Angular portal features
- `TenantApiService` and `SpendApiService` in `core/api/`.
- Shared components: `TenantCardComponent`, `SpendChartComponent`.
- Feature pages: `DashboardPageComponent`, `ProvisionPageComponent`, `TenantDetailPageComponent`, `AdminPanelPageComponent`.

### Session 9 — Operational maturity foundation
- `TenantUpdateWithCanaryStrategyController` with npm release polling and canary rollout strategy.
- Prometheus-format `/prom/metrics` endpoint with tenant phase gauges, org document count, audit entry counter.

### Session 10 — Dataset membership controls + retrieval authorization
- Tenant dataset membership APIs: `GET` + `PUT /api/tenants/:name/datasets`.
- Retrieval route enforces dataset scope membership with explicit `DATASET_DENIED` responses.
- Conformance tests for dataset allow/deny paths.

---

## Phase-by-Phase Decisions (Phases 1–3, All Closed)

### Phase 1 Decisions (Closed)
- [x] Helm chart owns LiteLLM directly; no separate subchart.
- [x] Operator baseline is single-replica.
- [x] Tenant isolation: GCS/hosting-adapter + PVC fallback.
- [x] Local full-stack install supports PostgreSQL-backed bring-up.

### Phase 2 Decisions (Locked 2026-05-28)
- [x] LiteLLM namespace: same namespace as operator.
- [x] Virtual key generation: sync (block reconcile), implemented in operator reconcile step 4.
- [x] Spend tracking: real-time from LiteLLM API, augmented with local budget metadata.
- [x] Hard budget enforcement: LiteLLM rejects on overage (429); control-plane warns at 80%.
- [x] Proxy optional: no — LiteLLM is cluster-wide; opt-out is not allowed.
- [x] Org index storage profile: PostgreSQL-only for MVP; pgvector deferred to Phase 3+.
- [x] Retrieval authorization source: AccessPolicy only.
- [x] Retrieval failure behavior: explicit 403 authorization errors (not silent empty results).
- [x] First harvesting connector: Slack with cursor-based batch pull (15-minute interval).
- [x] Ingestion SLO thresholds: lag < 30 minutes p95, failure rate < 1% per sync cycle.
- [x] Single-writer ownership: operator sidecar owns PostgreSQL projection writes.

### Phase 3 Decisions (Locked)
- [x] Portal: embedded in Angular control-plane-ui (removed in Phase 5; admin now API + CLI only).
- [x] Auth baseline: bearer token for Phase 3; OIDC delivered in Phase 5.
- [x] Approval workflow deferred to future work.
- [x] Memory upgrade in Phase 3 required scope.
- [x] Memory cutover wave: all tenants; mode: hard switch.
- [x] Dataset granularity: org, team, project, personal.
- [x] Tenant CR SLO target: 30 seconds.
- [x] Freshness/invalidation: deferred to Sprint 3+ under Clawdbot control.

---

## Go-Live Checklist (Full)

| Item | Owner | Status | Done Criteria |
|------|-------|--------|---------------|
| Local baseline green (`pnpm install`, `pnpm test`, `pnpm build`) | Backend | ✅ Complete (2026-04-16) | Commands pass locally. |
| Local platform e2e (`platform/tests/k3d-e2e.sh`) | Backend + QA | ✅ Complete (2026-04-26) | Helm install succeeds; tenant reconcile smoke test passes in k3d. |
| Local full-stack bootstrap (`platform/tests/k3d-local.sh`) | Backend + DevOps | ✅ Complete (2026-05-14) | Local path provisions PostgreSQL, control-plane, LiteLLM, migrations. |
| Helm chart completion (`platform/helm/templates`) | DevOps | ✅ Complete for Phase 1 baseline | Operator and control-plane deploy cleanly. |
| GCP installer smoke (`./platform/install.sh gcp`) | DevOps | Not yet revalidated | Fresh GCP project deploys end-to-end; test tenant reconciles successfully. |
| Docker image publish automation | DevOps | ✅ Complete | CI builds/tests/e2e and publishes images on `main`. |
| Prisma migration rollout (`prisma migrate deploy`) | Backend | ✅ Complete baseline | Migrations committed; installer paths include migration execution. |
| CI e2e gate | QA + DevOps | ✅ Complete baseline | CI runs the k3d smoke path. |
| DNS + ingress verification | DevOps | Not started | Domain and TLS resolve correctly; subdomains accessible externally. |
| Runbook + rollback docs | Backend + DevOps | ✅ Complete (2026-05-28) | `docs/runbook.md` covers install, verify, upgrade, rollback, incident response. |

---

## Effort Summary

| Phase | Effort | Timeline | Start |
|-------|--------|----------|-------|
| **Phase 1** (Core) | 90h | 3 weeks | Week 1 |
| **Phase 2** (Cost control + retrieval foundation) | 127h | 2-3 weeks | Week 2 |
| **Phase 3** (Self-service + memory cutover) | 97h | 3 weeks | Week 4 |
| **Phase 4** (Fleet organizational awareness + MCP & skills platform) | 324h | 8-10 weeks | Week 7 |
| **Phase 5** (Headless API + CLI) | 164h | 4-5 weeks | After Phase 3 |
| **Total** | **802h** | **20–25 weeks** | |


---

## Completed Tracks — archived 2026-06-15 (moved from plan.md)

### Track P5 — Close Phase 5

- [x] **P5.1 Stale-Crossplane cleanup.** Removed unreachable `bucketclaims` RBAC rule +
  comment from `platform/helm/templates/operator-rbac.yaml`, removed stale Crossplane comments
  from `platform/terraform/cloud/gcp/main.tf` and `platform/deploy.sh`.
  Verified: `grep -ri crossplane platform/` returns nothing.
- [x] **P5.2 On-prem clean-cluster deploy validation.** Validated by user (2026-06-10).
  `platform/tests/k3d-e2e.sh` passed on fresh k3d cluster with `hosting.provider: onprem`
  and zero cloud env vars.
- [x] **P5.3 GCP adapter deploy validation.** Validated by user (2026-06-10).
  `terraform/cloud/gcp/` + `values/gcp.yaml` applied; operator provisioned a per-tenant GCS
  bucket via `GcpHostingAdapter` (no Crossplane). Acceptance criteria met.

---

### Track P4-A — Finish Phase 4 runtime-plane enforcement gaps

- [x] **P4A.1 Ingest scanning (scan → validate → register → entitle).** Added `SkillBundleScanStatus`
  enum + `scanStatus`/`scanFindings`/`scannedAt` fields (migration 0007). `POST /api/v1/skills/catalog/:id/scan`
  triggers Grype/Trivy scan (falls back `scanner-unavailable` gracefully). PUT gate rejects promotion
  to `published` when `scanStatus ≠ passed`. Internal delivery (`/api/internal/bundles`) only serves
  bundles with `scanStatus = passed`. 7 tests added; build + tests pass.
- [x] **P4A.2 Runtime-plane drift repair (operator config-slaving).** Added `RuntimePlaneDriftRepairer`
  (`apps/operator/src/runtime-planes/drift-repairer.ts`) — 60s interval compares Obot MCP gateway and
  skill-registry Deployment env vars against expected config, patches back in-place (preserving
  `valueFrom.secretKeyRef` refs). Wired into `operator/src/index.ts`. 3 tests added; build + tests pass.
- [x] **P4A.3 Tenant-side contract re-pull loop.** Added `/api/internal/contract/:name` endpoint with
  TokenReview identity enforcement (tenant can only pull its own contract). Operator injects
  `OPENCRANE_CONTROL_PLANE_URL` + `control-plane` projected SA token into tenant Deployments.
  `entrypoint.sh` background polling loop (30s) calls the endpoint, diffs SHA256, updates writable
  contract copy, sends SIGHUP to OpenClaw when contract changes. 6 tests added; build + tests pass.

---

### Track P4-C — Agent Identity & Personalisation (OpenClaw workspace files)

> New track scoped 2026-06-10. Lets tenants personalise their agents while platform
> core behaviour stays immutable. Decisions below are **LOCKED** (no P4B.0-style block).
> OpenClaw has no native file layering/precedence/includes (verified against docs.openclaw.ai),
> so OpenCrane implements the layering at the operator + entrypoint + control-plane layer.

**Locked design decisions (2026-06-10):**
- **Three ownership layers.**
  - *L0 Platform* — `AGENTS.md`, `TOOLS.md`. OpenCrane-owned, re-stamped every boot. Encodes
    system mechanics (managed mode, MCP routes via Obot gateway, per-entitlement skill pulls,
    contract semantics). Never editable by company or tenant.
  - *L1 Company* — company `SOUL.md` + curated policy/voice docs. Org-owned, editable via
    control-plane API, versioned v1…vN (immutable versions). Must carry **no** system mechanics.
  - *L2 Tenant* — effective workspace docs (`SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`,
    `HEARTBEAT.md`) under the persistent `/data/openclaw` workspace. Seeded from L1, then edited
    live in-pod; persists across restarts.
- **`TOOLS.md` is contract-derived** — rendered from the tenant's entitled MCP servers + skills.
- **Company→tenant reconciliation = agent-driven 3-way merge** (base = tenant's
  `lastReconciledVersion`, ours = new company version, theirs = tenant current). Conflict policy:
  company wins, tenant intent preserved where compatible. Idempotent/resumable like `migrate up`.
- **Propose-and-approve** — reconciler emits a proposed merge + diff; admin/tenant approves before
  it lands. No silent prompt changes.
- **Server-side execution, delivered via the P4A.3 re-pull loop** — control-plane reads the tenant's
  current doc through the internal token-authenticated endpoint, the merge agent (LiteLLM-backed)
  reconciles, and the result rides the existing contract delivery into the pod.
- **OpenClaw is made aware of doc changes** — on apply, the agent is notified and can view the
  change/diff (no silent identity swap-out).
- **Invariant guard:** the reconciliation agent is sandboxed to L1/L2 and can never edit L0. "Core
  behaviour cannot be changed" is guaranteed by L0 re-stamping + the IAM planes (Obot gateway +
  skill registry), NOT by prompt prose (OpenClaw has no precedence between files).

- [x] **P4C.1 Workspace bootstrap + layered seeding.** `_BuildConfigMap` emits L0 files
  (`AGENTS.md`, `TOOLS.md`) and L2 seed files (`SOUL.md.seed`, `IDENTITY.md.seed`, `USER.md.seed`)
  as ConfigMap keys; pins `agents.defaults.workspace = /data/openclaw/workspace` and
  `skipBootstrap: true` after the tenant-override merge (so they survive any `agents` override).
  `entrypoint.sh` re-stamps L0 files every boot and seeds L2 files once-if-absent.
  AGENTS.md contains the full platform brief (managed mode, gateway/registry URLs, ownership
  table, platform invariants). TOOLS.md lists live URLs (static for P4C.1).
  L2 seeds are personalised with tenant name and team. 2 tests added; 54/54 operator tests pass.
- [x] **P4C.2 Contract-derived `TOOLS.md`.** (2026-06-13) Pure `_RenderToolsMarkdown`
  (`core/contract/tools-markdown.ts`, sorted/deterministic so the in-pod content diff only
  fires on real change) renders TOOLS.md from the entitled MCP servers + skills. The internal
  contract endpoint (`routes/internal/tenant-contract.ts`) resolves display names/descriptions
  for the allow-decided ids and returns the rendered doc under `workspace["TOOLS.md"]`. The
  entrypoint poll loop (`apps/tenant/deploy/entrypoint.sh`) writes it to the workspace TOOLS.md
  on contract change via a `_apply_workspace_docs` node-extract, then SIGHUPs OpenClaw — so a
  grant/deny reflects within one poll interval with no pod restart. (The operator-mounted
  bootstrap contract has no workspace docs, so a cold start shows the static L0 TOOLS.md until
  the first poll refreshes it; the boot-time apply call is forward-compatible for the day the
  mounted contract embeds them.) Tests: `tools-markdown.test.ts` (3) + contract-route
  TOOLS.md assertion; control-plane 72/72, build clean; `bash -n` clean.
- [x] **P4C.3 Company doc API + versioning (L1).** (2026-06-13) `CompanyDoc`/`CompanyDocVersion`
  Prisma models + migration `0009_company_personalisation`; CRUD at `/api/v1/org/workspace-docs/:name`
  (`routes/company-docs.ts` + `features/company-docs/company-docs.logic.ts`): `PUT` publishes an
  **immutable** version (transactional append + `currentVersion` bump, records `createdBy`), `GET`
  current, `GET /versions`, `GET /versions/:version` (retrieve any prior version). L0 allowlist guard
  (`core/personalisation/l0-guard.ts`) rejects content asserting platform mechanics (managed mode,
  Obot, skill-registry, effective-contract, `OPENCRANE_*`, `/data/openclaw`, AGENTS/TOOLS.md) with
  422 before any write. Tests: l0-guard (4) + publish-versioning (2). **Acceptance met.**
- [x] **P4C.4 Agent-driven reconciliation (propose).** (2026-06-13) `_ReconcileTenantDoc`
  (`features/company-docs/reconciliation.logic.ts`) runs the 3-way merge (base = tenant's
  `lastReconciledVersion`, ours = current company version, theirs = `TenantWorkspaceDoc.content`),
  guards the output with the L0 sandbox, and upserts a pending `DocMergeProposal` keyed by
  (tenant, docName, targetVersion) → **idempotent/resumable**; `up-to-date` fast-exit when the
  cursor already matches. `POST /:name/reconcile`. Tests: 3 reconcile-outcome + merge cases.
  **Acceptance met.** ⚠️ **Seam:** the merge engine is the dependency-free `_DeterministicReconciler`
  (company-wins + tenant-addition preservation); the locked **LiteLLM agent-driven** merge is the
  swap-in at `_BuildDocMergeReconciler` (`core/personalisation/reconciler.ts`) — needs a live model
  endpoint, so its quality upgrade is deferred (the orchestration is final).
- [x] **P4C.5 Approval + delivery + agent awareness.** (2026-06-13) `_DecideProposal` approve/reject
  API (`POST /:name/proposals/:id/{approve,reject}`); on approval the merged content is written to
  `TenantWorkspaceDoc` and the cursor advances **in one transaction** with the status flip. Delivery:
  the internal contract endpoint emits approved L2 docs as **version-gated `managedDocs`**, and the
  entrypoint (`apps/tenant/deploy/entrypoint.sh`) writes a doc only when its version exceeds a per-doc
  marker — so an approved reconciliation lands **without a pod restart** while the tenant's live in-pod
  edits between bumps are **preserved** (distinct from TOOLS.md, which is platform-owned and re-applied
  every poll). Reject leaves the tenant doc untouched. Tests: approve/reject/already-decided/missing (4).
  **Acceptance met.** Minor follow-up: explicit change-diff surfacing to the agent (a `HEARTBEAT.md`
  note) is deferred — the agent sees the new doc content, not yet a separate diff note.

---

### Track MI — Native multi-instance (single-cluster) support

> Scoped 2026-06-14 from `opencrane-multi-instance-brief.md` (WeOwnAI/Elewa). Goal: run **N
> strictly-isolated OpenCrane instances in one cluster** (one per customer org, each its own
> namespace, no shared data / no cross-namespace reconcile / no shared cloud creds) as a
> first-class **opt-in** mode. **Decision (2026-06-14):** keep the legacy single-install path as
> the **default**; multi-instance is an opt-in `multiInstance` Helm mode (per brief §4). "Avoid
> leaving any legacy" = no dead/half-migrated codepaths within each item, NOT removal of
> single-install. Verified against the code (Explore sweep, 2026-06-14): all six brief blockers
> (B1–B6) CONFIRMED, plus misses noted below.
>
> **Answers to the brief's open questions (Q1–Q4):**
> - **Q1 (other hidden cluster/namespace assumptions):** YES, beyond B1–B6 — (i) **control-plane
>   RBAC is also a ClusterRole** (`control-plane-rbac.yaml`), incl. a `clusterissuers` grant
>   (CONN.8 platform-dns); (ii) the **policy operator** watches cluster-wide too when
>   `WATCH_NAMESPACE` is empty (`policies/operator.ts`), not just the idle-checker; (iii)
>   control-plane writes CRs to a single `process.env.NAMESPACE ?? "default"`
>   (`routes/tenants.ts`, `auth.router.ts`); (iv) platform-dns get/create/replaces a **cluster-wide
>   ClusterIssuer** by a fixed name + writes DNS-01 creds into a shared `cert-manager` ns
>   (`core/platform-dns/`); (v) a **hard-coded, non-templated `opencrane-obot` Secret name**
>   (`obot-mcp-gateway-deployment.yaml`) and `opencrane-system` service-URL defaults in
>   `operator/config.ts` (the Helm layer overrides the URLs via release-prefixed `printf`, so the
>   URL default is a latent footgun, not an active collision). **Not blockers:** the
>   `tokenreviews` ClusterRole (skill-registry/control-plane) is *legitimately* cluster-scoped
>   (TokenReview cannot be namespaced) and grants no cross-namespace data; **Postgres / LiteLLM /
>   skill-registry / Obot are per-Helm-release** (release-prefixed names, own `DATABASE_URL`), so
>   they are instance-local by default — the brief's "shared" risk is real only if an operator
>   deliberately points two instances at one endpoint (covered by MI.5's scope declaration).
> - **Q2 (CRD singleton / per-instance API group):** "one CRD version, many instances" is the
>   right fleet contract — do NOT per-instance the API group. Decouple CRD install from the release
>   and publish a CRD-version ↔ control-plane/operator compatibility matrix (MI.3).
> - **Q3 (share vs isolate per component):** default **everything instance-scoped** (already true
>   by release-prefixing); make sharing an explicit, documented opt-in per component (MI.5). The
>   only naturally-shared cluster singletons are CRDs (MI.3) and, optionally, a platform cert
>   issuer (MI.4).
> - **Q4 (upstream vs vendored overlay):** delivered here as an upstream opt-in `multiInstance`
>   mode + a reference example (MI.7), so it is supported, not patched locally.

- [x] **MI.1 `multiInstance` Helm scaffold + namespaced operator RBAC (B1) + fail-closed watch (B2). — LANDED 2026-06-14.**
  New `multiInstance` values block (`enabled`/`instanceNamespaces`/`rbac`/`requireWatchNamespace`,
  default off → legacy unchanged). `operator-rbac.yaml` branches: multi-instance renders a
  namespaced **Role + RoleBinding per `instanceNamespaces`** (SA subject in the release ns) so
  instance A's operator SA cannot touch instance B; legacy keeps the ClusterRole/ClusterRoleBinding.
  Shared rules + helpers in `_helpers.tpl` (`opencrane.operatorRbacRules`/`instanceNamespaces`/
  `namespacedRbac`) — no rule duplication. Operator fails closed (`config.ts` `requireWatchNamespace`
  + `REQUIRE_WATCH_NAMESPACE` env, wired in `operator-deployment.yaml`): refuses to start with an
  empty `WATCH_NAMESPACE` when set. Tests: 4 operator config cases (operator 66/66); `helm template`
  validated for both modes + full chart. Anchors: `operator-rbac.yaml`, `_helpers.tpl`,
  `operator-deployment.yaml`, `apps/operator/src/config.ts`, `values.yaml`.
- [x] **MI.2 Namespaced control-plane RBAC + per-instance CR-write namespace (B1, control-plane half). — LANDED 2026-06-14.** Namespaced Role/RoleBinding branch in `control-plane-rbac.yaml` (shared `opencrane.controlPlaneRbacRules` helper); cluster-scoped `clusterissuers` isolated in a minimal residual ClusterRole (folded into the per-ns Role by MI.4's namespaced issuer). Per-instance CR writes needed no code change — the control-plane Deployment already sets `NAMESPACE` from `fieldRef: metadata.namespace`. Build + 193 tests green; helm both modes.
  Mirror MI.1 for `control-plane-rbac.yaml` (Role/RoleBinding over `instanceNamespaces` when
  `multiInstance` on; reuse the MI.1 helpers) and make the control-plane write Tenant/AccessPolicy
  CRs to a **per-instance** namespace (today `process.env.NAMESPACE ?? "default"` in
  `routes/tenants.ts` + `infra/auth/auth.router.ts`) so two instances never collide on CR
  (namespace,name). **Note:** the control-plane ClusterRole also grants `clusterissuers` — coordinate
  with MI.4 (that grant becomes a namespaced Issuer permission there). **Acceptance:** instance-A's
  control-plane SA cannot read/write instance-B objects; CRs land in the instance's own namespace;
  `helm template` both modes + a control-plane test. Anchors: `control-plane-rbac.yaml`,
  `routes/tenants.ts`, `infra/auth/auth.router.ts`, `_helpers.tpl`. **Headless-buildable.**
- [x] **MI.3 CRD decoupling + fleet version-compat contract (B3). — LANDED 2026-06-14.** Documented `--skip-crds` for per-instance releases + install-once `kubectl apply -f platform/helm/crds/` (no CRD sub-chart, to avoid duplicating 504 lines of CRD YAML = drift hazard). New `docs/multi-instance.md` carries the CRD-version↔chart compat matrix + "CRDs lead, instances follow; expand before contract" rule; one API group (Q2). Default single-install still auto-ships CRDs. Original scope: install CRDs **once, cluster-wide**,
  decoupled from the per-instance release: document `--skip-crds` + a separate CRD install step (or a
  tiny CRD-only sub-chart), and publish a **CRD-version ↔ control-plane/operator compatibility
  matrix** so the fleet can plan rolling upgrades ("one CRD version, many instances"). Do NOT
  per-instance the API group. **Acceptance:** two releases install with `--skip-crds` against a
  pre-installed CRD set without ownership conflict; the compat contract is documented.
  Anchors: `platform/helm/crds/`, `Chart.yaml`, a new `docs/multi-instance.md`, `values.yaml`.
  **Headless-buildable** (the install-once flow is `helm template`/doc-validated; the two-release
  apply is part of MI.7).
- [x] **MI.4 Namespaced cert Issuer + SecretStore + per-instance platform-DNS (B4). — LANDED 2026-06-14.** `multiInstance.certIssuer`/`secretStore` toggles render namespaced Issuer/SecretStore (verified ClusterIssuer→Issuer, ClusterSecretStore→SecretStore); platform-DNS targets a per-instance issuer + writes DNS-01 creds into the instance ns; RBAC reconciled with MI.2. Build + 193 tests (+6 platform-dns) green; helm both modes. (Live ACME = CONN.8(d) seam.) Original scope: Add a values
  toggle so `cluster-issuer.yaml` can render a namespaced **Issuer** (not ClusterIssuer) and
  `external-secrets-store.yaml` a namespaced **SecretStore** (not ClusterSecretStore) under
  `multiInstance`; OR document a deliberately-shared platform issuer installed once. Make the
  control-plane platform-DNS path (`core/platform-dns/`, `routes/platform-dns.ts`) target a
  **per-instance issuer name** + write DNS-01 creds into the **instance's own namespace** (today it
  upserts a fixed cluster-wide ClusterIssuer + shared `cert-manager` ns → last-write-wins across
  instances). **Acceptance:** two instances issue certs without fighting over one issuer/cred Secret;
  `helm template` both modes + platform-dns tests. Anchors: `cluster-issuer.yaml`,
  `external-secrets-store.yaml`, `core/platform-dns/`, `routes/platform-dns.ts`,
  `control-plane-rbac.yaml` (clusterissuers grant). **Headless-buildable** (live ACME e2e stays the
  CONN.8(d) seam). **Overlaps MI.2** on `control-plane-rbac.yaml`.
- [x] **MI.5 Per-component scope declaration + eliminate hard-coded names (B5). — LANDED 2026-06-14.** New `sharedPlatform` block (litellm/skillRegistry/mcpGateway/externalSecrets, `instance` default | `shared` opt-in, fail-fast guards); release-prefixed the non-templated `opencrane-obot` Secret + a second collision it caught (plain `litellm` Service); `config.ts` `opencrane-system` defaults now derive from `POD_NAMESPACE`. Build + 68 operator tests (+2) green; helm instance+shared modes. Original scope: Add a
  `sharedPlatform` values block declaring each platform component **instance** (default) vs
  **shared** (`litellm`/`skillRegistry`/`mcpGateway`/`externalSecrets`), with the isolation
  implication documented. Fix the concrete collisions the sweep found: the **non-templated
  `opencrane-obot` Secret name** (`obot-mcp-gateway-deployment.yaml` → release-prefix it) and the
  `opencrane-system` service-URL defaults in `apps/operator/src/config.ts` (make them
  release-namespace-aware / required, no silent cross-instance default). **Acceptance:** no
  fixed-name object collides across two same-namespace-family installs; each component's scope is a
  documented toggle; `helm template` both modes + an operator config test. Anchors: `values.yaml`,
  `obot-mcp-gateway-deployment.yaml`, `litellm-deployment.yaml`, `skill-registry-deployment.yaml`,
  `external-secrets.yaml`, `apps/operator/src/config.ts`. **Headless-buildable.**
- [x] **MI.6 Cross-instance default-deny NetworkPolicy (B6). — LANDED 2026-06-14.** New opt-in `networkpolicy-multi-instance.yaml`: per-namespace default-deny (Ingress+Egress) allowing only same-instance namespaces (via the apiserver-managed `kubernetes.io/metadata.name` label — no custom label needed) + DNS egress. Renders only in multi-instance mode (verified absent by default). Original scope: Ship, as part of `multiInstance` mode,
  a **default-deny across instance namespaces** so instance-A pods can never reach instance-B
  services (today `networkpolicy.yaml`/`networkpolicy-planes.yaml` are per-tenant *within* an
  install, with no cross-instance boundary). Allow only same-instance + required egress.
  **Acceptance:** a synthetic policy denies cross-namespace ingress between instance namespaces;
  `helm template` renders it only in multi-instance mode. Anchors: `networkpolicy.yaml`,
  `networkpolicy-planes.yaml`, `values.yaml`. **Headless-buildable** (live CNI enforcement is part
  of MI.7).
- [x] **MI.7 Reference example + conformance test (brief §5). — LANDED 2026-06-14 (static halves).** Shipped `platform/helm/values/multi-instance/{oc-acme,oc-globex}.yaml` + `platform/tests/multi-instance-conformance.sh` — renders both instances from one chart and asserts (all PASS): per-instance fail-closed watch scope, namespaced RBAC with no cross-instance ClusterRole (only the legit TokenReview), no ClusterIssuer/ClusterSecretStore, cross-instance default-deny netpol, no other-instance references. The **live two-instance cluster run** (§5.2–§5.5: dueling-operator, RBAC `can-i` deny, pod→service deny, teardown isolation) is documented in the script as the **live-infra seam** (needs a real cluster + CNI + ACME). Original scope: Ship `values/multi-instance/{oc-acme,oc-globex}.yaml`
  + a conformance script asserting the 5 acceptance criteria: two instances install (CRDs once);
  each operator reconciles only its own ns; instance-A SA cannot touch instance-B (RBAC); a pod in
  A cannot reach a service in B (NetworkPolicy); tearing down B leaves A untouched. **Depends on
  MI.1–MI.6.** The static halves (values + `helm template`/RBAC-can-i assertions) are buildable; the
  live two-instance cluster run is the **live-infra seam** (needs a real cluster + CNI + ACME).
  Anchors: new `platform/helm/values/multi-instance/`, `platform/tests/`, `docs/multi-instance.md`.


---

## Phase 4 — original spec, reality-check & locked decisions (archived 2026-06-15 from plan.md)

## Phase 4: Fleet Organizational Awareness + MCP & Skills Platform

### Architecture Checkpoint: Uniform Awareness Across All OpenClaws

1. **Awareness Control Model**
   - Retrieval stays direct from OpenClaw/Clawdbot to Cognee.
   - Control-plane remains the authority for dataset membership and permission grants only. This needs to be integrated with Cognee so Cognee can ensure Clawdbot access is secure.
   - No control-plane retrieval proxy is reintroduced.

2. **Uniform Awareness Contract**
    - Adopt a hybrid uniform-awareness contract model:
       - Declarative contract schema as source of truth (query rewrite policy, dataset scope selection, citation requirement, fallback behavior, freshness policy).
       - Shared OpenClaw SDK as the execution engine so behavior is consistent across all tenant runtimes.
       - Control-plane served effective-contract endpoint for per-scope delivery (org/department/project/personal), cached client-side by contract ID.
    - Use explicit SemVer for contract compatibility:
       - Major for breaking behavior/response changes.
       - Minor for additive capabilities.
       - Patch for non-breaking fixes.
    - Roll out with operational safeguards:
       - Tenant-cohort canary progression (personal -> project -> department -> org).
       - Optional shadow-mode diffing before cutover.
       - Contract-ID pinning and one-step rollback to the previous known-good contract.

3. **Org Knowledge Fabric Scope**
   - Build one normalized organization index model shared across all connectors.
   - Standardize document lineage metadata (source, owner, ACL origin, freshness markers, ingest cursor).
   - Keep source systems as SoR; Cognee remains orchestration/storage.

4. **Policy and Freshness Enforcement Plane**
   - Enforce policy at write-time (dataset assignment) and read-time (OpenClaw post-filter checks where needed).
   - Freshness/invalidation logic is centralized as reusable OpenClaw behavior, not bespoke prompt rules.
   - Define stale-data fallback UX and reason codes.

5. **MCP & Skills Platform (Config-Slaved Ingress Planes)**
   - Replace the policy-only MCP Server Plane and the shared-PVC skill mount with two config-slaved ingress service planes, both governed by the control-plane as sole authority.
   - **Obot MCP Gateway** — in-cluster MCP registry + gateway (runtime tool broker). Headless, admin disabled, config-slaved via operator reconcile.
   - **Skill Registry & Delivery** — org-aligned skill management over OCI/ORAS (Zot) with per-read entitlement enforcement.
   - Tenant→plane auth = projected ServiceAccount token, audience-bound (`aud=obot-gateway` / `aud=skill-registry`), ~600s TTL, kubelet-rotated. Delete the predictable `OPENCLAW_GATEWAY_TOKEN`.
   - MCP downstream secrets live only in Obot (central broker, confirmed); never reach a pod.
   - Skill substrate = build thin over OCI/ORAS + Cognee (confirmed); not a ClawHub fork.
   - Two clocks: revocation effective on next gateway call / next pull (fail-closed); new grants usable after next contract re-pull (eventually-consistent).
   - Remove legacy wiring — no duplicate failover paths, single clean architecture.
   - Full specification in `mcp-skills-platform-brief.md`.

6. **Skills Sharing and Participation Protocol**
   - Define a fleet-wide skills-sharing model with explicit hierarchy: org, department, project, personal.
   - Support controlled promotion and demotion between scopes (personal -> project -> department -> org and reverse) with policy checks and audit trail.
   - Every promoted or demoted skill remains versioned and immutable by digest; no in-place mutation.
   - Define a protocol every OpenClaw participates in: advertise capabilities, request shared skills, attest policy context, emit execution outcome events.
   - Control-plane monitors protocol participation health, policy compliance, and rollout version drift.
   - Prefer existing protocols first: OpenClaw skill folder format plus OCI Distribution for bundle transport/versioning.

7. **Control-Plane MCP & Skill Management Surfaces**
   - **MCP server management:** full lifecycle CRUD for MCP servers; `McpServer`, `McpServerGrant`, `McpServerCredential` data models; per-scope entitlement via the shared 5-level compiler; config + grants pushed to Obot MCP Gateway via operator reconcile.
   - **Skill catalog, sharing & promotion:** replace filesystem-only `skillsRouter` with registry-backed catalog; `SkillBundle` (immutable, OCI digest-pinned), `SkillEntitlement`, `SkillPromotion` models; Cognee-backed semantic search; promotion/demotion workflow with admin review.
   - **Third-party source installation:** `ThirdPartySource` and `ThirdPartySourceItem` models; support MCP Server Registry, Anthropic skills, ClawHub (future), custom Git repos, manual upload; security-critical ingest pipeline (fetch → scan → validate → register → entitle → audit); auto-sync via CronJob (discover only, install requires explicit admin action).

8. **Effective-Contract Integration (MCP + Skills)**
   - Extend `runtimeContract` with `gateway`, `mcp.servers` (compiled grant), `skills.entitled` (index with name, scope, version, digest), `contractVersion`.
   - `GET /api/tenants/:name/effective-contract` compiles MCP + skill grants by evaluating all entitlement records matching the tenant's org hierarchy position.
   - Pod re-pulls contract at agentic-loop boundaries; diffs entitled set; pulls new bodies, drops de-entitled; refreshes discovery index.
   - Entitlement-scoping is security-critical: registry is the boundary (not the contract); existence-hiding (404 not 403); no list/search verb on pod-facing delivery endpoint; audit every out-of-scope attempt.

**Action**: Deliver a single organizational-awareness layer that every OpenClaw instance consumes identically, with direct Cognee retrieval, centrally managed permissions, and two config-slaved ingress planes for MCP and skills.

---

### Deliverables

1. **Org Context SDK For OpenClaw Fleet**
   - Shared OpenClaw package that wraps retrieval, reranking, citation shaping, and freshness checks.
   - Required in every tenant runtime so awareness behavior is uniform by default.
   - Feature-flagged rollout controls per tenant cohort.

2. **Awareness Policy Compiler**
   - Compile AccessPolicy + dataset membership into Cognee grants and OpenClaw runtime hints.
   - Emit deterministic policy snapshots with version IDs for audit and rollback.

3. **Organization Index Schema v2**
   - Add canonical metadata fields for org semantics (department, project, confidentiality, jurisdiction, retention class).
   - Add connector conformance validation so all sources produce uniform metadata shape.

4. **Fleet Evaluation Harness**
   - Golden query suite for organizational awareness quality (correctness, policy safety, citation quality, freshness).
   - Regression gate in CI before awareness-contract changes can be promoted.

5. **Observability and SLOs**
   - Awareness SLOs: permission-violation rate, stale-answer rate, citation coverage, p95 retrieval latency.
   - Per-tenant and fleet-wide dashboards with alerting for policy or freshness regressions.

6. **Skills Sharing Mesh and Protocol Runtime**
   - Implement a shared-skills participation protocol for OpenClaws with versioned message contracts.
   - Add control-plane visibility endpoints for protocol heartbeats, skill bundle distribution status, and policy-compliant execution traces.
   - Add kill-switch and scoped rollout controls for protocol versions.

7. **Hierarchical Skill Registry (Protocol-First)**
   - Replace filesystem-only skill sharing with a registry-backed distribution model while preserving local cache for runtime startup during migration.
   - Skill content standard: OpenClaw SKILL.md bundle format with frontmatter metadata validation.
   - Distribution/versioning standard: OCI artifacts (semver tags + immutable digest pinning).
   - Promotion and demotion are metadata operations over immutable versions (scope grants move, artifact stays unchanged).
   - After protocol cutover criteria pass, remove legacy filesystem-only sharing paths and keep filesystem usage as pull-through cache only.

8. **Obot MCP Gateway (Config-Slaved Ingress)**
   - Deploy Obot headless with native admin disabled and IdP bound to central OIDC.
   - Operator reconciles config + MCP server registries; drift-detects/repairs.
   - Per-call scope check via projected JWT (`aud=obot-gateway`).
   - Downstream credential brokering via RFC 8693 shim; secrets never reach tenant pods.
   - NetworkPolicies restrict tenant pods to gateway ingress only (no path to Obot DB).

9. **Skill Registry & Delivery Service (Config-Slaved Ingress)**
   - New in-cluster ingress service over OCI/ORAS (Zot) for scoped skill content delivery.
   - Entitlement enforced per read; pod-facing endpoint supports only `get-by-entitled-digest` (no list/search).
   - Existence-hiding: non-entitled lookups return 404, not 403.
   - Ingest/scan pipeline: Trivy/Grype on every ingest; flagged items quarantined.
   - NetworkPolicies restrict tenant pods to delivery ingress only (no path to OCI store).

10. **Control-Plane MCP & Skill Management**
    - MCP server lifecycle CRUD with per-scope entitlement grants via 5-level compiler.
    - Skill catalog with registry-backed authoring, promotion/demotion workflow, and Cognee-backed search.
    - Third-party source management: upstream registry sync, security-critical ingest pipeline, explicit admin-only installation.
    - Config + grant push to both planes via operator reconcile path.

11. **Projected-Token Identity Migration**
    - Replace `OPENCLAW_GATEWAY_TOKEN` with audience-bound projected ServiceAccount tokens (~600s TTL, kubelet-rotated).
    - Set tenant SA audiences for both planes (`aud=obot-gateway`, `aud=skill-registry`).
    - Extend effective-contract with `mcp.servers`, `skills.entitled`, and `contractVersion`.

12. **Central Per-Tenant Scheduler**
    - Central scheduler owns schedule + governance; dispatches jobs as tenant identity via projected-token path.
    - Claws do not self-schedule; schedules survive pod suspension and restarts.
    - Wake/dispatch path guarded: job-scoped token, audited, no broad impersonation.

13. **Control-Plane Admin Surface (API + CLI)**
    - Every Obot/MCP/skill admin action reachable via the published API + `oc` CLI.
    - UI parity (if desired) is an external-consumer concern; `apps/control-plane-ui` was removed from this repo in Phase 5.

### Current Implementation Progress

> **Reconciled against code 2026-06-10.**

- [x] Org index schema v2 metadata fields: department/project scope, confidentiality, jurisdiction, retention class, ACL lineage, freshness markers, ingest cursor tracking.
- [x] Slack harvesting emits lineage/freshness metadata; ingestion rejects non-conformant org index records.
- [x] Projected-token migration: `aud=obot-gateway` and `aud=skill-registry` implemented in `apps/operator/src/tenants/deploy/3-deployment.ts`.
- [x] Real grant compilation: `apps/control-plane/src/core/grants/grant-compiler.ts` (scope precedence: priority → deny-over-allow → newest). `GET /tenants/:name/effective-contract` compiles Awareness/McpServer/SkillBundle grants. The `mcp.servers`/`skills.entitled` fields in `2-config-map.ts` are **intentionally advisory stubs** — authoritative grant is the effective-contract endpoint.
- [x] Control-plane MCP/Skills/third-party management surface: Prisma models + CRUD routes (`routes/mcp-servers.ts`, `routes/skill-catalog.ts`, `routes/third-party-sources.ts`) + `GET /tenants/:name/effective-contract` in OpenAPI spec.
- [⛔] ~~Control-plane UI Phase 4 slice~~ — removed by Phase 5; admin surfaces are API + `oc` CLI only.
- [ ] Connector rollout beyond Slack blocked on open Phase 4 connector-adoption and department-scope decisions.

### Phase 4 Reality Check (Current Gaps)

- [x] **Obot MCP Gateway deploy is real** (verified 2026-06-10). `obot-mcp-gateway-deployment.yaml` runs `ghcr.io/obot-platform/obot` with a PostgreSQL DSN and real `OBOT_SERVER_*` env, wired to poll `/api/internal/obot-registry`. `ObotHealthChecker` in `apps/operator/src/mcp-gateway/` monitors availability. **Remaining: `aud=obot-gateway` projected-token validation + RFC 8693 downstream-credential brokering not yet proven — fold into P4A.3.**
- [x] **Skill Registry & Delivery service is built** (verified 2026-06-10). `apps/skill-registry/`: `aud=skill-registry` projected-token validation via Kubernetes TokenReview, get-by-digest only, existence-hiding 404s, per-read entitlement via `/api/internal/bundles/:digest/content`. **Note:** content served from control-plane DB, not yet OCI/ORAS-over-Zot. **Trivy/Grype scanning not implemented — P4A.1.**
- [~] Operator drift repair: management/grant layer + Obot catalog sync are in place, but no path reverts manual edits to Obot or skill-registry config — detect-only, DB-projection-scoped. **P4A.2.**
- [x] Control-plane MCP/skills CRUD and third-party ingest routes implemented; entitlement enforced at registry boundary. Residual: ingest scanning (P4A.1).
- [⛔] ~~Control-plane frontend CRUD/install flows~~ — out of scope after Phase 5 UI removal.
- [x] Helm manifests/NetworkPolicies/CRDs for both ingress planes scaffolded under `platform/helm/`.
- [ ] Fleet-awareness track — not started.

### Key Tasks (Phase 4)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| Org Context SDK shared package | Backend | 20h | Phase 3 memory cutover |
| Awareness contract + versioned rollout controls | Backend | 14h | SDK baseline |
| AccessPolicy compiler to Cognee grants + runtime hints | Backend | 18h | Dataset membership APIs |
| Org index schema v2 + connector conformance checks | Backend | 20h | Harvesting foundation |
| Fleet evaluation harness (golden queries) | QA + Backend | 18h | SDK + schema v2 |
| Awareness SLO dashboards and alerts | DevOps + QA | 14h | Telemetry instrumentation |
| Skills sharing protocol runtime + schema | Backend | 16h | Org Context SDK + skill allowlist model |
| Control-plane protocol monitoring + dashboards | Backend + DevOps | 10h | Protocol runtime telemetry |
| Hierarchical scope promotion/demotion workflow + audit trail | Backend | 10h | Skills sharing protocol runtime |
| OCI-based skill registry sync (digest pinning + rollout policy) | Backend + DevOps | 6h | Hierarchical scope model |
| Projected-token identity migration (remove `OPENCLAW_GATEWAY_TOKEN`, SA audiences) | Backend | 10h | Phase 3 tenant SA baseline |
| Effective-contract extension (`mcp.servers`, `skills.entitled`, `contractVersion`) | Backend | 12h | Projected-token identity |
| MCP server management routes + data model (`McpServer`, `McpServerGrant`) | Backend | 14h | Effective-contract extension |
| Skill catalog routes + data model (`SkillBundle`, `SkillEntitlement`, `SkillPromotion`) | Backend | 16h | OCI-based skill registry |
| Third-party source management routes + ingest pipeline | Backend | 14h | MCP server + skill catalog routes |
| 5-level permission compiler (shared by MCP + skills + awareness) | Backend | 12h | AccessPolicy compiler baseline |
| Obot MCP Gateway deployment (headless, config-slaved, drift-repaired) | Backend + DevOps | 14h | MCP server management routes |
| Skill Registry & Delivery service (OCI/ORAS + entitlement enforcement) | Backend + DevOps | 16h | Skill catalog routes |
| Helm templates + NetworkPolicies for both ingress planes | DevOps | 10h | Gateway + registry deployment |
| CRDs: `MCPServer`, `ObotConfig`, `SkillBundle`, `SkillRegistry`, `Schedule` | Backend + DevOps | 8h | Phase 3 CRD baseline |
| Central per-tenant scheduler (dispatch as tenant identity) | Backend | 12h | Projected-token identity |
| Tenant-cohort canary rollout and rollback playbook | DevOps | 10h | Feature flags + evaluation harness |
| **Phase 4 Total** | | **324h** | |

### Success Criteria

- [ ] Every OpenClaw uses the same awareness SDK and contract version by default.
- [ ] Retrieval remains direct to Cognee with no control-plane retrieval mediation path.
- [ ] AccessPolicy updates propagate to Cognee grants within defined SLO.
- [ ] Golden query suite passes for correctness, policy safety, freshness, and citation quality.
- [ ] Fleet dashboards expose awareness SLOs with alert thresholds and runbook links.
- [ ] Canary rollout path can promote and rollback awareness contract versions without tenant downtime.
- [ ] Shared skills are discoverable and consumable across allowed scopes using a single fleet protocol.
- [ ] Control-plane can monitor per-tenant protocol participation, drifted versions, and policy-violating skill executions.
- [ ] Skills support org, department, project, and personal scopes with policy-controlled promotion and demotion flows.
- [ ] Every deployed skill is versioned and pinned by immutable artifact digest, with rollback to prior versions supported per scope.
- [ ] Legacy filesystem-only sharing paths are removed after protocol cutover; only registry-backed distribution with optional pull-through cache remains.
- [ ] Tenant pods authenticate to both planes via projected ServiceAccount tokens only; no static bearer tokens remain.
- [ ] A tenant cannot obtain or read another tenant's gateway/downstream token (no shared/guessable credential anywhere).
- [ ] Tenant pod filesystem/env contains no MCP downstream secret; secrets live only in Obot token store.
- [x] A tenant pod cannot enumerate or pull any skill outside its compiled entitlement. **Verified: skill-registry is get-by-digest-only, entitlement compiled per request, existence-hiding 404s, `aud=skill-registry` projected-token validation.**
- [~] Removing a grant denies the next MCP call / skill pull (audited) without a pod restart. **Grant compiler + effective-contract recompute exist; tenant-side re-pull loop unverified — P4A.3.**
- [~] Adding a grant becomes usable after the next contract re-pull, no restart. **Same — P4A.3.**
- [ ] Manual edits to either plane's config are reverted by operator drift reconcile. **Not met: detect-only — P4A.2.**
- [x] MCP servers are manageable via control-plane CRUD with per-scope entitlement grants.
- [~] Third-party MCP servers and skills installable via the ingest pipeline. **Register/entitle exists; scan step missing — P4A.1.**
- [ ] Skill catalog supports authoring, promotion/demotion with admin review, and Cognee-backed semantic search.
- [⛔] ~~Control-plane UI supports Obot config, MCP install, skill catalog/entitlements~~ — superseded by Phase 5. Re-scoped: every admin action reachable via API + `oc` CLI.
- [ ] Per-tenant schedules survive pod suspension and restarts; claws run no self-owned cron.
- [ ] All new code conforms to `AGENTS.md`.

> **Phase 4 status:** Track A complete (P4A.1–P4A.3). Track B greenfield and **decision-unblocked 2026-06-13** (P4B.0 closed; all Phase 4 Decisions resolved/defaulted) — build not yet started (~324h).

---

## Phase 4 Decisions (Lock Before Execution of Track B)

> All items below must be resolved before Track B implementation starts. Confirmed items are marked [x].
>
> **Triage (2026-06-13):** the MCP/skills-platform decisions are resolved (see P4-D + the [x]
> items below) and are in the next build cycle. The remaining `[ ]` items are all **Track B
> fleet-awareness** product decisions — deferred to a dedicated decision round (they are NOT in
> the P4-D cycle and are a separate ~324h track). Two further blockers are **external** (not
> resolvable here): CONN.3/B2 pairing-link + bootstrap-mint provisioning and B1 device-signature
> scheme — both need OpenClaw-contract facts.

- [x] Awareness SDK ownership model. **Single shared package `libs/awareness`, pinned to a contract version, consumed by every tenant runtime (2026-06-13).**
- [x] Contract version rollout strategy. **Tenant-cohort canary waves (personal→project→department→org) + optional shadow-mode + one-step contract-ID rollback (2026-06-13).**
- [x] Minimum required citation format. **Source title + URI/link to the system of record + freshness timestamp (2026-06-13).**
- [x] Fleet SLO thresholds. **"Standard": p95 retrieval < 1s; re-fetch when memory > 24h stale; policy-violation rate = 0 (hard gate + alert) (2026-06-13).**
- [x] Connector conformance bar for org index schema v2. **Hard gate at ingest — reject non-conformant records (missing lineage/ACL-origin/freshness/scope) (2026-06-13).**
- [x] Skills sharing scope rules + precedence. **Most-specific-wins (personal〉project〉dept〉org), deny-overrides-allow at a tie — matches the grant compiler (2026-06-13).**
- [x] Protocol transport + delivery guarantees for claw participation events. **Over the control-plane API, at-least-once + idempotency keys, `aud=control-plane` projected token (no new bus). Claws learn the protocol via the pinned `libs/awareness` SDK + versioned effective-contract (re-pull plumbing) and advertise capabilities via an A2A-style "Agent Card" manifest (researched 2026-06-13). (security: events carry no secrets.)**
- [x] Monitoring severity model. **Policy-violating skill execution = critical/page; non-participation or version drift = warning (dashboard/digest, no page) (2026-06-13).**
- [~] Department scope vs team scope. **Keep both as distinct levels in the model, but allow `team` and `department` to alias the same group initially and split later (no forced migration up front) (2026-06-13).**
- [x] Promotion/demotion authorization + approvers. **Each scope node (org/department/team/project) has one or more **owners**; a promotion/demotion request must be approved by the owner(s) of the relevant scope. Needs an `owners` (multi-owner) concept per scope node (2026-06-13).**
- [x] OCI artifact naming, tagging, and digest pinning policy for skill versions. **`skills/<scope>/<name>:<semver>@<digest>` (2026-06-13).**
- [x] MCP credential custody: central broker (Obot holds downstream creds; pod never receives them). **Confirmed.** Mechanism (2026-06-13): **per-user RFC 8693** token exchange + static per-tenant/per-server fallback for non-OBO upstreams; encryption-at-rest = K8s-Secret-backed key. (P4D.1)
- [x] Skill substrate: build thin over OCI/ORAS + Cognee (not a ClawHub fork). **Confirmed.**
- [~] Obot MCP Gateway version and deployment topology (single replica vs HA). **Default (2026-06-13): single replica dev / HA via values prod.**
- [x] Skill registry OCI store: Zot vs alternative OCI-compliant registry. **Zot (2026-06-13).** (P4D.2)
- [~] Third-party source auto-sync interval defaults and rate-limit policy. **Default (2026-06-13): conservative interval, discover-only (install requires explicit admin action).**
- [~] Scheduler dispatch identity model: job-scoped token TTL and audience. **Default (2026-06-13): job-scoped token, ~600s TTL, dedicated audience.**
- [x] ClawdBot bootstrap injection content review and sign-off. **Governed by the P4-C L0/L1/L2 doc layering + propose-and-approve (no separate process; no silent prompt changes) (2026-06-13).**

---


---

## Active-track landed detail (archived 2026-06-15 from plan.md)

> Full landed-item detail for the still-open tracks P4-B and CONN; their plan.md entries were
> collapsed to one-line summaries. Open/remaining work stays in plan.md.

### P4B.0–P4B.6 done items

- [x] **P4B.0 Lock Phase 4 awareness decisions.** (2026-06-13) All "Phase 4 Decisions" below are
  now resolved (explicit) or defaulted — Track B is **decision-unblocked**. Key locks: single
  shared `libs/awareness` SDK · tenant-cohort canary rollout · citation = title+URI+timestamp ·
  Standard SLOs (p95<1s / 24h freshness / 0 policy violations) · hard ingest conformance gate ·
  most-specific-wins+deny-overrides scope precedence · participation over control-plane API +
  A2A Agent-Card advertisement · violation=page/drift=warn · per-scope-node owners approve
  promotions · bootstrap governed by P4-C layering. (Build is still greenfield, ~324h — see Key Tasks.)
- [x] **P4B.1 Org Context / Awareness SDK.** (2026-06-13) New shared lib `@opencrane/awareness`
  (`libs/awareness`, added to `pnpm-workspace.yaml`) every OpenClaw consumes. `AwarenessClient.query`
  retrieves org context **directly from the per-tenant Cognee** via an injectable
  `CogneeSearchTransport` (default `fetch` → Cognee `/v1/search`) — no control-plane in the query
  hot path (the acceptance criterion). Two fleet invariants enforced: (1) every returned hit carries
  a complete **citation** (title + URI + freshness, the P4B.0 locked format) — uncitable hits are
  dropped and counted (`droppedUncitable`), never surfaced unattributed; (2) every result is stamped
  with the pinned `AWARENESS_CONTRACT_VERSION` (`awareness/v1alpha1`), and `___AssertContractCompatible`/
  `___IsContractCompatible` (same-major) give P4B.3's canary/rollout its version-skew hook. Tests:
  citation (4) + contract-version (3) + client incl. drop-uncitable / direct-endpoint / default
  transport (6) = 13; lib build + tests clean. **Seam:** wiring the SDK into the live OpenClaw pod
  runtime (skill/sidecar) + live Cognee `/v1/search` is the remaining live-infra step — the SDK is
  the testable core and is consumption-ready.
- [x] **P4B.2 AccessPolicy → Cognee grant compiler.** (2026-06-13) `core/grants/cognee-awareness-sync.ts`:
  `_SyncTenantAwarenessGrants` compiles a tenant's `Awareness` grants through the existing grant
  compiler (priority → deny-over-allow → newest) and PUTs the allow/deny decisions to Cognee
  (`/v1/permissions/tenants/:tenant/awareness-grants`), SLO-bounded (`COGNEE_PERMISSIONS_TIMEOUT_MS`,
  default 5s) via an injectable transport. `_PropagatePolicyToCognee` re-syncs affected tenants;
  wired into `routes/policies.ts` **create/update/delete** (delete resolves affected tenants
  *pre-delete*) — **best-effort: a Cognee outage never blocks the policy write** (Postgres is source
  of truth; next change / contract re-pull reconciles). `_ResolvePolicyAffectedTenants` resolves
  tenants from DB-resolvable selector criteria (`matchTeam` / `opencrane.io/team` / `opencrane.io/tenant`);
  arbitrary-label selectors aren't in the DB projection → resolved pod-side (operator effective-policy),
  logged not guessed. Tests: 7 (compile→push, failure-capture, selector resolution incl. team/name/
  non-resolvable/missing, propagation failure count); control-plane 130/130, build clean.
  ⚠️ **Verify (Cognee API seam):** the `/awareness-grants` endpoint + grant-level ACL shape are the
  assumed Cognee permissions API (mirrors the existing `/subjects` sync) — confirm against the live
  Cognee version; this is also where the **dataset-vs-node-set** question for P4B.7's hard-boundary
  upgrade gets answered.
- [x] **P4B.3 Awareness contract versioning + canary rollout.** (2026-06-13) Fleet rollout state
  machine: `core/awareness/rollout.ts` (pure) promotes a `targetVersion` across canary waves
  (`personal→project→department→org`, the locked order) via an advancing `promotedWaves` frontier
  while un-promoted waves stay on `stableVersion` — **no fleet downtime**; `_Rollback` clears the
  frontier in **one step**. `_ResolveAwarenessVersion` maps a tenant's `Tenant.awarenessWave`
  (null → final/most-conservative wave) to target-vs-stable, with optional **shadow mode**
  (promoted waves compute target, still serve stable). Singleton `AwarenessRollout` model + migration
  `0010`; shared `rollout-store.ts` load/save. **API + CLI** (CLI-first, see [[feedback_api_cli_first]]):
  `GET/PUT /api/v1/awareness/rollout`, `POST …/promote`, `POST …/rollback`, `GET …/resolve/:tenant`
  + `oc awareness rollout show|set|promote|rollback|resolve` (OpenAPI-spec'd, contracts/CLI types
  regenerated). **Delivery:** the internal contract endpoint resolves each tenant's version from the
  rollout and emits `awareness:{contractVersion,shadow,wave}` so a promotion/rollback reflects via the
  re-pull loop **with no pod restart**; the pod's `@opencrane/awareness` SDK refuses an incompatible
  major (`___AssertContractCompatible`). Control-plane now depends on `@opencrane/awareness` for the
  pinned default version. Tests: 9 engine (canary resolve / unassigned→final / shadow / promote-next /
  promote-to / rollback / normalize) + 4 route (default / set+400 / promote→resolve→rollback flow /
  error paths); control-plane 143/143, contracts + CLI build clean. **Acceptance met** (canary cohort +
  one-step rollback demonstrated). Live wiring of the pod SDK to consume `awareness.contractVersion`
  is the remaining seam (shared with P4B.1).
- [x] **P4B.4 Golden-query / eval harness.** (2026-06-13) `libs/awareness/src/eval/`: pure
  `___EvaluateGolden(result, golden, nowMs)` scores an `AwarenessResult` across the four locked
  dimensions — **citation** (no uncitable hits dropped), **policy-safety** (no hit from a dataset
  outside the principal's `allowedDatasets` — the hard gate), **freshness** (every source within the
  24h SLO, overridable; undatable fails), **correctness** (expected facts present, case-insensitive).
  `___RunGoldenSuite(client, goldens, nowMs)` runs each golden through the SDK and aggregates a
  `SuiteReport` (passed/failed/policyViolations/errors). `___SuiteGatesRollout(report)` encodes the
  **locked SLO severity**: the hard gate is **zero policy violations** (violation=page) **plus zero
  query errors** (an unevaluated golden = safety unverified = block); citation/freshness/correctness
  are reported quality **warnings** (drift=warn), surfaced in `failed`/`results` but non-blocking.
  Per-query errors are captured into a failed `GoldenResult` (not a whole-suite rejection). `nowMs`
  injected so freshness is deterministic/testable; future-dated sources tolerated (clock skew).
  Exported from the barrel. Tests: 6 conformance (per-dimension incl. freshness override +
  case-insensitive correctness) + 4 runner/gate (clean-open, policy-violation-shut,
  quality-fail-stays-open, query-error-shut); awareness lib 24/24, build clean.
  **Note:** correctness/freshness/citation are warnings per the locked `violation=page/drift=warn`;
  elevate correctness to a hard gate by tightening `___SuiteGatesRollout` if desired.
  **Acceptance met** (suite runs + gates rollout). **Seam:** authoring the real golden corpus +
  wiring `___RunGoldenSuite` into CI against a live (or fixtured) Cognee, and calling
  `___SuiteGatesRollout` from the P4B.3 `promote` path to block a failing promotion — needs the
  corpus + a CI job + live Cognee for true correctness scoring.
- [x] **P4B.5 Fleet participation protocol + monitoring.** (2026-06-13) The fleet-protocol layer:
  claws emit participation events over the **control-plane API** (the locked transport — at-least-once
  + idempotency keys, `aud=control-plane` projected token, no new bus). Internal ingest
  `POST /api/internal/awareness/participation` (`routes/internal/participation.ts`, TokenReview +
  tenant-from-identity like the contract endpoint — never body-supplied) handles three kinds:
  **AgentCard** (A2A capability advertisement), **SkillExecution** (`ok`/`policy-violation`),
  **Heartbeat** (running contract version). `_RecordParticipationEvent` dedups on
  `(tenant, idempotencyKey)` (P2002 → 200 idempotent ack) and advances a `TenantParticipation`
  rollup. **Monitoring:** `_BuildFleetParticipationReport` joins each tenant's rollup with the P4B.3
  rollout to derive its *expected* version and classifies severity via the pure `_ClassifyParticipation`
  — **policy-violation → critical** (page), **non-participation / version drift → warning** (the locked
  `violation=page / drift=warn` model). Admin `GET /api/v1/awareness/participation` (+ `?severity=`)
  + `oc awareness participation` (OpenAPI-spec'd, contracts/CLI regenerated). Models `ParticipationEvent`
  + `TenantParticipation` + migration `0011`. Tests: 4 classifier + 3 record (violation/dedup/agent-card)
  + 1 fleet-report + 5 internal-route (201/dup-200/auth/validation/malformed-subject) = 13; control-plane
  157/157, contracts+CLI clean. **Acceptance met** (participation + drift + policy-violation monitored).
  **Seam (cross-tenant skill discovery/consumption):** skills are already scope-entitled (catalog +
  registry + grant compiler); a tenant-facing "what skills are shared with my scopes" discovery query
  (most-specific-wins) is the remaining sub-item — leans on existing entitlement compilation. Live wiring
  of the SDK to *emit* these events from the pod is the shared P4B.1 seam.
- [x] **P4B.6 Fleet awareness dashboards + SLOs.** (2026-06-14) `/prom` now emits awareness SLO
  metrics: pure `_RenderAwarenessMetrics(report, rollout)` (`core/awareness/metrics.ts`) derives
  `opencrane_awareness_{tenants,participating,non_participating,drifted,policy_violations}_total`,
  a `tenants_by_severity{severity}` breakdown, and rollout frontier/info gauges from the P4B.5 fleet
  report + P4B.3 rollout; wired into `prometheus-metrics.ts` **best-effort** (a render failure logs +
  keeps core metrics). **Alerts:** `awareness-prometheusrule.yaml` (PrometheusRule, gated on
  `monitoring.enabled`) — `AwarenessPolicyViolations` → **page/critical** (locked: rate must be 0),
  `AwarenessVersionDrift` + `AwarenessNonParticipation` → **warning** (the locked `violation=page /
  drift=warn` model), each with a `runbook_url`. **Dashboard:** `files/awareness-dashboard.json` shipped
  via a Grafana-sidecar ConfigMap (`awareness-grafana-dashboard.yaml`, `grafana_dashboard` label).
  **Runbook:** `docs/runbooks/awareness-slos.md` (the alert link target). `monitoring` values block added.
  Tests: 5 metric-renderer; control-plane 162/162, build clean; `helm template` validated (PrometheusRule
  severities + runbook links, dashboard ConfigMap, full chart renders monitoring on **and** off).
  **Seam:** the **p95 retrieval-latency SLO (<1s)** is a *pod-side* metric (the SDK times retrieval) —
  not control-plane-derivable; emitting it from the pod + a `histogram_quantile` alert is the remaining
  piece, gated on the shared P4B.1 live-SDK-wiring seam.

---

### Track CONN block

### Track CONN — OpenClaw connection auth & session security (Option B)

> Scoped 2026-06-13. How the SaaS-operator browser reaches a tenant's OpenClaw pod
> gateway, brokered by the control plane. **Posture decided = Option B** — full A/B/C
> trade-off, threat model (MITM/airport, two-clocks, K8s force-disconnect) and the
> accepted compromises are in `docs/claw-security-considerations.md`.

**Locked decision (2026-06-13):** Option B — short-lived, re-brokered credentials
(no long-lived token in the browser) + a **per-user** central kill-switch (OpenClaw
`device.token.revoke`/`pair.remove` + Kubernetes force-disconnect), plus transport
hardening. Control plane stays *connection*-stateless. Per-session cutting and a
standing per-frame audit choke point are **not** in scope → that is the proxy
(CONN.7), deferred.

- [x] **CONN.1 Pairing-broker endpoint.** `POST /auth/pod-token` returns the pod's
  pairing link `{ gatewayUrl, bootstrapToken, tenant, ingressHost }` instead of the
  old `aud=openclaw` K8s-SA mint. `_ResolveOpenClawPairing` (`infra/auth/openclaw-pairing.ts`)
  reads `configOverrides.openclaw.{gatewayUrl,bootstrapToken}`, derives `wss://<ingressHost>`
  as fallback, returns `bootstrapToken:null` once paired. Session required; email→tenant
  resolution fail-closed on ambiguity. Tests: `auth-pod-token.test.ts` (7) +
  `openclaw-pairing.test.ts` (5); `tsc --noEmit` clean, 57/57 control-plane tests pass.
- [x] **CONN.2 Transport hardening (do regardless).** (2026-06-13) Dependency-free
  `_TransportSecurity` middleware (`infra/middleware/transport-security.middleware.ts`,
  wired first in `index.ts`) emits HSTS `max-age=63072000; includeSubDomains; preload` on
  forwarded-HTTPS responses and offers an opt-in (`OPENCRANE_FORCE_HTTPS`) 308 HTTP→HTTPS
  redirect for safe methods — off by default so internal plain-HTTP health probes are not
  bounced (ingress normally enforces TLS). `cookieSecure` is now `_resolveCookieSecure`
  (`infra/auth/oidc.config.ts`): explicit `OIDC_COOKIE_SECURE` wins, else **forced `true`
  in production** regardless of redirect-URI scheme, else inferred for dev. Broker
  `_ResolveOpenClawPairing` (`infra/auth/openclaw-pairing.ts`) now rejects any non-`wss://`
  stored gateway URL and falls back to `wss://<ingressHost>` (or null). Tests:
  `transport-security.test.ts` (6) + `oidc-config.test.ts` (3) + 2 added wss-guard cases;
  build + `tsc --noEmit` clean, 68/68 control-plane tests pass. (`__Host-` cookie prefix not adopted — it
  requires path `/` + no Domain and is deferred to CONN.6 doc review.) (security doc §10–§11)
- [ ] **CONN.3 Pairing-link provisioning + short bootstrap.** Populate
  `configOverrides.openclaw.{gatewayUrl,bootstrapToken}` when the operator provisions a
  tenant pod, and mint/rotate **single-use, ~30–60s** bootstrap tokens. Anchor: operator pod
  provisioning + `routes/tenants.ts`.
  - **Research (2026-06-13, docs.openclaw.ai/channels/pairing):** the setup code IS exactly
    `base64({ url, bootstrapToken })` — matches our broker shape ✅. Setup codes are minted by a
    **pairing command** (`/pair`-style; bot replies with the setup code), **not** emitted at
    gateway startup — so provisioning must *run the pairing flow* against the pod (likely an
    `openclaw devices`-family CLI) and capture the code into `configOverrides`. **TTL is NOT
    documented as configurable** ("short-lived single-device", "treat like a password") — so the
    "~30–60s settable" assumption is unconfirmed; treat bootstrap as short-lived-but-fixed.
  - **Mint command RESOLVED (2026-06-13, openclaw CLI):** `openclaw qr --setup-code-only --json`
    (with `--remote`/`--url` for a remote gateway) emits the setup code carrying the opaque
    short-lived `bootstrapToken`. Provisioning runs this **in/against the tenant pod**, parses
    `{ url, bootstrapToken }`, stores it in `Tenant.configOverrides.openclaw`. Approve a paired
    device via `openclaw devices approve <requestId>`; gateway token via
    `openclaw doctor --generate-gateway-token`. **Caveat (issue #19352):** chicken-and-egg — the
    CLI may itself need a gateway token/pairing; mitigate by running in-pod with the gateway token
    in env. Now **buildable** (modulo that provisioning detail).
  - **Landed (2026-06-13):** the persistence + decode halves shipped. Control-plane
    `PUT /api/v1/tenants/:name/pairing` (`routes/tenants.ts`) stores/rotates
    `{ gatewayUrl?, bootstrapToken }` into `configOverrides.openclaw` (wss-only guard,
    merges existing overrides, audits `PairingRotated`, never echoes the token);
    `_ResolveOpenClawPairing` reads it back. Operator `_ParseOpenClawSetupCode`
    (`tenants/internal/openclaw-pairing-provision.ts`) decodes the
    base64(`{url,bootstrapToken}`) setup code (and tolerates the `--json` envelope).
    Tests: 6 parser cases (operator 62/62) + pairing-rotate covered via tenants route.
  - **Remaining (live seam):** the in-pod `openclaw qr --setup-code-only` **exec**
    (k8s pod-exec, real binary, the issue-#19352 chicken-and-egg gateway token) and
    wiring it into the operator reconcile to call the rotate endpoint — needs a live
    pod. The control-plane + decode plumbing is ready to receive it.
- [ ] **CONN.4 CP-held operator device + device registry.** OpenCrane holds one
  `operator.pairing`-scoped device per pod (paired server-side, key in a Secret), and a
  `BrokeredDevice` Prisma model + migration recording devices brokered per tenant.
  Acceptance: every broker call records the device; CP can authenticate to a pod gateway
  with `operator.pairing`. (Prereq for CONN.5; depends on CONN.3 / B1 signature scheme.)
  - **Research (2026-06-13):** scope model confirmed — the default pairing profile grants
    `node` + bounded `operator` (`operator.read/write/approvals`) and **explicitly NOT**
    `operator.admin`/`operator.pairing`. So a CP device with `operator.pairing` needs an
    explicit elevation/**approval** step (`openclaw devices approve`, which itself may need
    `operator.admin`). `device.token.revoke`/`rotate` require `operator.pairing` (confirms CONN.5's
    revoke half). **B1 device-signature RESOLVED (2026-06-13, openclaw source/issues):**
    algorithm = **Ed25519** (NOT ECDSA-P256 — the weownai `WebCryptoDeviceSigner` is WRONG and
    must switch to Ed25519, via WebCrypto Ed25519 or `@noble/ed25519`). **B1 fully VERIFIED against
    the shipped `openclaw@2026.6.6` source** (`dist/client-C2g2lFC5.js`, `dist/device-identity-CEPJolq9.js`):
    `deviceId = sha256(raw 32-byte pubkey).hex`; signed payload = pipe-joined
    `["v3", deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token, nonce, platform, deviceFamily]`
    (v2 = same minus the last two; nonce in both; platform/deviceFamily trimmed+lowercased; token→`""`);
    sign = `crypto.sign(null, utf8(payload), ed25519)` → **base64url**; `publicKey` = raw 32-byte key
    **base64url**. **No remaining unknowns** — B1 no longer blocks CONN.4; CONN.4 needs the device
    registry + CONN.3 flow. (Mint command CONN.3 verified: `openclaw qr --setup-code-only [--remote --url]`.)
  - **Landed (2026-06-13) — device registry half:** `BrokeredDevice` Prisma model +
    migration `0008_brokered_devices` (one row per (tenant, subject); `deviceId?`,
    `revokedAt?`; cascade on tenant delete). Every `/auth/pod-token` broker now upserts
    a row (`_RecordBrokeredDevice`, best-effort), so the kill-switch has an authoritative
    list of brokered connections. Tests: 1 registry case + the broker path.
  - **Remaining (live seam):** the **CP-held `operator.pairing` device** (paired
    server-side, key in a Secret) needs a live gateway to pair + the Ed25519 signer
    (B1, now byte-exact). Until then the gateway-revoke half of CONN.5 is the
    `_NoopGatewayAdmin` (see below).
- [ ] **CONN.5 "Cut tenant" kill-switch + RBAC.** Admin action + self-serve "sign out my
  other sessions": call `device.token.revoke` + `device.pair.remove`, then a **K8s
  force-disconnect** — pod-delete (CNI-independent) or a deny `NetworkPolicy` (only if the
  cluster CNI drops *established* flows — verify, else pod-delete). RBAC: add `networkpolicies`
  (create/delete) + `pods` (delete) in `platform/helm/templates/control-plane-rbac.yaml`.
  Acceptance: cutting a tenant severs live sockets **and** blocks re-auth; covered by a test
  (mocked k8s + gateway client). (security doc §4–§5)
  - **Landed (2026-06-13):** `_CutTenant` (`core/connections/cut-tenant.ts`) orchestrates
    gateway revoke (best-effort) → registry revoke (`BrokeredDevice.revokedAt`) → **K8s
    force-disconnect via pod `deletecollection`** by the `opencrane.io/tenant=<name>`
    label selector (CNI-independent — the authoritative cut). Admin route
    `POST /api/v1/tenants/:name/cut` (full-tenant, audits `Cut`) + self-serve
    `POST /api/v1/auth/pod-token/cut` (subject-scoped, **does not** delete the shared pod —
    relies on per-device gateway revoke). RBAC adds `pods get/list/delete/deletecollection`
    to the control-plane ClusterRole (helm-rendered). The gateway-revoke half is the
    `_NoopGatewayAdmin` (`core/connections/gateway-admin.ts`) until a CP operator device is
    paired (CONN.4 live seam) — pod-delete already severs live sockets, so this is safe; the
    no-op only defers the *re-auth-block* half. Tests: 4 `_CutTenant` cases (mocked k8s +
    gateway spy + no-op admin), control-plane 90/90. The deny-`NetworkPolicy` variant is
    **not** added — pod-delete supersedes it (only useful if a CNI fails to drop established
    flows; revisit if a future CNI needs it).
- [x] **CONN.6 Rewrite `docs/auth.md` for the pairing broker.** (2026-06-13) Replaced the
  stale `aud=openclaw` K8s-SA-token / RFC-8693 token-exchange description with the pairing-link
  broker + OpenClaw `connect` handshake (challenge → signed device assertion → `hello-ok`):
  rewrote the end-to-end flow, the credential-types table (bootstrap/device tokens vs projected
  SA token), the "Tenant pod access" section, added an Option B posture section + transport
  notes (CONN.2 fail-closed cookie/HSTS, CONN.8 wildcard TLS), and cross-linked
  `docs/claw-security-considerations.md`. Closes frontend `plan.md` B5. (Docs only.)
- [ ] **CONN.7 Proxy (Option C) — contingent vision.** Control-plane (or, preferred,
  **Envoy/mesh sidecar**) WebSocket proxy: per-session cut + standing per-frame audit/policy
  + zero browser credential. **[DEFERRED — revisit only if]** a hard requirement emerges for
  per-session cutting or per-frame auditing **and** the connection-stateful cost (LB affinity,
  reconnect storms on deploy, content transiting the CP, ~days build) is judged worth it.
  CONN.1–CONN.5 are prerequisites, so nothing is wasted. (security doc §6 / §8 / § Decision)
- [ ] **CONN.8 TLS issuance for tenant ingress (wildcard, k8s-native).** *First slice landed
  2026-06-13 — see Landed/Remaining at the end of this item.* *Prerequisite
  for CONN.2 to mean anything in production* — today the operator-built tenant Ingress
  (`apps/operator/src/tenants/deploy/5-ingress.ts`) has **no `tls:` block** and Helm has
  `ingress.tls.enabled: false` with an unwired `opencrane-wildcard-tls` secret slot
  (`platform/helm/values.yaml`). The browser connects `wss://<tenant>.<domain>`, so the
  ingress must present a browser-trusted cert. Kubernetes' own CA is cluster-internal and
  **not** browser-trusted, so certs come from a public CA via an in-cluster controller.
  **Decision (2026-06-13): use `cert-manager`, NOT Certbot.** cert-manager is the
  CNCF-standard k8s-native controller — declarative CRDs (`ClusterIssuer`/`Certificate`),
  runs in-cluster, stores certs in Secrets, auto-renews, integrates with Ingress, works on
  any cloud + on-prem. Certbot is host-centric/imperative and would mean rebuilding the
  reconcile/renew/secret plumbing by hand.
  - **Wildcard via ACME DNS-01.** One `*.<domain>` cert covers every tenant → new tenants
    need zero new issuance (no per-tenant latency, no Let's Encrypt rate limits). Wildcards
    require **DNS-01** (HTTP-01 can't issue wildcards). Issue into `opencrane-wildcard-tls`,
    flip `ingress.tls.enabled`, and add a `tls:` block (host + `secretName`) in `5-ingress.ts`.
  - **Domain & naming constraints (solve once, cleanly).** Tenants live exactly **one DNS
    label** under the base domain — e.g. base `ai.elewa.ke` → tenant `jente.ai.elewa.ke`,
    covered by a single `*.ai.elewa.ke` cert. A TLS wildcard matches *exactly one* label, so:
    (a) **tenant names must be a single label** under the base (no `app.jente.ai.elewa.ke`
    from one platform wildcard — that would need per-tenant wildcards / multi-level certs;
    revisit only if a tenant-owned-subdomain feature emerges); (b) the **apex is not covered**
    by `*.base` — issue one Certificate with both `dnsNames: [base, *.base]` so anything
    served at the bare base (or needed apex) works; (c) **DNS-01 lands on the base**, not the
    tenant — the challenge TXT is `_acme-challenge.<base>` (e.g. `_acme-challenge.ai.elewa.ke`),
    so the DNS token must own that zone — prefer a **delegated `ai.elewa.ke` subzone** (NS
    delegation) over handing out parent-zone (`elewa.ke`) credentials, to bound blast radius;
    (d) **cookie scoping is a security invariant** — because all tenants share `*.base`, the
    control-plane session cookie must stay **host-only** (no `Domain=.base`, which our
    express-session config already satisfies) or a tenant subdomain could read it; the
    deferred `__Host-` cookie prefix (CONN.2) would enforce this at the browser and is worth
    revisiting here.
  - **DNS-provider abstraction (cloud-agnostic + on-prem).** DNS-01 writes an
    `_acme-challenge.<domain>` TXT record, so cert-manager needs DNS-provider credentials.
    Support a small `{ provider, zone, credentialsRef }` config that renders the
    `ClusterIssuer` DNS-01 solver + credentials Secret. Solvers: built-in
    (route53/clouddns/azuredns/cloudflare/digitalocean), **RFC2136** (BIND/PowerDNS + TSIG —
    the on-prem/any-DNS escape hatch), or webhook solvers for the rest.
  - **Onboarding CLI + API.** New `oc platform dns set --provider … --zone … --token-file …`
    (mirroring the `_Register*` command pattern in `apps/cli/src/commands`) + equivalent
    control-plane API method, capturing the DNS-provider config above. New Helm template:
    `platform/helm/templates/cluster-issuer.yaml` (+ cert-manager as a dependency/prereq).
  - **Local/dev mode.** Keep the *same* cert-manager path, swap only the issuer: a
    `selfSigned`/`CA` `ClusterIssuer` (instant, no DNS challenge) + `sslip.io`/`nip.io`
    wildcard hostnames (`<tenant>.127.0.0.1.sslip.io` → localhost, no `/etc/hosts`, supports
    dynamic tenants) so the k3d substrate (`platform/tests/values-k3d-local.yaml`,
    currently `domain: opencrane.local`, TLS off) gets real TLS. The dev cert is still real
    TLS, so `wss://` + the CONN.2 wss-only/Secure/HSTS hardening are **not** bypassed — only
    the trust anchor differs. Optional `mkcert` root for warning-free browser trust; a
    plain-HTTP fallback stays gated behind `OIDC_COOKIE_SECURE=false` + a dev flag.
  - **Acceptance:** prod path issues a wildcard cert via DNS-01 and tenant Ingresses serve
    it (verified in a cluster/e2e); dev path serves self-signed TLS over an sslip.io
    wildcard host with no manual cert steps; onboarding CLI/API persists DNS-provider config.
    Pairs with CONN.3 (pod provisioning). Anchors: `5-ingress.ts`, `values.yaml`
    (`ingress.tls`), new `cluster-issuer.yaml`, `apps/cli/src/commands`, control-plane API,
    `platform/tests/values-k3d-local.yaml`. (security doc §11)
  - **Landed (2026-06-13):** operator now wires a config-gated `tls:` block into the tenant
    Ingress (`5-ingress.ts`, env `INGRESS_TLS_ENABLED`/`INGRESS_TLS_SECRET_NAME` via
    `config.ts`, default off → no behaviour change) referencing the shared wildcard Secret;
    Helm renders a `cluster-issuer.yaml` (ClusterIssuer `selfSigned` dev **or** `acme` DNS-01
    prod, with fail-guards on missing email/provider) + a wildcard `Certificate`
    (`*.<domain>` + apex), gated by `certManager.enabled`; operator-deployment env + `values.yaml`
    `certManager` block added. Tests: 2 ingress-TLS cases (operator 56/56); `helm template`
    validated for selfSigned, acme+cloudflare-DNS-01, the fail-guard, and operator env.
  - **Landed (2026-06-13, follow-ups a + c):**
    - (a) **onboarding CLI + API.** `PUT/GET /api/v1/platform/dns` (`routes/platform-dns.ts`)
      captures `{ provider, zone, email, server?, issuerName?, apiToken?, solverConfig? }` and
      **upserts the cert-manager DNS-01 `ClusterIssuer` + credentials Secret via the K8s API**
      (`core/platform-dns/`: pure `_RenderDns01ClusterIssuer`/`_RenderDnsCredentialsSecret`
      builders — cloudflare/digitalocean token-based + a verbatim `solverConfig` passthrough for
      route53/rfc2136 — and an idempotent `_ApplyPlatformDnsConfig` create-then-replace-on-409).
      CLI `oc platform dns set|show` (`apps/cli/src/commands/platform.ts`; token read from
      `--token-file`, never on argv; token never echoed in the API response or GET status).
      OpenAPI spec + regenerated contracts client types. RBAC is **least-privilege**: the
      ClusterRole gets only `cert-manager.io/clusterissuers` (cluster-scoped); the DNS-01 credentials
      `secrets` write is a **namespaced Role+RoleBinding in the cert-manager namespace** (gated on
      `certManager.enabled`, namespace wired to the control-plane as `CERT_MANAGER_NAMESPACE`).
      Provider misconfig surfaces as a typed `_DnsProviderConfigError`→422 (not message matching);
      GET propagates non-404 lookup errors instead of masking them. Tests: renderers (8) + apply
      incl. 409-conflict replace (3) + route 400/422/GET (6); control-plane 123/123, contracts+CLI clean.
    - (c) **dev wildcard hostnames.** `platform/tests/values-k3d-local.yaml` now uses
      `domain: 127.0.0.1.sslip.io` + `ingress.tls.enabled` + `certManager.enabled mode=selfSigned`,
      so k3d gets real (self-signed) wildcard TLS with no `/etc/hosts`/manual cert steps —
      `wss://`/CONN.2 hardening intact, only the trust anchor differs. `helm template` validated
      (renders the selfSigned ClusterIssuer + `*.127.0.0.1.sslip.io`+apex Certificate).
  - **Remaining (CONN.8 follow-ups):** (b) **cross-namespace cert distribution** if tenants run
    outside the Certificate's namespace (cert-manager reflector / per-namespace Certificates) —
    current template assumes one shared namespace; (d) **live ACME e2e** (needs a cluster + real
    DNS — cannot be unit-validated; the runtime ClusterIssuer apply is code-tested with mocked K8s,
    but cert-manager actually issuing the wildcard is the unverified seam). Optional `mkcert` root
    for warning-free dev browser trust.
