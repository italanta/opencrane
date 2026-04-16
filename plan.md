# OpenCrane Implementation Plan

## Executive Summary

This is an updated roadmap for shipping OpenCrane, the enterprise multi-tenant AI agent platform. The plan is updated with grounding in a competitive audit.

**Current state**: Phase 1 is ~60–70% built. All core operator, API, and UI code exists. Missing: Helm deployment templates, Docker image publishing, and end-to-end integration tests.

**Live update (2026-04-16)**:
- Phase II cost-control routing refactor is complete and validated.
- AI budget/spend/key management is consolidated under `/api/ai-budget`.
- Dedicated AI-budget router tests were added and are passing.
- Control-plane UI test pipeline is now fixed (Karma/Jasmine deps + spec config + baseline spec).
- Full workspace validation currently passes: `pnpm test` and `pnpm build`.

**Strategic approach**: OpenCrane differentiates by combining:
- **Architectural advantages**: GCS Fuse CSI + Workload Identity (cloud-native isolation), dual-write pattern (CRDs + PostgreSQL), policy-first governance (AccessPolicy CRDs → CiliumNetworkPolicy).
- **Tactical features**: Cost control (LiteLLM), self-service UX (web + Slack), fleet operations (auto-update, metrics, channel management).

**Next move**: Complete Phase 1 blockers (Helm templates, Docker builds, k3d tests) then execute Phase 2–4 sequentially. Each phase includes **architecture checkpoints**—clarification questions to lock in decisions before coding.

**Effort**: ~286 hours over 7–8 weeks (2 engineers + 1 ops), assuming clear architecture decisions upfront.

---

## Goal

Ship a production-grade multi-tenant OpenClaw platform that is:
1. **Architecturally differentiated**: GCS + IAM isolation, dual-write pattern, Crossplane-driven.
2. **Feature-complete for org rollout**: Cost control (LiteLLM), self-service UI, fleet updates.
3. **Operationally sound**: Observability, role-based access, policy-driven governance.

---

## Current Status: Phase 1 Audit (60–70% Complete)

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

### 🔴 Phase 1 Blockers (Still Needed)

| Item | Status | Impact |
|------|--------|--------|
| **Helm templates** (operator-deployment, control-plane-deployment) | ⚠️ Skeleton | Cannot deploy operator/control-plane yet |
| **Docker images published** | ❌ | No registry build/push pipeline |
| **Prisma migrations** | ⚠️ | Verify they exist and can run on Cloud SQL |
| **Tenant Dockerfile + entrypoint.sh** | ⚠️ | Verify complete (GCS mount, skills linking, gateway start) |
| **End-to-end k3d tests** | ❌ | Helm + operator + tenant reconcile integration tests |

### 📋 Before Phase 1 Completion

**Immediate tasks** (this week):
1. Audit and complete Helm deployment templates (operator, control-plane)
2. Create CI/CD pipeline for Docker image builds → ghcr.io
3. Run Helm chart against k3d with real Tenant CR; verify operator reconciles
4. Verify Prisma migrations run on Cloud SQL

**Then** proceed to Phase 2 (LiteLLM cost control).

### Deferred While Starting Phase II

These items are intentionally deferred so Phase II can proceed now. Track them as a backlog tied to Phase II stabilization.

#### 1) Runtime hardening baseline in tenant pods

Status: Not implemented yet.

Scope:
- Add pod/container `securityContext` defaults for tenant runtime.
- Run as non-root user/group.
- Disable privilege escalation.
- Drop Linux capabilities.
- Enable seccomp runtime default profile.
- Use read-only root filesystem where compatible.

Why deferred:
- Requires runtime compatibility testing and may affect startup/update behavior.

#### 2) Stronger least-privilege and file access limits

Status: Partially implemented.

Scope:
- Keep writable paths to a strict allowlist (`/data/openclaw`, `/data/secrets`, temp dirs as needed).
- Prevent accidental writes to base filesystem.
- Verify secret mounts remain read-only and minimally scoped.

Why deferred:
- Needs app/runtime validation and migration plan for any write-path assumptions.

#### 3) Enforce tool allowlist policy at runtime

Status: Policy fields exist, enforcement is incomplete.

Scope:
- Enforce `mcpServers.allow/deny` from AccessPolicy in runtime behavior.
- Add deny/audit events when blocked tools are requested.
- Add conformance tests for allow/deny behavior.

Why deferred:
- Requires policy-to-runtime plumbing and test coverage expansion.

#### 4) Tenant `policyRef` binding behavior

Status: Deferred architecture decision.

Scope:
- Define exact behavior of `Tenant.spec.policyRef` relative to selector-based AccessPolicy reconciliation.
- Implement deterministic precedence and conflict rules.

Why deferred:
- Needs product/architecture decision before code.

#### 5) Tenant `skills` filtering behavior

Status: Deferred architecture decision.

Scope:
- Implement per-tenant skill filtering instead of mounting all shared skills.
- Decide mechanism: subdirectory mount, symlink subset, or alternative packaging.

Why deferred:
- Needs UX/security decision and skill distribution strategy.

#### 6) Suspend logic aware of scheduled/background work

Status: Not implemented yet.

Scope:
- Prevent idle suspend when background jobs are running or jobs are due soon.
- Add a durable scheduler source of truth outside the pod.
- Wake suspended tenant pods when scheduled work is due.

Why deferred:
- Requires scheduler contract and state model that overlaps with Phase II work.

#### 7) Managed runtime awareness contract for OpenClaw

Status: Not implemented yet.

Scope:
- Inject managed-cluster runtime mode env vars/config.
- Define capability contract endpoint/payload for runtime policy awareness.

Why deferred:
- Depends on final Phase II contracts for keying, policy, and scheduling.

#### Entry criteria to pick these up

Start implementation when Phase II core deliverables are in place and stable:
- Cost control path functional end-to-end.
- Key issuance/rotation flow stable in non-prod.
- Baseline e2e passing in CI.

#### Exit criteria for this backlog

These deferred improvements are complete when:
- Hardening defaults are enforced and validated in e2e.
- Tool policy allow/deny is enforceable and audited.
- `policyRef` and `skills` behavior is deterministic and documented.
- Idle/suspend behavior is safe for scheduled/background workloads.
- Runtime managed-mode contract is documented and used by tenant runtime.

---

## Phase 1: Core Platform (Must Ship First)

### Architecture Checkpoint: Phase 1 Decisions

Before finalizing Phase 1 templates and tests, answer these questions:

1. **Helm Chart Structure**
   - Should the Helm chart include optional subchart dependencies (LiteLLM, Prometheus) from the start, or keep Phase 1 minimal and add subcharts in Phase 2/4?
   - Should we support both "all-in-one" (with bundled PostgreSQL for dev) and "production" (external Cloud SQL) profiles, or assume external DB only?

2. **Operator Deployment**
   - Should the operator pod run as non-root from day 1, with read-only root FS and dropped Linux capabilities?
   - Should the operator use leader election (for HA multi-replica setup) or single-replica in Phase 1?
   - Should we include RBAC binding for Workload Identity annotation of the operator pod's ServiceAccount?

3. **Tenant Pod Isolation**
   - Should GCS Fuse CSI be required, or do we provide a PVC fallback for local/non-GCP clusters?
   - Should the tenant pod run as non-root (uid 1000) by default?
   - Should NetworkPolicy be enforced at creation time (operator creates default-deny + allow from operator/shared services) or is that a later phase?

4. **Control Plane Deployment**
   - Should the control-plane pod(s) expose `/metrics` for Prometheus, or leave that to Phase 4?
   - Should the control-plane assume Cloud SQL is the sole DB, or provide Helm option for local PostgreSQL?
   - Should API auth be OIDC (via external provider) or stick with bearer token until Phase 3 UX?

5. **Terraform & IaC**
   - Should Terraform create the GCP service account for Workload Identity, or assume it's pre-created?
   - Should Terraform deploy Crossplane and the GCP provider, or just create the GKE cluster and assume Crossplane is installed separately?
   - Should we include Terraform for the artifact registry image push, or handle that in the CI/CD pipeline?

**Action**: Answer these questions before task assignment. They determine which templates to fill in first.

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

2. **Helm Chart** (charts/opencrane/)
   - Values for all components: operator, control-plane, shared skills PVC, CRDs.
   - Namespace creation, RBAC (operator ClusterRole, control-plane Role).
   - CRD templates (Tenant, AccessPolicy, BucketClaim).
   - Conditional subchart for internal PostgreSQL (for dev) or external (for prod).

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

- [ ] Operator reconciles a Tenant CR end-to-end (ServiceAccount → Deployment → Ingress → status).
- [ ] AccessPolicy CRD generates CiliumNetworkPolicy per tenant.
- [ ] `helm install opencrane platform/helm/` deploys operator + CRDs.
- [ ] Terraform applies GKE cluster + Crossplane.
- [ ] Tenant pod starts, mounts GCS bucket, links skills, starts OpenClaw gateway on port 18789.
- [ ] Tenant is accessible at `https://{tenant}.opencrane.io` via Ingress.

---

## Phase 2: Cost Control via LiteLLM

### Architecture Checkpoint: LiteLLM Integration

Before implementing LiteLLM, clarify:

1. **LiteLLM Deployment Model**
   - Should LiteLLM be deployed in the same namespace as the operator/control-plane, or in a separate `litellm` namespace?
   - Should we use the official LiteLLM Helm chart as a dependency, or create a minimal custom chart?
   - Should LiteLLM's database be Cloud SQL (shared with control-plane) or a separate instance?

2. **Virtual Key Generation**
   - Who initiates virtual key creation? Operator during Tenant reconcile, or pre-generated in a pool?
   - Should key generation be synchronous (block reconcile until key is created) or async (retry on startup)?
   - Should keys auto-rotate on a schedule, or are they static per tenant?

3. **Spend Tracking**
   - Should we track spend per tenant, per model, or both?
   - Should `/api/spend` aggregate data from LiteLLM API or read from a shadow table in our PostgreSQL?
   - Should hard budget enforcement be in LiteLLM (returns 429 when exceeded) or in the control-plane (warns but allows)?

4. **Tenant Config Injection**
   - Should the LiteLLM proxy endpoint be injected as an env var or as a file in the ConfigMap?
   - Should tenants be able to override the proxy endpoint, or is it always cluster-local `http://litellm:4000`?
   - Should the proxy be optional (tenants can use direct API keys if they opt out)?

5. **Observability & Alerts**
   - Should we surface LiteLLM health/errors in the control-plane API, or assume it's OK if the endpoint is reachable?
   - Should we alert if a tenant exceeds 80% of monthly budget?

**Action**: Answer these, especially key generation model (sync vs. async), before writing the operator integration.

---

### Deliverables

1. **LiteLLM Helm Subchart** (platform/helm/charts/litellm/)
   - Uses official LiteLLM Helm chart as dependency or custom minimal chart.
   - Deployment with `LITELLM_MASTER_KEY`, `LITELLM_DATABASE_URL` (Cloud SQL).
   - Service on `litellm:4000` (in-cluster).
   - ConfigMap for model routing rules.

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

### File Structure Additions

```
platform/
├── helm/
│   ├── charts/litellm/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── templates/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   └── README.md
│   └── Chart.yaml  # add litellm as dependency
```

### Key Tasks (Phase 2)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| LiteLLM Helm subchart | DevOps | 8h | Phase 1 done |
| Operator: LiteLLM key generation on reconcile | Backend | 10h | LiteLLM chart deployed |
| Control Plane: /api/spend endpoint | Backend | 8h | LiteLLM chart + schema |
| Tenant config injection of proxy endpoint | Backend | 5h | Operator enhancement |
| Tests: key generation, spend queries | QA | 10h | All code |
| **Phase 2 Total** | | **41h** | |

### Success Criteria

- [ ] Helm chart deploys LiteLLM with Cloud SQL.
- [ ] On Tenant CR creation, operator creates a LiteLLM virtual key with monthly budget.
- [ ] Tenant pod receives `LITELLM_API_KEY` and proxy endpoint.
- [ ] Control Plane exposes spend endpoint; shows per-tenant usage + budget.
- [ ] Dashboard can display "You have $X of $Y budget" per tenant.

---

## Phase 3: Self-Service Provisioning

### Architecture Checkpoint: Self-Service UI & Slack Bot

Before building the portal and Slack bot, decide:

1. **Web Portal Stack**
   - Portal is embedded in the existing control-plane-ui (Angular). No separate Next.js app.
   - Should auth be OIDC (Google/company SSO) or stay on bearer tokens from the control-plane API?
   - Should the portal features require a new Angular route module or extend existing feature structure?

2. **Tenant Provisioning Model**
   - Should self-provisioning create Tenant CRs directly (unrestricted), or require admin approval?
   - Should there be a limited set of allowed names/teams, or open-form naming?
   - Should users be able to pin OpenClaw versions, or always use `latest`?
   - Should users be able to set resource limits (CPU/memory/storage), or use org defaults only?

3. **Slack Bot Scope**
   - Should `/opencrane create` be a simple command (create with name only) or a form interaction?
   - Should the bot support other commands (logs, restart, delete)? Or just create/status/delete for Phase 3?
   - Should it post detailed status to a #opencrane-announcements channel, or DM the user?
   - Should it integrate with approval workflows (if enabled), or auto-approve?

4. **Data Model**
   - Should we add a `createdBy` and `lastModifiedBy` field to Tenant spec to track ownership?
   - Should there be a `requestStatus` field (Pending, Approved, Rejected) in the Tenant CRD?
   - Should audit log include who created/deleted/approved each tenant?

5. **Approval Workflow (Optional)**
   - If approvals are required, who approves? (All admins, specific team, automatically after 24h?)
   - Should approval be in the portal, via Slack reaction, or both?
   - Should unapproved tenants consume resources (stay in Pending state without Deployment)?

**Action**: Decide on OIDC vs. bearer token auth, approval logic, and scope (portal only, Slack only, or both) before writing code.

---

### Deliverables

1. **Web Portal** (embedded in apps/control-plane-ui)
   - Angular 20 feature modules added to the existing control-plane-ui app.
   - API calls go through dedicated core services in `core/api/`.
   - Feature pages:
     - **Dashboard**: List my tenants, health, spend, last reconciled.
     - **Provision**: Form (name, email, team, openclawVersion pin, policy).
     - **Tenant Detail**: Config view, logs, resource usage.
     - **Admin Panel**: List all tenants, approve pending requests, view audit log.
   - Auth: bearer token (interim); OIDC deferred to Phase 3+ decision.

2. **Control Plane Enhancement: Approval Flow (Optional)**
   - New Tenant CRD field: `spec.approvalRequired: bool`.
   - New route `POST /api/tenants/approve/:name` (admin only).
   - Webhook or polling loop: if approval required, Tenant stays in Pending until approved.

3. **Slack Bot** (apps/operator or apps/slack-bot)
   - `/opencrane create`: Slash command form, creates Tenant CR with user context.
   - `/opencrane status <name>`: Shows phase, ingress host, spend.
   - `/opencrane delete <name>`: Deletes tenant (with confirmation button).
   - Notifications: Post to #opencrane-deployments on tenant creation/failure.

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
├── slack-bot/
│   ├── src/
│   │   ├── index.ts         # Slack Bolt app
│   │   ├── commands/
│   │   │   ├── create.ts   # /opencrane create
│   │   │   ├── status.ts   # /opencrane status
│   │   │   └── delete.ts   # /opencrane delete
│   │   ├── handlers/
│   │   │   └── app-mention.ts
│   │   └── utils/
│   │       └── k8s.ts      # Tenant CR creation
│   ├── package.json
│   └── manifest.yaml       # Slack app manifest
```

### Key Tasks (Phase 3)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| Angular portal features scaffold + auth | Frontend | 12h | Phase 1 API |
| Tenant provisioning form + dashboard | Frontend | 15h | Control Plane API |
| Admin panel (list, approve, audit) | Frontend | 10h | Approval flow |
| Control Plane approval flow (optional) | Backend | 8h | Phase 1 done |
| Slack bot (create/status/delete) | Backend | 15h | K8s client setup |
| Portal → control-plane integration | Backend | 8h | Portal code |
| Tests: provisioning, Slack commands | QA | 12h | All code |
| **Phase 3 Total** | | **80h** | |

### Success Criteria

- [ ] Non-admin user can self-provision tenant via web form.
- [ ] Tenant appears in Kubernetes as Tenant CR within 30s.
- [ ] Dashboard shows health, spend, and last reconciled time per tenant.
- [ ] Admin can approve pending tenants (if approval flow enabled).
- [ ] Slack `/opencrane create` creates tenants from Slack.
- [ ] Slack bot posts status + error notifications to #channel.

---

## Phase 4: Operational Maturity

### Architecture Checkpoint: Fleet Operations & Governance

Before implementing updates, metrics, and self-config, clarify:

1. **Fleet Update Strategy**
   - Should the operator watch npm for new OpenClaw releases and auto-update tenants?
   - Should version pinning be enforced (pinned tenants never auto-update), or is it advisory only?
   - Should canary rollout be automatic (1 tenant → all success → roll to rest) or require manual approval?
   - Should we back up to GCS before every update? Or only on rollback failure?
   - How long should the operator wait for a pod to become Ready before rolling back? (default 5min?)

2. **Channel Configuration**
   - Should Slack/WhatsApp credentials be stored as Secrets (with operator injecting them) or configured in the tenant itself?
   - Should channels be specified at create time or changeable post-creation?
   - Should there be a shared org default channel, or only per-tenant channels?

3. **Observability & Metrics**
   - Should tenant pods export Prometheus metrics directly, or use a sidecar?
   - Should metrics include: token usage, last action timestamp, error count? Anything else?
   - Should the operator export reconciliation duration, resource creation errors, watch lag?
   - Should we set up Grafana dashboards, or just Prometheus targets?

4. **Agent Self-Config Governance**
   - Is this required for Phase 4, or can it be deferred to Phase 5?
   - If required, should agents request skills via an API endpoint or a special message to the operator?
   - Should allowlist be per-tenant or org-wide?
   - Should denied requests alert the operator, or silently fail?

5. **Channel Auto-Discovery**
   - Should the operator listens for annotations on Tenants (e.g., `slack.channel=C123`) and auto-inject?
   - Or is channel config purely in the Tenant spec?

**Action**: Decide on auto-update policy (canary + auto, or manual), whether channel configs are Secret-backed, and whether agent self-config is a must-have for this phase.

---

### Deliverables

1. **Fleet Update Controller** (operator enhancement)
   - Watch for OpenClaw releases on npm (or polling).
   - Rolling update strategy: canary (1 tenant) → rest.
   - Before update: GCS snapshot via gcloud.
   - On pod startup failure: auto-rollback.
   - Respect `spec.openclawVersion` pin (don't auto-update if pinned).
   - Logging: operator logs all actions, control plane surfaces update history.

2. **Channel Config in Tenant CRD**
   - New spec fields:
     ```yaml
     spec:
       channels:
         slack:
           workspaceId: xoxb-...
           channelId: C123...
         whatsapp:
           phoneNumber: "+1..."
     ```
   - Operator injects creds into tenant ConfigMap.

3. **Prometheus Metrics per Tenant**
   - Tenant pod exports metrics: token usage, last action timestamp, error count.
   - Operator exposes metrics: reconcile duration, status phase.
   - ServiceMonitor CRD for Prometheus scrape.

4. **Agent Self-Configuration Governance** (optional, lower priority)
   - New CRD: `OpenClawSelfConfig` (allowlist of skills agents can request).
   - Agent runtime calls `/api/self-config/request` → validated against allowlist → approved/denied logged.

### Key Tasks (Phase 4)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| Fleet update controller (operator) | Backend | 20h | GCS API integration |
| Channel config in Tenant CRD | Backend | 10h | Secrets/config injection |
| Prometheus ServiceMonitor per tenant | DevOps | 10h | Metrics setup |
| Agent self-config allowlist CRD | Backend | 12h | Operator done |
| Dashboard: update history, channel config | Frontend | 8h | Phase 3 UI |
| Integration tests: canary update, rollback | QA | 15h | Fleet controller code |
| **Phase 4 Total** | | **75h** | |

### Success Criteria

- [ ] Operator detects new OpenClaw release.
- [ ] Canary updates 1 tenant, waits for confirmation, rolls to rest.
- [ ] On failure, auto-rollback restores from GCS snapshot.
- [ ] Tenant CRD supports Slack/WhatsApp channel config.
- [ ] Operator injects channel creds into tenant pod.
- [ ] Prometheus scrapes tenant metrics; grafana dashboard shows usage.

---

## Cross-Phase Priorities

### Must Do Before Public Release

1. **Security Hardening**: Non-root pod, read-only root fs, drop Linux caps, resource limits, NetworkPolicy default-deny (done in AccessPolicy operator).
2. **Documentation**: Deployment guide, operator reference, example Tenant CRs, troubleshooting.
3. **RBAC**: Operator ClusterRole, control-plane Role, per-tenant ServiceAccount Workload Identity.
4. **Testing**: Operator integration tests (k3d), control-plane API tests, Helm chart validation.
5. **Observability**: Structured logging (pino), Cloud Logging ingestion, operator metrics.

### Nice to Have (Phase 4+)

1. Observability: OTel → ClickHouse for audit trail.
2. Advanced governance: policy approvals, audit webhook.
3. Advanced scheduling: tenant pod affinity, PDB for disruption budgets.

---

## Effort Summary

| Phase | Effort | Timeline | Start |
|-------|--------|----------|-------|
| **Phase 1** (Core) | 90h | 3 weeks (2 eng + 1 ops) | Week 1 |
| **Phase 2** (Cost control) | 41h | 1 week (parallel to Phase 1 end) | Week 2 |
| **Phase 3** (Self-service) | 80h | 2–3 weeks (after Phase 1) | Week 4 |
| **Phase 4** (Maturity) | 75h | 2–3 weeks (after Phase 2) | Week 5 |
| **Total** | **286h** | **7–8 weeks** | |

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Operator watch/reconcile bugs break tenant pods | Early k3d integration tests, canary rollout strategy for operator updates |
| GCS Fuse CSI mount failures | Mount readiness check in pod init, fallback PVC if CSI unavailable |
| Control-plane DB scaling | Postgres connection pooling, read replicas for analytics |
| LiteLLM key generation during reconcile blocks tenant creation | Async key generation + retry loop, fallback to pre-generated key pool |
| Slack bot auth expires | Token rotation via Slack renew API, operator watches for stale tokens |
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

### Phase 1 Decisions (Complete by Week 1)
- [ ] Helm chart structure: all-in-one (bundled Postgres) or production-only (external Cloud SQL)?
- [ ] Operator HA: single-replica or leader election multi-replica?
- [ ] Operator security: non-root, read-only FS, dropped caps from day 1?
- [ ] Tenant isolation: GCS Fuse required or PVC fallback?
- [ ] NetworkPolicy: enforced at creation or later phase?
- [ ] Terraform scope: manage service accounts, Crossplane, artifact registry?

### Phase 2 Decisions (Complete by Week 3)
- [ ] LiteLLM namespace: same as operator or separate?
- [ ] Virtual key generation: sync (block reconcile) or async (retry)?
- [ ] Spend tracking: aggregated in control-plane DB or queried real-time from LiteLLM?
- [ ] Hard budget enforcement: LiteLLM rejects on overage or control-plane warns?
- [ ] Proxy optional: tenants can opt out of LiteLLM?

### Phase 3 Decisions (Complete by Week 4)
- [x] Portal: embedded in Angular control-plane-ui (decided — no separate Next.js app)
- [ ] Auth: OIDC or bearer token?
- [ ] Approval required: yes/no, and if yes, auto-approval or manual process?
- [ ] Slack bot scope: create, status, delete only, or more commands?
- [ ] Slack form interaction: simple command or elaborate form flow?

### Phase 4 Decisions (Complete by Week 6)
- [ ] Auto-update: automatic canary rollout, or manual approval?
- [ ] Canary duration: how long to wait for pod Ready before rollback?
- [ ] Backup: GCS snapshot before every update or only on failure?
- [ ] Channel config: Secret-backed or Tenant spec field?
- [ ] Agent self-config: required for Phase 4 or defer to Phase 5?
- [ ] Metrics: sidecar or direct export from pod?

---

## Next Immediate Step

### Week 1: Finish Phase 1 Blockers

**Prerequisite:** Answer Phase 1 checkpoint questions above.

**Concrete tasks:**
1. **Audit Helm templates** (platform/helm/templates/):
   - Is `operator-deployment.yaml` fully configured (image, env vars, mount points, RBAC ref)?
   - Is `control-plane-deployment.yaml` complete (container, volumes, service discovery)?
   - Are CRD manifests present (crds/tenant.opencrane.io_tenants.yaml, etc.)?
   - What's missing and needs to be filled in?

2. **Docker build + publish pipeline:**
   - Create GitHub Actions workflow (or similar) to:
     - Build `operator`, `control-plane`, `tenant` images on every push to main.
     - Push to ghcr.io/opencrane-platform/[image]:latest and :[git-sha].
   - Document how to test locally (docker build -f apps/operator/deploy/Dockerfile).

3. **Verify Prisma migrations:**
   - Do migration files exist in `apps/control-plane/prisma/migrations/`?
   - Can they run on Cloud SQL? (Test locally with `prisma migrate deploy`.)
   - Are they tracked in git?

4. **Verify tenant entrypoint:**
   - Does `apps/tenant/deploy/entrypoint.sh` handle:
     - Detecting OPENCLAW_VERSION from env?
     - Mounting GCS bucket at `/data/openclaw/`?
     - Linking org/team skills from shared PVC?
     - Starting OpenClaw gateway on port 18789?
   - Any gaps to fill?

5. **k3d integration test:**
   - Clone the repo locally.
   - Run `helm install opencrane platform/helm/ -f values-dev.yaml` on k3d.
   - Create a sample Tenant CR: `kubectl apply -f - <<EOF ... EOF`.
   - Verify operator reconciles (check `kubectl logs -l app=opencrane-operator`).
   - Verify tenant pod starts (check `kubectl logs -l tenant=sample-name`).
   - Verify Ingress is created and accessible.
   - Document findings + blockers.

**Outcome:** Phase 1 is shippable (all templates complete, images published, tests passing).

**Then:** Proceed to Phase 2 once Phase 1 questions are answered and blockers resolved.
