# OpenCrane — Active Plan

## Current State (2026-06-10)

- **Phases 1–3**: complete and validated.
- **Phase 5** (headless API + CLI + hosting adapter): complete. P5.2 (on-prem) and P5.3 (GCP) deploy-validation runs validated by user (2026-06-10).
- **Phase 4 Track A** (MCP & Skills runtime planes): complete. P4A.1–P4A.3 implemented, tested, and Helm/NetworkPolicy wired (2026-06-10).
- **Phase 4 Track B** (fleet organizational awareness): not started. Blocked on product decisions (P4B.0). See Phase 4 Decisions below before building anything in Track B.
- **Track P4-C** (agent identity & personalisation via OpenClaw workspace files): scoped, design decisions locked. P4C.1–P4C.5 in Open Backlog; not yet started.
- **Branch**: `phase-4-5-fixes`, 6 commits ahead of `main`.

---

## Open Backlog (Execute Next)

> Authoritative, code-verified worklist as of 2026-06-10. Work top-to-bottom.
> Items marked **[BLOCKED]** need a decision before implementation — do not guess.

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

### Track P4-B — Fleet Organizational Awareness (NOT STARTED — largest remaining effort)

> This entire track is greenfield. All items are **[BLOCKED]** on P4B.0 — resolve that first.

- [ ] **P4B.0 Lock Phase 4 awareness decisions.** Resolve the open decisions in the
  "Phase 4 Decisions" section below before building. **[BLOCKED — product decision.]**
- [ ] **P4B.1 Org Context / Awareness SDK.** New shared lib (`libs/awareness` or similar) that
  every OpenClaw consumes, pinned to a contract version. Acceptance: tenant pods retrieve org
  context through the SDK against Cognee with no control-plane retrieval mediation.
- [ ] **P4B.2 AccessPolicy → Cognee grant compiler.** Wire `Awareness` grants through the grant
  compiler and propagate AccessPolicy create/update/delete to Cognee grants within an SLO (today
  only dataset-membership sync exists). Anchor: `core/grants/grant-compiler.ts` (`Awareness` type),
  `routes/tenants.ts` Cognee sync. Acceptance: an AccessPolicy change reflects in Cognee grants
  within the defined SLO; covered by a test.
- [ ] **P4B.3 Awareness contract versioning + canary rollout.** Promote/rollback awareness
  contract versions across the fleet without tenant downtime. Acceptance: canary cohort + rollback
  path demonstrated.
- [ ] **P4B.4 Golden-query / eval harness.** Conformance suite for awareness correctness, policy
  safety, freshness, and citation quality. Acceptance: suite runs in CI and gates rollout.
- [ ] **P4B.5 Fleet skills-sharing protocol + participation monitoring.** Cross-tenant skill
  discovery/consumption protocol; control-plane monitors per-tenant participation, drifted
  versions, and policy-violating skill executions. (Catalog CRUD + registry delivery already
  exist; the fleet protocol layer does not.)
- [ ] **P4B.6 Fleet awareness dashboards + SLOs.** Prometheus metrics + Grafana dashboards +
  alert thresholds + runbook links for awareness SLOs (current `/prom` metrics have none).

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
- [ ] **P4C.2 Contract-derived `TOOLS.md`.** Extend the effective contract + re-pull loop to render
  `TOOLS.md` from the tenant's entitled MCP servers + skills; SIGHUP + agent-awareness note on change.
  Anchor: `routes/internal/tenant-contract.ts`, `entrypoint.sh` poll loop. Acceptance: granting or
  denying an MCP server updates `TOOLS.md` within one poll interval without a pod restart, and
  OpenClaw is notified.
- [ ] **P4C.3 Company doc API + versioning (L1).** `companyDoc` / `companyDocVersion` Prisma models
  + migration; CRUD at `/api/v1/org/workspace-docs/:name` with immutable version history + audit;
  an allowlist guard rejecting company docs that carry L0 system-mechanic directives. Acceptance:
  publishing a new version stores it immutably and is retrievable by version; covered by tests.
- [ ] **P4C.4 Agent-driven reconciliation (propose).** LiteLLM-backed reconciler (follow
  `apps/harvesting-agent` shape) computes the 3-way merge, produces a per-tenant proposed merge +
  diff stored as a pending proposal, and tracks per-tenant `lastReconciledVersion`. Sandboxed to
  L1/L2. Acceptance: a company version bump generates a per-tenant proposal with a diff; the run is
  idempotent/resumable; the reconciler cannot alter L0; covered by a test.
- [ ] **P4C.5 Approval + delivery + agent awareness.** Approve/reject API; on approval the reconciled
  doc rides the re-pull loop into the workspace, bumps `lastReconciledVersion`, and audits; OpenClaw
  is notified and can view the change (e.g. a `BOOT.md`/`HEARTBEAT.md` note or system message + the
  diff). Acceptance: approving delivers the doc without a pod restart and the agent surfaces/can view
  the change; rejecting leaves the tenant doc untouched.

---

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

> **Phase 4 status (2026-06-10):** Track A ~90% built (P4A.1–P4A.3 remaining). Track B greenfield, gated on P4B.0 decisions.

---

## Phase 4 Decisions (Lock Before Execution of Track B)

> All items below must be resolved before Track B implementation starts. Confirmed items are marked [x].

- [ ] Awareness SDK ownership model (single package vs per-domain modules).
- [ ] Contract version rollout strategy (global vs tenant cohort waves).
- [ ] Minimum required citation format in OpenClaw responses.
- [ ] Fleet SLO thresholds for freshness, latency, and policy safety.
- [ ] Connector conformance bar for org index schema v2 adoption.
- [ ] Skills sharing scope rules (org/department/project/personal) and precedence model.
- [ ] Protocol transport and delivery guarantees for claw participation events.
- [ ] Monitoring severity model for non-participating claws and policy-violating executions.
- [ ] Department scope semantics versus team scope migration rules.
- [ ] Promotion and demotion authorization rules and required approvers per scope boundary.
- [ ] OCI artifact naming, tagging, and digest pinning policy for skill versions.
- [x] MCP credential custody: central broker (Obot holds downstream creds; pod never receives them). **Confirmed.**
- [x] Skill substrate: build thin over OCI/ORAS + Cognee (not a ClawHub fork). **Confirmed.**
- [ ] Obot MCP Gateway version and deployment topology (single replica vs HA).
- [ ] Skill registry OCI store: Zot vs alternative OCI-compliant registry.
- [ ] Third-party source auto-sync interval defaults and rate-limit policy.
- [ ] Scheduler dispatch identity model: job-scoped token TTL and audience.
- [ ] ClawdBot bootstrap injection content (BOOTSTRAP.MD, SOUL.MD) review and sign-off.

---

## Go-Live Checklist (Open Items)

| Item | Status | Done Criteria |
|------|--------|---------------|
| GCP installer smoke (`./platform/install.sh gcp`) | Not yet revalidated | Fresh GCP project deploys end-to-end; control-plane endpoint reachable; test tenant reconciles successfully. |
| DNS + ingress verification | Not started | Domain and TLS resolve correctly; control-plane and tenant subdomains accessible externally. |

All other checklist items (local baseline, k3d e2e, Helm chart, Docker CI publish, Prisma migrations, CI e2e gate, runbook) are complete. See `plan-done.md` for the full table.

---

## Cross-Phase Priorities

### Must Do Before Public Release

1. **Security Hardening**: Non-root pod, read-only root fs, drop Linux caps, resource limits, NetworkPolicy default-deny (done in AccessPolicy operator).
2. **Documentation**: Deployment guide, operator reference, example Tenant CRs, troubleshooting.
3. **RBAC**: Operator ClusterRole, control-plane Role, per-tenant ServiceAccount Workload Identity.
4. **Testing**: Operator integration tests (k3d), control-plane API tests, Helm chart validation.
5. **Observability**: Structured logging (pino), Cloud Logging ingestion, operator metrics.

### Nice to Have (Post-Phase 3)

1. Observability: OTel → ClickHouse for audit trail.
2. Advanced governance: policy approvals, audit webhook.
3. Advanced scheduling: tenant pod affinity, PDB for disruption budgets.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Operator watch/reconcile bugs break tenant pods | Early k3d integration tests, canary rollout strategy for operator updates |
| GCS Fuse CSI mount failures | Mount readiness check in pod init, fallback PVC if CSI unavailable |
| Control-plane DB scaling | Postgres connection pooling, read replicas for analytics |
| LiteLLM key generation during reconcile blocks tenant creation | Async key generation + retry loop, fallback to pre-generated key pool |
| Retrieval returns data outside tenant scope | Enforce AccessPolicy-filtered query path, deny-by-default checks, and conformance tests for allow/deny behavior |
| Harvesting agent ingestion drift or stale context | Cursor-based sync with checkpoints, lag/error SLO alerts, and replay-capable ingest jobs |
| Update rollback fails | Manual rollback instructions, `kubectl patch Tenant` to change version |
