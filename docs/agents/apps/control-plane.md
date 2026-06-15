# App: control-plane (`@opencrane/control-plane`)

> Deep-dive for `apps/control-plane`. Index: [`../app-specific.md`](../app-specific.md). Identity model:
> [`../architecture.md`](../architecture.md). Verified June 2026.

The API-first management hub. **Express 5 + Prisma (PostgreSQL) + `@kubernetes/client-node`.** Source
of truth for tenants, policies, grants, MCP servers, skills; OIDC broker; the only writer of the
Postgres projection. Listens on `PORT` (default **8080**).

This is the platform management API served on the **platform's own domain** (e.g. `example.com`), separate from and above every customer. It
exposes both `/api/v1/cluster-tenants` (the **ClusterTenant** customer/isolation unit) and the tenant
endpoints (the **UserTenant** per-user OpenClaw gateway, CRD kind `Tenant`) — see
[`cluster-architecture.md` → Tenancy Model](../cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).

## Layout

- `infra/` — cross-cutting: `auth/` (OIDC service, device-grant, pod-token pairing, brokered-device registry), `middleware/` (`___AuthMiddleware`, transport security), `db/` (Prisma client + healthcheck).
- `core/` — domain logic (non-HTTP): `grants/` (grant compiler + Cognee sync), `awareness/` (fleet rollout, participation, metrics), `cluster-tenants/` (provisioner registry), `connections/` (kill-switch/gateway-admin), `oci/` (Zot bundle store + backfill), `personalisation/`, `platform-dns/`, `sessions/`, `scanning/`, `ai-budget/`.
- `features/` — higher-level workflows: `mcp-servers/`, `groups/`, `company-docs/`.
- `routes/` — HTTP handlers (each a `*.ts` + `*.types.ts` pair); `routes/internal/` are the auth-less, NetworkPolicy-gated endpoints.

## Bootstrap (`src/index.ts`)

Middleware order: transport-security → `express.json()` → `pino-http` → session → **`___AuthRouter` (public, mounted before auth)** → `___AuthMiddleware` → routes → error handler. DI: `___CreatePrismaClient` + `KubeConfig.loadFromDefault()` yielding `CustomObjectsApi` (CRDs), `CoreV1Api` (pod kill-switch), `AuthenticationV1Api` (TokenReview). `createApp(...)` is exported for tests.

## Router Inventory (`/api/v1`)

CRUD + notable actions:

- **tenants** (UserTenants — per-user OpenClaw gateways) — `+ suspend/resume`, `/drift`, `/repair`, `/datasets`, **`/effective-contract`** (compiled grants + rendered tools). Dual-writes CRD ↔ Postgres.
- **policies** — `+ drift/repair`; best-effort Cognee propagation. Dual-writes CRD ↔ Postgres.
- **cluster-tenants** (the customer/isolation unit) — manages the customer namespace + quota + base domain; gates `isolationTier` on the provisioner registry (`422 TIER_UNAVAILABLE`).
- **mcp-servers** — `+ credentials` (static-fallback vs per-user OBO brokering).
- **skills/catalog** — `+ /:id/scan`, promote-gate (publish only if scan passed), `/backfill` (DB→OCI dual-write).
- **groups**, **third-party-sources**, **provider-keys**, **access-tokens** (CLI tokens), **audit**, **metrics** (`/projection-drift` + alert webhook), **token-usage**, **ai-budget** (LiteLLM spend, read-only), **org/workspace-docs** (company-doc versioning + 3-way merge proposals), **platform/dns** (cert issuer + DNS), **awareness/rollout** (`+ promote/rollback/resolve`), **awareness/participation**, **sessions** (scope binding).

**Internal (`/api/internal`, no `___AuthMiddleware`):** `obot-registry` (Obot polls), `bundles/:digest/content` (skill-registry proxies, entitlement-gated), `contract/:name` (pod re-pull, TokenReview), `awareness/participation` (TokenReview). Plus projection drift/repair helpers.

## Auth Subsystem (`infra/auth/`)

- **OIDC** — PKCE login → session cookie (human operators). Email allow-list / domain allow-list optional.
- **Device flow** — `POST /auth/device` → browser activate → poll `/auth/device/token` → mints a DB `AccessToken` (this is what `oc auth login` uses).
- **pod-token pairing broker** — `POST /api/v1/auth/pod-token` resolves the tenant **solely from the verified session email** (fail-closed `409 AMBIGUOUS_TENANT`), returns `{ gatewayUrl, bootstrapToken, tenant, ingressHost }`, and records a `BrokeredDevice` for per-user kill-switch. `/pod-token/cut` revokes the caller's connections without touching the shared pod.
- **`___AuthMiddleware` fallback chain** — public paths → OIDC session → `OPENCRANE_API_TOKEN` env → DB access token → dev bypass. **No per-route role enforcement yet** (roles are a planned target).
- **TokenReview** — internal endpoints validate projected tokens with `aud=control-plane`, parsing the tenant from `system:serviceaccount:<ns>:<name>`.

## Dual-Write & Grant Compiler

Tenant/AccessPolicy mutations write both the CRD (operator's source of truth) and the Postgres row (API/UI projection). Drift is expected; `/drift` detects and `/repair` (dry-run by default) fixes CRD→DB. The **grant compiler** (`core/grants/`) resolves `(principal, payloadType ∈ Awareness|McpServer|SkillBundle)` over group membership with precedence `priority` > Deny-over-Allow > newest. It powers `effective-contract`, internal bundle gating (404 existence-hiding), and session-scope intersection.

## Prisma Schema (`prisma/schema.prisma`)

PostgreSQL. ~30 models incl. `Tenant`, `ClusterTenant`, `AccessPolicy`, `Group`, `Grant`/`McpServerGrant`/`SkillEntitlement`, `McpServer`/`McpServerCredential`, `SkillBundle`/`SkillPromotion`, `ThirdPartySource(+Item)`, `BrokeredDevice`, `AccessToken`, `ProviderApiKey`, `AuditEntry`, `SessionScope`, `AwarenessRollout`, `ParticipationEvent`/`TenantParticipation`, `CompanyDoc(+Version)`/`TenantWorkspaceDoc`/`DocMergeProposal`, `OrgDocument`/`HarvestingCursor`, `TenantDatasetMembership`, budget/usage snapshots. Enums mirror `@opencrane/contracts` (GrantAccess/Scope/SubjectType, McpServer*, SkillBundle*, ClusterTenant*, etc.).

## Key Env

`PORT` (8080), `DATABASE_URL`, `NAMESPACE`, `OPENCRANE_API_TOKEN`, OIDC (`OIDC_ISSUER_URL`/`CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI`/`SESSION_SECRET`/`ALLOWED_EMAIL(_DOMAINS)`), `SKILL_OCI_REGISTRY_URL`/`SKILL_OCI_REPOSITORY`, `COGNEE_ENDPOINT`, `LITELLM_ENDPOINT`/`_MASTER_KEY`, `CLUSTER_TENANT_PROVISIONER_WEBHOOK_*`, `OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD`/`_DRIFT_WEBHOOK_URL`, `OPENCRANE_FORCE_HTTPS`.

## In-flight

OCI/Zot skill delivery is mid-cutover (dual-write DB + registry; resolve OCI-first, DB fallback). Awareness rollout `shadowMode` and the doc-reconciliation merge agent are partly scaffolded. AI-budget enforcement lives in LiteLLM; the control-plane only reads spend.
