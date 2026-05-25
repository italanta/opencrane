# OpenCrane Implementation Plan

## Executive Summary

This is an updated roadmap for shipping OpenCrane, the enterprise multi-tenant AI agent platform. The plan is updated with grounding in a competitive audit.

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
- Captured a parity checklist clarifying that local validates core stack wiring, while GCP remains the only path that exercises cloud identity, GCS/Crossplane, External Secrets, GCE ingress, and DNS.
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

**Strategic approach**: OpenCrane differentiates by combining:
- **Architectural advantages**: GCS Fuse CSI + Workload Identity (cloud-native isolation), dual-write pattern (CRDs + PostgreSQL), policy-first governance (AccessPolicy CRDs → CiliumNetworkPolicy).
- **Tactical features**: Cost control (LiteLLM), self-service UX (web portal), memory cutover (Cognee write-through).

**Next move**: Execute a dual-track Phase 2 (LiteLLM governance + retrieval/org-knowledge foundation), while keeping Phase 1 regression checks green in CI.

**Effort**: ~282 hours over 7–9 weeks (2 engineers + 1 ops), assuming clear architecture decisions upfront.

---

## Goal

Ship a production-grade multi-tenant OpenClaw platform that is:
1. **Architecturally differentiated**: GCS + IAM isolation, dual-write pattern, Crossplane-driven.
2. **Feature-complete for org rollout**: Cost control (LiteLLM), self-service UI, memory upgrade.
3. **Operationally sound**: Observability, role-based access, policy-driven governance.

---

## README Realization Track (2026-05-12)

This section translates the current README narrative into explicit delivery scope so roadmap execution and public messaging stay aligned.

### Vision-to-Execution Mapping

| README promise | Delivery status | Delivery phase |
|----------------|-----------------|----------------|
| Every employee gets an isolated assistant | Baseline in place | Phase 1 complete + hardening backlog |
| Cost governance and budget controls | In progress | Phase 2 |
| Retrieval plugin with RBAC-filtered org context | Foundation only today | Phase 2-3 |
| Company-wide harvesting agents + org index | Not shipped | Phase 2-3 |
| Self-service provisioning (web portal) | In progress | Phase 3 |
| Memory orchestration cutover (Cognee write-through) | Planned | Phase 3 |

### Steering Rule For Docs And Pitch

Use three labels consistently across README/pitch/sales material:
- **Available now**: only Phase 1 validated and currently passing capabilities.
- **In progress**: Phase 2 deliverables under active implementation.
- **Planned**: Phase 3+ items not yet validated in CI/e2e.

No feature should move to "Available now" until success criteria are met and the go-live checklist remains green.

### Delivery Workstreams Required To Realize README

1. **Platform trust**: close deferred hardening, dual-write safety, and CI release gates.
2. **Economic control**: complete LiteLLM keying/spend enforcement and budget visibility.
3. **Organizational intelligence**: ship retrieval SDK, org index schema, and harvesting-agent MVP.
4. **Self-service adoption**: deliver tenant provisioning UX with clear auth and audit path.
5. **Memory adoption**: cut over from PostgreSQL-only retrieval to Cognee write-through memory orchestration.

### Exit Criteria For "README Realized" (Production Narrative)

- Retrieval plugin returns RBAC-filtered organization context from a live org index.
- At least one company data source ingestion pipeline is running continuously.
- Self-service tenant provisioning works end-to-end with auditable approval/auth path.
- Cost policy, spend telemetry, and budget enforcement are visible per tenant.
- Release gates (CI e2e, migration rollout, ingress verification, runbook) are green.

---

## Current Status: Phase 1 Audit (Go-Live Baseline Complete)

### ✅ Already Built

**Operator** (apps/operator/src/)
- TenantOperator class with full reconcile loop (ServiceAccount, ConfigMap, Deployment, Service, Ingress, encryption key)
- PolicyOperator watching AccessPolicy CRDs → CiliumNetworkPolicy generation
- Functional tenant deploy resource builders for K8s resource generation
- TenantStatusWriter, TenantCleanup helpers
- IdleChecker for auto-suspend on inactivity
- Config loading, helpers (TenantDomains)
- Unit + integration tests (operator.test.ts, policy tests)

**Control Plane API** (apps/control-plane/src/)
- Express server with bearer token auth middleware
- Full CRUD routes for Tenants, Policies, Skills, Audit, Metrics, Token Usage, Access Tokens, Provider Keys
- Consolidated AI budget routes (`/api/ai-budget`) for global/account budgets, tenant spend, and LiteLLM key management
- Dual-write pattern: K8s CRDs + PostgreSQL via Prisma
- Prisma schema extended with LiteLLM key metadata tracking

**Control Plane UI** (apps/control-plane-ui/src/)
- Angular 20 app with PrimeNG components
- Feature pages: stats, token usage, access tokens, provider keys
- Shared component structure
- Test tooling now wired and passing (spec config + baseline component spec)

**Infrastructure & CRDs**
- Helm chart skeleton with values (operator, control-plane, tenant defaults, network policy)
- CRD definitions (Tenant, AccessPolicy) present in platform/helm/crds/
- Terraform modules for GKE, networking, Crossplane, artifact registry
- Shared skills directory structure

### ✅ Phase 1 Completion Checklist

| Item | Status | Evidence |
|------|--------|----------|
| **Helm templates** (operator/control-plane + RBAC/services) | ✅ Complete | Deploys successfully in k3d via chart install |
| **Docker image CI publish workflow** | ✅ Complete | `.github/workflows/docker.yml` builds/tests/e2e and publishes on `main` |
| **Prisma migrations present** | ✅ Complete | `apps/control-plane/prisma/migrations/0001_init` committed |
| **Tenant runtime image + entrypoint** | ✅ Complete | `apps/tenant/deploy/Dockerfile` + `entrypoint.sh` exercised in k3d e2e |
| **k3d end-to-end smoke test** | ✅ Complete | `platform/tests/k3d-e2e.sh` passes and validates tenant reconcile |

### 📋 Phase 1 Exit Notes

1. Phase 1 go-live baseline is complete and validated with build + k3d smoke test.
2. The k3d smoke script now includes Docker health and free-disk preflight checks to reduce false failures.
3. Deterministic tenant `policyRef` resolution is complete in the operator: explicit `policyRef` wins, then single selector match, then configured default, with conflict and missing-policy errors surfaced in Tenant status.
4. Remaining work should be tracked under Phase 2+ hardening and production rollout tasks, not Phase 1 blockers.

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
| Crossplane `BucketClaim` provisioning | ❌ | ❌ | ✅ |
| External Secrets / Secret Manager path | ❌ | ❌ | ✅ |
| GCE ingress + static IP + DNS wiring | ❌ | ❌ | ✅ |

Interpretation:
- Local `default` is the fastest end-to-end developer stack.
- Local `strict` is the preferred parity check for core app wiring and stricter chart validation.
- GCP is still the only environment that validates cloud-native identity, storage, ingress, and secret-management integrations.

### Deferred While Starting Phase II

These items are intentionally deferred. They are grouped by what is actually blocking them.

#### Needs e2e validation only (no open decisions)

These items are code-complete. The only blocker is a working k3d or GCP cluster run to confirm no hidden runtime incompatibilities.

**Runtime hardening baseline** — securityContext defaults, non-root user/group, dropped capabilities, seccomp, read-only root filesystem. All defaults are now injected into tenant Deployments. Unblock by running the k3d e2e with a tenant pod and verifying it starts cleanly.

**Stronger least-privilege and file access limits** — read-only root filesystem and explicit writable paths (`/data/openclaw`, `/data/secrets`, `/tmp`) are in place. Unblock alongside the hardening validation above.

#### Requires Phase 2 decisions before implementation

**Suspend logic aware of scheduled/background work** — needs a durable scheduler contract and state model. Blocked on Phase 2 harvesting agent and background job decisions (see Phase 2 open decision 8).

**Managed runtime awareness contract** — baseline env/config contract and policy metadata are injected. The remaining capability endpoint/payload shape depends on Phase 2 retrieval API and scheduling decisions (see Phase 2 open decisions 7 and 8).

**Dual-write alert delivery and single-writer ownership** — detect-only drift reporting, on-demand repair, mismatch metrics, and basic threshold evaluation now exist. Remaining work is external alert delivery and deciding the long-term single-writer owner (control-plane request handlers, operator sidecar, or dedicated projector service). Write-path simplification (retire request-path dual-write in favour of a watcher-fed projector) is a larger architectural change tracked under Phase 3.

---

## Phase 1: Core Platform (Shipped Baseline)

### Architecture Retrospective: Phase 1 Decisions

These decisions are now effectively locked in by the current implementation and should be treated as the Phase 1 baseline unless a later phase explicitly revisits them.

1. **Helm Chart Structure**
   - The main OpenCrane chart owns LiteLLM deployment directly; there is no longer a separate LiteLLM subchart.
   - PostgreSQL is consumed via `DATABASE_URL` Secret wiring in the chart, while local and GCP installers can provision the backing database outside the chart.

2. **Operator Deployment**
   - Operator deployment is single-replica in the current baseline.
   - RBAC and env wiring for storage provider, ingress, LiteLLM, and idle reconciliation are part of the shipped chart baseline.
   - Runtime hardening beyond the current baseline remains a deferred hardening item, not a Phase 1 blocker.

3. **Tenant Pod Isolation**
   - GCP path uses GCS/Workload Identity/Crossplane when enabled.
   - Local path uses PVC fallback and now has both `default` and `strict` profiles for validation.
   - Baseline network policy is created by chart install; richer policy enforcement remains operator/policy work.

4. **Control Plane Deployment**
   - Control-plane remains on the current API/auth baseline, with bearer-token and OIDC evolution deferred to later product phases.
   - Local and GCP both use PostgreSQL-backed deployment flows; local now provisions an in-cluster database for full-stack bring-up.

5. **Terraform & IaC**
   - Terraform owns GCP infrastructure provisioning, including GKE, Crossplane bootstrap, Artifact Registry, in-cluster PostgreSQL install, app deploy, and DNS.
   - Local full-stack install is handled by the k3d bootstrap script, not Terraform.

**Action**: Treat Phase 1 as closed. Any remaining changes here should be tracked as hardening, parity, or Phase 2+ work rather than reopening Phase 1 design questions.

---

### Deliverables

1. **Operator** (deployed as K8s Deployment)
   - Watches Tenant CRD; reconciles per-tenant:
     - ServiceAccount (with Workload Identity annotation)
     - BucketClaim (via Crossplane)
     - Encryption key Secret
     - ConfigMap (base config + spec overrides)
     - Deployment (tenant pod + GCS Fuse mount)
     - Service (ClusterIP on gateway port)
     - Ingress (subdomain routing)
   - Watches AccessPolicy CRD; reconciles CiliumNetworkPolicy per tenant.
   - Status writer patches Tenant.status with phase, ingress host, last reconciled.

2. **Helm Chart** (platform/helm/)
   - Values for all components: operator, control-plane, shared skills PVC, CRDs.
   - Namespace creation, RBAC (operator ClusterRole, control-plane Role).
   - CRD templates (Tenant, AccessPolicy, BucketClaim).
   - Database integration via `DATABASE_URL` Secret wiring, with installer-specific database provisioning outside the chart.

3. **Terraform Modules** (terraform/modules/)
   - `gke/`: GKE cluster, node pool, workload identity setup.
   - `cloud-sql/`: Cloud SQL instance, database, user.
   - `networking/`: VPC, subnet, Cloud NAT, Firewall rules.
   - `crossplane/`: GCP provider + ProviderConfig with service account.
   - `artifact-registry/`: Container registry for images.

4. **Docker Images**
   - `tenant`: Node 22 + OpenClaw npm + entrypoint script (mount GCS, link skills, start gateway).
   - `operator`: TypeScript compiled + runtime (next.js runner).
   - `control-plane`: Express API server.

5. **CRD Definitions** (platform/helm/crds/)
   - `Tenant`: spec (displayName, email, team, openclawVersion, resources, policyRef, configOverrides), status (phase, ingressHost, podName).
   - `AccessPolicy`: spec (tenantSelector, domains, egressRules, mcpServers), status (lastReconciled).
   - Validation rules (no empty names, valid email, CIDR format).

### File Structure

```
opencrane-platform/
├── apps/
│   ├── operator/
│   │   ├── src/
│   │   │   ├── index.ts          # entry point
│   │   │   ├── config.ts          # OperatorConfig
│   │   │   ├── infra/k8s.ts       # K8s client wrappers
│   │   │   ├── tenants/
│   │   │   │   ├── operator.ts    # TenantOperator class ✅ (already have)
│   │   │   │   ├── types.ts       # Tenant CRD type
│   │   │   │   ├── tenant-resource-builder.ts
│   │   │   │   ├── tenant-status-writer.ts
│   │   │   │   ├── tenant-cleanup.ts
│   │   │   │   └── idle-checker.ts
│   │   │   ├── policies/
│   │   │   │   ├── operator.ts    # AccessPolicy operator
│   │   │   │   ├── types.ts       # AccessPolicy CRD type
│   │   │   │   └── policy-resource-builder.ts  # → CiliumNetworkPolicy
│   │   │   ├── storage/provider.ts
│   │   │   └── shared/watch-runner.ts
│   │   ├── deploy/Dockerfile
│   │   └── package.json
│   ├── control-plane/
│   │   ├── src/
│   │   │   ├── index.ts                    # Express app factory
│   │   │   ├── routes/
│   │   │   │   ├── tenants.ts             # CRUD tenants ✅
│   │   │   │   ├── policies.ts            # CRUD policies ✅
│   │   │   │   └── ...other routes
│   │   │   ├── middleware/auth.ts         # Bearer token ✅
│   │   │   └── db.ts
│   │   ├── prisma/schema.prisma
│   │   ├── deploy/Dockerfile
│   │   └── package.json
│   ├── control-plane-ui/
│   │   ├── src/app/
│   │   │   ├── features/
│   │   │   │   ├── tenants/
│   │   │   │   ├── policies/
│   │   │   │   └── audit/
│   │   │   └── shared/components/
│   │   └── package.json
│   └── tenant/
│       ├── deploy/Dockerfile
│       ├── deploy/entrypoint.sh  # install OpenClaw, link skills, start
│       └── config/base-openclaw-config.json
├── platform/
│   ├── helm/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── values-gcp.yaml (example)
│   │   ├── crds/
│   │   │   ├── tenant.opencrane.io_tenants.yaml
│   │   │   └── tenant.opencrane.io_accesspolicies.yaml
│   │   └── templates/
│   │       ├── operator-deployment.yaml
│   │       ├── control-plane-deployment.yaml
│   │       ├── shared-skills-pvc.yaml
│   │       └── networkpolicy.yaml
│   ├── terraform/
│   │   ├── versions.tf
│   │   ├── main.tf
│   │   ├── outputs.tf
│   │   ├── variables.tf
│   │   ├── environments/
│   │   │   └── dev/
│   │   │       ├── terraform.tfvars.example
│   │   │       └── main.tf (dev overrides)
│   │   └── modules/
│   │       ├── gke/
│   │       ├── cloud-sql/
│   │       ├── networking/
│   │       ├── crossplane/
│   │       └── artifact-registry/
│   └── deploy.sh
├── skills/shared/
│   ├── org/                     # org-wide skills
│   │   └── company-policy/
│   └── teams/
│       └── engineering/
├── docs/
│   ├── architecture.md
│   ├── deployment.md
│   ├── operator.md
│   └── crd-reference.md
├── comparison.md
└── plan.md (this file)
```

### Key Tasks (Phase 1)

| Task | Owner | Estimated Effort | Dependency |
|------|-------|------------------|-----------|
| Implement TenantOperator.reconcileTenant() | Backend | 20h | CRDs defined |
| Implement AccessPolicy → CiliumNetworkPolicy builder | Backend | 15h | TenantOperator done |
| Build operator Helm chart (RBAC, Deployment, CRDs) | DevOps | 10h | Operator code done |
| Build GKE + Crossplane Terraform modules | DevOps | 20h | GCP project + SA setup |
| Build tenant Dockerfile + entrypoint | Backend | 10h | s3 integration test |
| Integration tests (operator reconcile happy path) | QA | 15h | All code done |
| **Phase 1 Total** | | **90h** | |

### Success Criteria

- [x] Operator reconciles a Tenant CR end-to-end (ServiceAccount → Deployment → Ingress → status).
- [x] AccessPolicy CRD generation path is implemented and covered by tests.
- [x] `helm install opencrane platform/helm/` deploys operator + CRDs.
- [ ] Terraform applies GKE cluster + Crossplane.
- [x] Tenant pod starts, mounts storage, links skills, starts OpenClaw gateway on port 18789.
- [ ] Tenant is accessible at `https://{tenant}.opencrane.io` via Ingress.

---

## Phase 2: Cost Control + Retrieval Foundation

### Phase 2 Architecture Decisions (Locked 2026-05-28)

All Phase 2 architecture questions are now decided. Decisions are marked with their concrete outcome and rationale.

1. **LiteLLM Deployment Model** — **DECIDED**
   - **Decision**: LiteLLM deploys in the same namespace (`opencrane`) as the operator and control-plane. No separate namespace until traffic warrants it.
   - **Decision**: LiteLLM shares the platform PostgreSQL for Phase 2; a dedicated database is a post-Phase-3 upgrade if write throughput requires it.
   - **Decision**: Master key and database URL remain chart-managed (Secret-backed); LiteLLM model config is installer-managed via a separate ConfigMap that operators update without chart upgrades.

2. **Virtual Key Generation** — **DECIDED**
   - **Decision**: Operator initiates virtual key creation synchronously during Tenant reconcile (Step 4 of reconcile loop). Reconcile blocks until the key is stored, with the LiteLLM API call retried on transient failures.
   - **Decision**: Keys are static per tenant (no auto-rotation). Revocation is manual via `POST /api/ai-budget/:tenantName/litellm-key/revoke`.
   - **Decision**: A pool-based pre-generation path is deferred to a later optimization backlog if reconcile latency becomes a problem.

3. **Spend Tracking** — **DECIDED**
   - **Decision**: Spend is tracked per tenant (primary) and per model (secondary). The `/api/ai-budget/:tenantName/spend` route queries LiteLLM usage API in real time and augments with local budget metadata from PostgreSQL.
   - **Decision**: Hard budget enforcement is handled by LiteLLM (returns 429 when `max_budget` is exceeded). The control-plane exposes a warning at 80% of ceiling via the spend endpoint but does not enforce independently.
   - **Decision**: A shadow spend table in PostgreSQL is deferred; it becomes relevant only if LiteLLM's API becomes a latency bottleneck for dashboard queries.

4. **Tenant Config Injection** — **DECIDED**
   - **Decision**: LiteLLM proxy endpoint is injected as `LITELLM_ENDPOINT` env var; the virtual key is injected as `LITELLM_API_KEY` from a tenant Secret. Both are already implemented.
   - **Decision**: Tenants cannot override the cluster-local proxy endpoint (`http://litellm:4000`). The endpoint is always operator-controlled.
   - **Decision**: LiteLLM remains mandatory in-cluster for target architecture; there is no tenant-level or cluster-level opt-out path.

5. **Observability & Alerts** — **DECIDED**
   - **Decision**: LiteLLM health is surfaced in the `GET /api/ai-budget/:tenantName/spend` route — callers receive a 503 when LiteLLM is unreachable. No separate health endpoint for LiteLLM.
   - **Decision**: An 80% budget alert flag (`budgetAlertState: "warning"`) is returned in the spend payload when usage exceeds 80% of ceiling. External alert delivery (webhook) is implemented via the projection-drift alert path (see item 10).
   - **Decision**: Monthly budget limits are supported. Weekly budget limits require a follow-up LiteLLM capability verification and are tracked as investigation work.

6. **Org Knowledge Index Model** — **DECIDED**
   - **Decision**: Minimum canonical schema: `source`, `sourceId`, `owner`, `teamScope`, `sensitivityTags`, `title`, `content`, `contentHash`, `embeddingReady`, `ingestedAt`, `updatedAt`. All fields except `title` and `teamScope` are mandatory.
   - **Decision**: RBAC filtering uses `owner` and `teamScope`. Sensitivity tags are metadata only for Phase 2; they gate retrieval starting Phase 3.
   - **Decision**: PostgreSQL-only for current Phase 2 runtime remains in place. To be removed as part of phase 3.
   - **Decision**: Target memory state for Phase 3+ is Cognee orchestration with OpenClaw write-through ingestion (`docs/memory.md`). OpenClaw remains responsible for source connectors (SharePoint and other enterprise systems).
   - **Decision**: Dataset granularity is hierarchical: org-wide datasets are shared within tenant boundaries, plus team-wide, project-wide, and personal datasets. Tenant access to project/team/department datasets is bound from the control-plane.
   - **Decision**: AccessPolicy mapping is controlled by the control-plane, which assigns tenant/user access to project and department datasets and translates policy outcomes to Cognee permission grants.
   - **Decision**: Source-permission propagation follows user/OpenClaw-initiated copy semantics: content is copied into destination datasets chosen by user action and policy-checked by OpenClaw.
   - **Decision**: Freshness invalidation uses source version metadata and user-driven revalidation: re-fetch when memory is older than 1 day for the originating user, when explicitly requested, or when source edits are detected through OpenClaw actions.
   - **Decision**: Self-hosted Cognee audit-log parity is tracked as nice-to-have hardening and follows Cognee's self-hosted roadmap; it is not a hard cutover blocker for the initial rollout.
   - **Decision**: Memory cutover requires the adoption gate to pass: dataset granularity lock, AccessPolicy mapping, source-permission propagation, and freshness invalidation controls.

7. **Retrieval Authorization Model** — **DECIDED**
   - **Decision**: AccessPolicy is the sole enforcement source for retrieval allow/deny decisions. No additional ACL layer for Phase 2.
   - **Decision**: Retrieval failures (policy-denied requests) return `403` with an explicit authorization error body (not silent empty results). Empty results are returned only when the query genuinely matches no documents.
   - **Decision**: Retrieval is direct from OpenClaw/Clawdbot to Cognee. Control-plane only applies dataset permission mappings to Cognee and audits dataset membership changes.

8. **Harvesting Agent Scope (MVP)** — **DECIDED**
   - **Decision**: Initial connector implementation exists for Slack, but the source strategy is not locked to Slack-only. Candidate frameworks/connectors for Office 365, SharePoint, Google Workspace, and other enterprise sources must be evaluated before scaling connector coverage.
   - **Decision**: Ingestion SLOs gating Phase 3 progression: lag < 30 minutes for 95% of messages, failure rate < 1% per sync cycle.
   - **Decision**: The harvesting agent runs as a standalone Node.js service (`apps/harvesting-agent`) deployed via the Helm chart as an optional workload.
   - **Reference**: Connector portfolio and integration strategy documented in `harvesting-agents-plan.md` and communication source rationale in `conversation-plan.md`.

**Single-Writer Ownership Decision** — **DECIDED**
   - **Decision**: The operator sidecar (watch loop) is the authoritative single-writer for Tenant and AccessPolicy PostgreSQL projections going forward. Request-path dual-writes in the control-plane are retained as compatibility shims during Phase 2 and removed in Phase 3 when the projector pattern is fully validated.
   - **Rationale**: The operator already watches CRD events and is the canonical source of truth for Kubernetes state. Centralising writes there eliminates the split-brain risk from concurrent request-path and watch-path writes.
   - **Reference**: Additional explanation documented in `single_ownership_decision.md`.

---

### Deliverables

1. **LiteLLM Platform Integration**
   - Maintain the root-chart LiteLLM deployment path.
   - Keep `LITELLM_MASTER_KEY` and database wiring explicit through secrets/values.
   - Maintain `litellm:4000` as the in-cluster endpoint unless Phase 2 decisions change the topology.
   - Evolve routing/config shape without reintroducing duplicate chart ownership.

2. **Operator Enhancement: Virtual Key Generation**
   - On Tenant reconcile: call `POST http://litellm:4000/key/generate` with tenant name and monthly budget.
   - Store returned API key in tenant's Config Secret.
   - Inject as env var or file reference into Deployment spec.

3. **Control Plane Enhancement: Budget/Spend API**
   - New route `GET /api/spend/:tenantName` → query LiteLLM usage API.
   - Aggregation: total cost YTD, remaining budget, top models used.

4. **Tenant Config Injection**
   - Tenant's `openclaw.json` has `llmProxy` section:
     ```json
     {
       "llmProxy": {
         "endpoint": "http://litellm:4000",
         "apiKey": "${LITELLM_API_KEY}"
       }
     }
     ```
   - Operator injects real key on reconcile.

5. **Org Knowledge Index Foundation**
   - Add initial schema and repository interfaces for organization knowledge documents and source metadata.
   - Define tenancy and RBAC projection fields required for filtered retrieval.
   - Add API route surface for retrieval-plugin query and health checks.

6. **Retrieval Plugin SDK (MVP)**
   - Define plugin contract for query input, tenant identity context, and filtered response payload.
   - Implement a basic in-cluster client path from tenant runtime to control-plane retrieval endpoint.
   - Add conformance tests for allow/deny behavior aligned with AccessPolicy constraints.

7. **Harvesting Agent MVP (Single Source)**
   - Implement one source connector (for example Slack or ticketing) with incremental sync cursoring.
   - Write normalized documents into the org index with source provenance and timestamps.
   - Add operational metrics (ingest lag, failures, processed docs).

8. **MCP Tool Allowlist Enforcement**
   - Enforce `mcpServers.allow/deny` from the resolved AccessPolicy beyond startup-time shared-skill linking.
   - Block or audit MCP server registration/invocation at the gateway level when a server is denied.
   - Add deny/audit log events for blocked tool requests.
   - Add conformance tests for allow and deny paths.

9. **Tenant Skill Distribution Model**
   - Decide long-term mechanism for per-tenant skill filtering (subdirectory mount, symlink subset, or packaged distribution).
   - Use durable, auditable per-tenant `skillAllowlist` governance as the single skill distribution path.
   - Document the canonical UX contract for operators and tenant owners.

10. **Dual-write projection repair and metrics**
    - ✅ Repair routes implemented: `POST /tenants/repair` and `POST /policies/repair` with dry-run default.
   - ✅ Mismatch count metrics implemented via `GET /api/metrics/projection-drift` for Tenant and AccessPolicy projections.
   - ✅ Configurable drift-threshold evaluation is exposed in the metrics payload for dashboard polling.
   - ✅ Projection lag metrics are exposed in the drift payload from drifted projection-row `updatedAt` timestamps.
   - Add external alert delivery when drift exceeds a configurable threshold (still open).
    - Decide single-writer ownership: control-plane request handlers, operator sidecar, or dedicated projector service (still open).

### File Structure Additions

```
platform/
├── helm/
│   ├── templates/
│   │   ├── litellm-deployment.yaml
│   │   ├── litellm-service.yaml
│   │   ├── litellm-secret.yaml
│   │   └── validate-config.yaml
│   └── Chart.yaml
```

### Key Tasks (Phase 2)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| LiteLLM chart integration hardening | DevOps | 8h | Phase 1 done |
| Operator: LiteLLM key generation on reconcile | Backend | 10h | LiteLLM chart deployed |
| Control Plane: /api/spend endpoint | Backend | 8h | LiteLLM chart + schema |
| Tenant config injection of proxy endpoint | Backend | 5h | Operator enhancement |
| Org index schema + retrieval API surface | Backend | 14h | Phase 1 done |
| Retrieval plugin SDK MVP + policy tests | Backend | 16h | Org index schema |
| Harvesting agent MVP (single source connector) | Backend | 18h | Org index schema |
| Ingest/retrieval observability + dashboards | DevOps + QA | 8h | SDK + agent MVP |
| MCP tool allowlist enforcement + audit events | Backend | 10h | Phase 1 entrypoint enforcement |
| Tenant skill distribution model + UX contract | Backend | 8h | Phase 1 skills filtering |
| Dual-write projection repair + mismatch metrics | Backend | 12h | Existing drift detector |
| Tests: key generation, spend queries | QA | 10h | All code |
| **Phase 2 Total** | | **127h** | |

### Success Criteria

- [x] Helm chart deploys LiteLLM through the root chart with shared PostgreSQL integration.
- [x] On Tenant CR creation, operator creates a LiteLLM virtual key with monthly budget.
- [x] Tenant pod receives `LITELLM_API_KEY` and proxy endpoint.
- [x] Control Plane exposes spend endpoint; shows per-tenant usage + budget.
- [x] Dashboard can display "You have $X of $Y budget" per tenant (SpendChartComponent in Angular portal).
- [x] Retrieval path is direct from OpenClaw/Clawdbot to Cognee; control-plane no longer mediates `/api/retrieval/query`.
- [x] One harvesting connector continuously ingests documents with measurable lag/error metrics (Slack connector in `apps/harvesting-agent` with `/metrics` endpoint).
- [x] AccessPolicy outcomes are translated into Cognee dataset memberships via `/api/tenants/:name/datasets` and synced to Cognee permissions.
- [x] MCP server allow/deny is enforced at gateway level beyond startup: tenant CRD `mcpPolicy` field, injected as `OPENCRANE_TENANT_MCP_ALLOW`/`OPENCRANE_TENANT_MCP_DENY` env vars, checked in `entrypoint.sh` before policy-level allow/deny.
- [ ] Control-plane-managed env updates and propagation path to OpenClaw runtime still need explicit design and implementation notes.
- [x] Tenant skill distribution model: durable `skillAllowlist` field added to Tenant CRD spec and TypeScript interface; takes precedence over legacy `skills` array.
- [x] Projection drift is measurable via metrics and repairable via a periodic reconcile job; periodic automation remains open.
- [x] Projection repair is available on demand via `POST /tenants/repair` and `POST /policies/repair`.
- [x] External alert delivery: webhook fired when drift count exceeds `OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD` (`OPENCRANE_DRIFT_WEBHOOK_URL` env var).

---

## Phase 3: Self-Service Provisioning + Memory Cutover

### Architecture Checkpoint: Portal, Auth, and Memory Rollout

Before finishing this phase, lock the following:

1. **Web Portal Stack**
   - Portal remains embedded in the existing control-plane-ui (Angular). No separate Next.js app.
   - Auth baseline for this phase is bearer token.
   - OIDC is explicitly deferred to future work.

2. **Tenant Provisioning Model**
   - Self-provisioning creates Tenant CRs directly for Phase 3 scope.
   - Naming/team constraints and resource defaults are policy-driven by the control-plane.
   - Version pinning remains supported through the existing OpenClaw version field.

3. **Approval and 2FA Direction**
   - Approval flow is moved to future work and is not a Phase 3 gate.
   - When approval flow is enabled later, it uses bearer-token auth initially.
   - Add an optional 2FA toggle for approval actions as part of that future approval rollout.

4. **Memory Upgrade Rollout**
   - Move memory cutover into this phase: migrate from PostgreSQL-only retrieval runtime to Cognee write-through orchestration for all tenants.
   - Use a hard switch rollout (no dual-read fallback window) once migration validation passes.
   - Keep OpenClaw as source connector and policy enforcement boundary.
   - Enforce dataset granularity, AccessPolicy mapping, and source-permission propagation as mandatory rollout gates.
   - Freshness/invalidation is deferred to Sprint 3+ and will be integrated and controlled from Clawdbot.

**Action**: Ship portal + memory cutover in Phase 3 with bearer-token baseline auth. Keep approval workflow and OIDC in future work, and carry optional approval 2FA as a planned extension.

---

### Deliverables

1. **Web Portal** (embedded in apps/control-plane-ui)
   - Angular 20 feature modules in the existing control-plane-ui app.
   - API calls go through dedicated core services in `core/api/`.
   - Feature pages:
     - **Dashboard**: List my tenants, health, spend, last reconciled.
     - **Provision**: Form (name, email, team, openclawVersion pin, policy).
     - **Tenant Detail**: Config view, logs, resource usage.
     - **Admin Panel**: Tenant visibility and audit log visibility.
    - Add dataset-assignment UI in control-plane-ui for org/team/project/personal dataset membership and visibility.
   - Auth: bearer token for this phase.

2. **Memory Cutover: Cognee Write-Through**
   - Replace PostgreSQL-only retrieval runtime path with Cognee orchestration (`docs/memory.md`).
   - Cut over all tenants in a single hard-switch migration window.
   - Keep OpenClaw responsible for source ingestion, permission-aware copy semantics, and retrieval mediation.
   - Implement dataset-level access wiring from AccessPolicy outcomes for org/team/project/personal scopes.

3. **Dual-write write-path simplification**
   - Migrate projection writes from request-path dual-write to a watcher-fed projector component.
   - Retire request-path PostgreSQL mutation for dual-written Tenant and AccessPolicy entities.
   - Add idempotency keys and bounded reconciliation lag objectives.

4. **Future Work (Explicitly Deferred)**
   - Approval flow routes and CRD fields.
   - Approval action security with bearer token + optional 2FA toggle.
   - OIDC migration for portal and control-plane auth.
   - Freshness/invalidation implementation, integrated and controlled from Clawdbot.

### File Structure Additions

```
apps/
├── control-plane-ui/
│   └── src/app/
│       ├── core/
│       │   └── api/
│       │       ├── tenants.service.ts
│       │       ├── spend.service.ts
│       │       └── policies.service.ts
│       ├── shared/
│       │   └── components/
│       │       ├── tenant-form/
│       │       ├── tenant-card/
│       │       └── spend-chart/
│       └── features/
│           ├── dashboard/
│           │   ├── dashboard.component.ts
│           │   └── dashboard.component.html
│           ├── provision/
│           │   ├── provision.component.ts
│           │   └── provision.component.html
│           ├── tenant-detail/
│           │   ├── tenant-detail.component.ts
│           │   └── tenant-detail.component.html
│           └── admin/
│               ├── admin.component.ts
│               └── admin.component.html
├── control-plane/
│   └── src/
│       ├── routes/
│       │   └── retrieval.ts
│       └── core/
│           └── memory/
│               ├── cognee-client.ts
│               ├── dataset-mapper.ts
│               └── freshness-policy.ts
```

### Key Tasks (Phase 3)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| Angular portal features scaffold + auth | Frontend | 12h | Phase 1 API |
| Tenant provisioning form + dashboard | Frontend | 15h | Control Plane API |
| Admin panel (visibility + audit) | Frontend | 8h | Portal routes |
| Dataset assignment UI in control-plane-ui (org/team/project/personal) | Frontend | 10h | Portal routes |
| Memory cutover to Cognee write-through | Backend | 20h | Phase 2 retrieval foundation |
| AccessPolicy -> Cognee dataset permission mapping | Backend | 10h | Memory cutover core |
| Portal -> control-plane integration | Backend | 8h | Portal code |
| Tests: provisioning + memory authorization | QA | 14h | All code |
| **Phase 3 Total** | | **97h** | |

### Success Criteria

- [x] Non-admin user can self-provision tenant via web form (ProvisionPageComponent + TenantApiService implemented).
- [x] Tenant appears in Kubernetes as Tenant CR within 30s (create route now polls Kubernetes and returns 504 if the CR is not visible within the SLO window).
- [x] Dashboard shows health, spend, and last reconciled time per tenant (DashboardPageComponent + SpendChartComponent implemented).
- [x] Retrieval runtime is cut over from PostgreSQL-only path to Cognee write-through for all tenants using a hard switch with direct OpenClaw/Clawdbot to Cognee calls.
- [x] AccessPolicy-compatible dataset permissions are enforced through control-plane-managed Cognee subject memberships (`/api/tenants/:name/datasets`).
- [x] control-plane-ui exposes dataset membership controls for org/team/project/personal scopes (Tenant Detail includes reusable Dataset Membership editor backed by `/api/tenants/:name/datasets`).
- [x] Approval flow remains explicitly deferred; no Phase 3 blocker depends on approval route delivery.
- [x] Freshness/invalidation is deferred to Sprint 3+ and controlled from Clawdbot.

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

## Effort Summary

| Phase | Effort | Timeline | Start |
|-------|--------|----------|-------|
| **Phase 1** (Core) | 90h | 3 weeks (2 eng + 1 ops) | Week 1 |
| **Phase 2** (Cost control + retrieval foundation) | 97h | 2-3 weeks (parallel to Phase 1 end) | Week 2 |
| **Phase 3** (Self-service + memory cutover) | 97h | 3 weeks (after Phase 2) | Week 4 |
| **Total** | **284h** | **7–9 weeks** | |

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

---

## How to Use This Plan

Each phase begins with an **Architecture Checkpoint**—a set of clarification questions. **Before starting a phase:**

1. **Read the checkpoint questions** for that phase.
2. **Answer them as a team** (product, engineering, ops).
3. **Document decisions** (even if brief—e.g., "Use async key generation with retry loop, 30-second timeout").
4. **Proceed with implementation** using the documented decisions.

This avoids rework and ensures alignment across teams.

---

## Phase-by-Phase Decisions Needed

### Phase 1 Decisions (Closed)
- [x] Helm chart owns LiteLLM directly; no separate subchart remains.
- [x] Operator baseline is single-replica.
- [x] Tenant isolation supports both GCS/Crossplane and PVC fallback.
- [x] Local full-stack install supports PostgreSQL-backed bring-up.
- [ ] Deferred hardening decisions remain open under the hardening backlog, not Phase 1.

### Phase 2 Decisions (Locked 2026-05-28)
- [x] LiteLLM namespace: same namespace as operator (decided — no separate namespace for Phase 2).
- [x] Virtual key generation: sync (block reconcile) — implemented in operator reconcile step 4.
- [x] Spend tracking: real-time from LiteLLM API, augmented with local budget metadata.
- [x] Hard budget enforcement: LiteLLM rejects on overage (429); control-plane warns at 80%.
- [x] Proxy optional: no — LiteLLM is cluster-wide; opt-out is not allowed.
- [x] Org index storage profile: PostgreSQL-only for MVP; pgvector deferred to Phase 3+.
- [x] Retrieval authorization source: AccessPolicy only — no additional ACL layer for Phase 2.
- [x] Retrieval failure behavior: explicit 403 authorization errors (not silent empty results).
- [x] First harvesting connector: Slack with cursor-based batch pull (15-minute interval).
- [x] Ingestion SLO thresholds: lag < 30 minutes p95, failure rate < 1% per sync cycle.
- [x] Single-writer ownership: operator sidecar owns PostgreSQL projection writes; request-path dual-writes retire in Phase 3.

### Phase 3 Decisions (Complete by Week 4)
- [x] Portal: embedded in Angular control-plane-ui (decided — no separate Next.js app)
- [x] Auth baseline: bearer token for Phase 3 delivery.
- [ ] OIDC migration plan: deferred to future work.
- [x] Slack bot scope removed from roadmap scope.
- [x] Approval workflow deferred to future work (not a Phase 3 gate).
- [x] Future approval security direction: bearer token + optional 2FA toggle.
- [x] Memory upgrade moved into Phase 3 required scope.
- [x] Memory cutover wave: all tenants.
- [x] Cutover mode: hard switch.
- [x] Dataset granularity: org, team, project, personal.
- [x] Dataset control surface: included in control-plane-ui.
- [x] Tenant CR SLO target: 30 seconds.
- [x] Freshness/invalidation: deferred to Sprint 3+ under Clawdbot control.

#### Phase 3 Decision Lock: AccessPolicy -> Cognee Mapping

- AccessPolicy remains the sole authorization source for retrieval decisions.
- Dataset scopes are enforced as org/team/project/personal, with deny-by-default behavior.
- Explicit deny always overrides allow on scope conflicts.
- Retrieval path grants read access only to datasets explicitly allowed by effective policy.
- Write/share/delete permissions are disabled by default and require explicit policy authorization.
- Every retrieval authorization outcome must be audit-logged with principal, dataset scope, action, decision, and policy reason.

#### Phase 3 Closure Rule: Deferred Approvals

- Approval flow remains a Sprint 3+ deliverable and is not a blocker for Phase 3 closure.
- Phase 3 is considered complete only if no success criterion depends on approval route delivery.
- Future approval implementation baseline remains bearer token auth with optional 2FA toggle.

---

## Go-Live Checklist (Deployable + Testable)

This checklist is the execution bridge from current progress to a repeatable production deployment.

| Item | Owner | Status | Done Criteria |
|------|-------|--------|---------------|
| Local baseline green (`pnpm install`, `pnpm test`, `pnpm build`) | Backend | Complete (validated 2026-04-16) | Commands pass locally after repository fixes. |
| Local platform e2e (`platform/tests/k3d-e2e.sh`) | Backend + QA | Complete (validated 2026-04-26) | Helm install succeeds; tenant reconcile smoke test passes in k3d. |
| Local full-stack bootstrap (`platform/tests/k3d-local.sh`) | Backend + DevOps | Complete (validated 2026-05-14 at script/render level) | Local path provisions PostgreSQL, control-plane, LiteLLM, migrations, and supports `default` + `strict` profiles. |
| Helm chart completion (`platform/helm/templates`) | DevOps | Complete for Phase 1 baseline | Operator and control-plane deploy cleanly with required env/volumes/RBAC for the current baseline. |
| GCP installer smoke (`./platform/install.sh gcp` or wizard) | DevOps | Not yet revalidated against latest parity changes | Fresh GCP project deploys end-to-end; control-plane endpoint reachable; test tenant reconciles successfully. |
| Docker image publish automation | DevOps | Complete | CI builds/tests/e2e and publishes images on `main`. |
| Prisma migration rollout (`prisma migrate deploy`) | Backend | Complete baseline | Migrations are committed and installer paths include migration execution. |
| CI e2e gate | QA + DevOps | Complete baseline | CI runs the k3d smoke path and blocks regressions for the validated baseline. |
| DNS + ingress verification | DevOps | Not started | Domain and TLS resolve correctly; control-plane and tenant subdomains accessible externally. |
| Runbook + rollback docs | Backend + DevOps | ✅ Complete (2026-05-28) | `docs/runbook.md` covers install, verify, upgrade, rollback, and incident-response steps. |

### Go/No-Go Criteria

- Go when all checklist items are complete and at least one full non-interactive GCP install succeeds in a clean project.
- No-Go if CI e2e gate, migration rollout, or external ingress verification is missing.

### Recommended Execution Order

1. Stabilize local baseline and k3d e2e.
2. Complete Helm templates and migration automation.
3. Add CI image publish and CI e2e gate.
4. Run GCP smoke in a clean project and validate DNS/ingress.
5. Finalize runbook and promote to production.

---

## Implementation Status Update (2026-05-28)

All major Phase 2 items are now implemented. The following sessions were completed in this cycle:

### Session 1 — Phase 2 architecture decisions locked
All open Phase 2 decisions resolved with concrete outcomes (see decision table above).

### Session 2 — LiteLLM governance
Already complete from previous cycle. Key generation, budget enforcement, spend endpoint, and tenant injection are all validated.

### Session 3 — Retrieval foundation
- `OrgDocument` and `HarvestingCursor` models added to Prisma schema (migration `0002_retrieval_foundation`).
- Retrieval mediation in control-plane is superseded; retrieval now goes directly from OpenClaw/Clawdbot to Cognee.
- Control-plane retains dataset membership and Cognee permission synchronization via `/api/tenants/:name/datasets`.

### Session 4 — Harvesting-agent MVP
- `apps/harvesting-agent` workspace package created with Slack source connector.
- Cursor-based incremental sync: loads/saves `HarvestingCursor` between cycles.
- Normalizes Slack messages to `NormalizedDocument` and upserts to `org_documents` via `_IngestDocuments`.
- `/metrics` and `/healthz` HTTP endpoints for monitoring.
- Configurable sync interval (default 15 minutes via `SLACK_SYNC_INTERVAL_MS`).

### Session 5 — MCP + tenant skill governance
- `skillAllowlist` field added to Tenant CRD and `TenantSpec` interface for durable, auditable skill governance.
- `mcpPolicy` field added to Tenant CRD and `TenantSpec` for per-tenant invocation-level MCP enforcement.
- `channels` field added to Tenant CRD for Slack/WhatsApp configuration (credential injection remains deferred).
- Operator deployment builder injects `OPENCRANE_TENANT_MCP_ALLOW` and `OPENCRANE_TENANT_MCP_DENY` env vars.
- `entrypoint.sh` updated: tenant CRD deny wins over policy-level allow; audit log messages on each decision.

### Session 6 — Projection drift alerting + ownership
- Webhook delivery added to `GET /api/metrics/projection-drift`: fires to `OPENCRANE_DRIFT_WEBHOOK_URL` when threshold exceeded.
- Single-writer ownership decision documented: operator sidecar is the authoritative projector; request-path dual-writes retire in Phase 3.

### Session 7 — runbook.md
- `docs/runbook.md` written with install, verification, upgrade, rollback, and incident-response procedures.
- Covers: LiteLLM key lifecycle, tenant lifecycle operations, projection drift remediation, observability reference.

### Session 8 — Angular portal features
- `TenantApiService` and `SpendApiService` added to `core/api/`.
- `TenantSummary`, `TenantSpend`, `CreateTenantPayload`, and tenant phase enums split into dedicated `core/models/*` files.
- Shared components: `TenantCardComponent`, `SpendChartComponent`.
- Feature pages: `DashboardPageComponent`, `ProvisionPageComponent`, `TenantDetailPageComponent`, `AdminPanelPageComponent`.
- App routes updated: `/dashboard`, `/provision`, `/tenants/:name`, `/admin`.

### Session 9 — Operational maturity foundation
- `TenantUpdateWithCanaryStrategyController` implemented in `apps/operator/src/tenant-rollout/` with npm release polling and canary rollout strategy.
- Prometheus-format `/prom/metrics` endpoint added to control-plane with tenant phase gauges, org document count, audit entry counter, and process metrics.
- `channels` model is being shifted toward adapter-oriented configuration rather than provider-specific inline schema.

### Session 10 — Dataset membership controls + retrieval authorization
- Added tenant dataset membership API endpoints: `GET /api/tenants/:name/datasets`, `PUT /api/tenants/:name/datasets` (Tenant CR annotation-backed).
- Added reusable `DatasetMembershipEditorComponent` in control-plane-ui Tenant Detail page for org/team/project/personal controls.
- Retrieval route now enforces dataset scope membership (`datasetScope`, `datasetId`) with explicit `DATASET_DENIED` responses and audit metadata.
- Added conformance tests for dataset allow/deny retrieval paths and tenant dataset endpoint coverage.

### Remaining work (not yet implemented)
- Approval flow routes (future work) — `POST /api/tenants/approve/:name` and `spec.approvalRequired` CRD field, with bearer-token auth and optional 2FA toggle.
- Channel credential injection into tenant pods (needs Secret reference wiring in deployment builder).
- GCS snapshot before canary rollback.
- Memory cutover implementation from PostgreSQL-only retrieval to Cognee write-through (`docs/memory.md`) with AccessPolicy-compatible authorization.
- Dataset granularity baseline is now implemented for org/team/project/personal membership controls in control-plane + control-plane-ui; source-permission propagation migration for source-restricted content remains open.
- Optional hardening: verify self-hosted Cognee audit completeness against OpenCrane incident and compliance requirements.
- Freshness/invalidation implementation using source ETag/version metadata and age-based revalidation.
- GCP smoke re-validation after Phase 2 changes.
- DNS + ingress verification.
