# Spec: MCP Catalogue, Credentials & Per-User Activation

> **Status:** Reconciled with P0 (PR #40 landed the prerequisites) · **Date:** 20 June 2026,
> updated 21 June 2026 · **Owner:** Jente Rosseel
> **Decision:** Keep Obot as the MCP catalogue + gateway + credential broker + server host (MIT; the
> integration is fixed — see §9 / PR #40). OpenCrane does **not** rebuild catalogue/approval/credentials —
> it **drives Obot's native model**, maps identities, and activates each user's OpenClaw. Grounded in Obot
> docs (obot-platform/obot `/docs`, v0.23.x) + the MCP security best-practices doc. The Obot facts below
> were **confirmed against the pinned v0.23.1 source in P0** (and corrected where the draft was wrong — see
> §9). See [[reference_runtime_plane_config]].

## 1. Goal

An org curates which MCP tools its people may use; individuals install approved tools and connect their own
credentials **without the secret passing through the agent/LLM**; each person's OpenClaw ("Claw") becomes
aware of the tool automatically.

## 2. Design principle — Obot already does almost all of this

Reading Obot's docs: it natively provides the **catalogue, admin publish/approval, per-user & per-group
access control, per-user/shared credential collection + injection, server hosting, an RBAC model, and a
discovery API.** So OpenCrane builds only the thin glue:

1. **Identity federation** — OpenCrane OIDC identity → Obot user + role (so Obot can apply access policies + pick per-user credentials).
2. **Frontend surface** — present Obot's catalogue/connect in WeOwnAI (we do not expose Obot's own admin UI to tenants).
3. **Claw activation** — write Obot's per-user connection URL into the user's `openclaw.json` `mcp.servers`.

**Licence note (reassuring for "keep Obot"):** Obot Enterprise adds *only* extra auth providers (Okta/Entra)
and extra model providers (Azure/Bedrock) — neither of which we need from Obot (we have our own OIDC +
LiteLLM). Every feature below is in the **MIT open core**. Residual risk is future open-core relicensing
(VC-backed); mitigate by pinning (v0.23.1, PR #37) + mirroring + CI licence-gate + keeping the seam thin.

## 3. Obot server types (this is how "individual vs shared credentials" is modelled)

| Obot type | Credential model | Hosting | Use for |
|---|---|---|---|
| **Single-user** | **Per-user** — each user supplies their own key (`env` params, `sensitive`) | Obot deploys a per-user instance | Personal accounts (individual GitHub token) |
| **Multi-user** | **Shared** org key, or self-auth OAuth | Obot deploys one shared instance | Org service accounts; simple onboarding |
| **Multi-user catalog entry** (`serverUserType: multiUser`) | Shared deploy-level + per-user headers | Admin/Power-User+ **publishes**; shared deploy + per-user instances | **The "admin approves → users install" pattern** |
| **Remote** | Custom headers / config to the endpoint | **Not hosted** — a 3rd-party HTTPS endpoint | Vendor/SaaS or CI/CD-deployed MCP servers |
| **Composite** | Inherited from components | Virtual server over components | Aggregate + **per-tool RBAC**, curated tool names |

Hosting facts: non-remote types are **deployed + run by the Obot Gateway** (k8s pod per the runtime backend);
Obot **blocks localhost/private-IP/link-local by default** (`OBOT_SERVER_DISALLOW_*`) — the SSRF mitigation
from the MCP security doc, already handled. Credentials are declared per server as config params
(name/description/env-var key/`required`/`sensitive`) and injected as env into the Obot-hosted server.

## 4. Roles & governance (map to Obot's native RBAC)

Obot roles: **Owner · Admin · Power User+ · Power User · Basic User · Auditor.** Publishing/deploying
servers (npx/uvx/containerized) **runs code on the hosting backend** → Power User/Power User+ are
**privileged**. Mapping:

| OpenCrane actor | Obot role | Why |
|---|---|---|
| Platform / org admin | **Admin** (or Owner) | Full MCP Management: publish catalogue entries, manage access policies, user management. Pre-set via `OBOT_SERVER_AUTH_ADMIN_EMAILS`. |
| Tenant end-user | **Basic User** | Connect to entitled servers only. **Must NOT be Power User+** — that can deploy arbitrary code on the host. |
| (optional) trusted curator | Power User+ | Can create registries + share servers, if you want delegated curation. |

**Only org admins review the catalogue and approve MCPs; users install approved ones** — realised by:
- **Approve/publish** = an Admin/Power-User+ publishes a (multi-user) catalogue entry, and/or adds the server to an **MCP Access Policy**.
- **MCP Access Policies** map servers → users/groups ("which servers are available to which users"). ⚠️ Obot ships a default **"everyone" group** granting all users all policy-covered servers — **remove/restrict it** for multi-tenant isolation (keep admins broad).
- **Install** = a Basic User connects an entitled server (and supplies any per-user credential).

## 5. Flows

### 5.1 Admin — publish & set access (drives Obot)
Admin (Obot Admin role) adds/publishes a server (UI or **GitOps catalogue**, see P0) and assigns it to users/groups via an **MCP Access Policy**. Surfaced in WeOwnAI; gated by `requireOrgAdmin` on our side.

### 5.2 User — browse & install
User (Basic User) sees only servers an access policy grants them (via Obot's **registry API** `/v0.1/servers`, Auth mode → per-user). Install = connect/enable; Obot prepares a per-user connection (+ prompts for credentials, §5.3).

### 5.3 User — connect a credential (secure, out-of-band — never through the LLM)
Entry channel is **human → (WeOwnAI/control-plane) → Obot**, OIDC-authenticated, separate from the agent's chat/LLM/MCP channel.
- **Single-user (per-user key):** user enters the server's `sensitive` `env` params in Obot when enabling → Obot stores + injects them as env into that user's server instance. Write-only; audit the event, not the value.
- **Multi-user (shared key):** admin pre-configures one key for all users.
- **Remote / self-auth (OAuth):** browser OAuth per the MCP spec; Obot does the exchange.
- The token never enters the pod, `openclaw.json`, the LLM context, or the MCP transport — the agent only gets the **connection URL**.

### 5.4 Activation — make the Claw aware (§6).

### 5.5 Credential-required handoff
Broker returns `credential_required` → agent surfaces a **non-secret** "Connect <server>" deep link to the §5.3 form → user completes out-of-band → retry. **Never use MCP `elicitation` for secrets** (routes through the agent); elicitation is for non-secret input only.

## 6. Activation in the Claw + the identity prerequisite

OpenCrane already generates `openclaw.json`. Activation = the operator writing each entitled server into
`mcp.servers` using **Obot's per-user connection URL** + the projected token:

```json
{ "mcp": { "servers": { "<name>": {
  "url": "<obot per-user connection URL>",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer ${OBOT_MCP_TOKEN}" },
  "toolFilter": { "include": ["<allowed tools>"] }, "enabled": true
}}}}
```

- **⚠️ CRITICAL PREREQUISITE — Obot must know the user.** Per-user credentials + access policies require
  Obot to authenticate the caller. **Resolved in P0 (PR #40): enable + federate.** A gated `mcpGateway.auth`
  Helm block (default OFF, preserving today's in-cluster posture) turns on `ENABLE_AUTHENTICATION` +
  `ENABLE_REGISTRY_AUTH` + admin/owner emails + an optional bootstrap token. **Boundary confirmed in P0:**
  Obot has **no env-only OIDC provider**, so federating to OpenCrane's IdP (and removing the default
  "everyone" access policy) is a one-time **runtime** admin step (bootstrap-token login → add OIDC provider
  → grant admins), documented in `values.yaml mcpGateway.auth`.
- **Reload**: OpenClaw hot-applies `mcp.*` via **file-watch on `openclaw.json`**, NOT SIGHUP (P0 fix).
- **Token rotation**: projected SA token rotates (~600s); `${OBOT_MCP_TOKEN}` interpolates at load → refresh on rotation.
- **Broker hop**: Obot validates the user, resolves the per-(user) credential, forwards upstream. No token passthrough; secret never returns to the pod.

## 7. Security requirements (MCP best practices + Obot)
- **No secret through the LLM/chat/MCP transport** — credential entry is the human→Obot channel; agent gets only the connection URL.
- **No token passthrough** — Obot injects per-server/per-user creds.
- **Identity from verified OIDC/projected token**, never request input.
- **SSRF** — Obot blocks localhost/private/link-local by default (keep on).
- **Least privilege** — tenants are Basic User (cannot deploy code); composite servers give per-tool RBAC.
- **Encryption at rest** — P0: complete the `EncryptionConfiguration` init container.
- **Admin-only approval** — `requireOrgAdmin` (P0; no per-route RBAC today) + Obot Admin role mapping.
- **Audit** every publish/access-change/install/credential/brokered call; never the secret value.
- **Remove the default "everyone" access** so nothing is open by default.

## 8. API / CLI surface (API/CLI-first; frontend is just another client)
- **Discovery** is documented: Obot **MCP Registry API** `/v0.1/servers` (Auth mode → per-user). The Claw / frontend can list entitled servers here.
- **Management** (publish, access policies, credentials) is via Obot's admin UI + its broader API (see the repo `apiclient/`). **Corrected in P0:** `OBOT_SERVER_DEFAULT_MCPCATALOG_PATH` is a **local filesystem directory**, NOT a git URL. GitOps is done by adding **Git Source URLs at runtime** (Admin → MCP Servers → Git Source URLs) and/or syncing a catalogue git repo into that path. ⚠️ The programmatic **management API** surface (publish / access-policies / credentials) + the per-user **connection-URL** shape still need a live Obot v0.23.1 to confirm (P0.6 gap) — lean GitOps until then.
- OpenCrane wraps these as `oc mcp …` + `/api/v1/mcp/…`; WeOwnAI views: **Catalogue** (browse + admin publish), **My Tools** (install + status), **Connect** (set token / OAuth).

## 9. Dependencies & phasing
- **P0 — Keep-Obot-and-fix — ✅ DONE in PR #40:** (a) catalogue sync fixed — dropped the mis-wired
  `PROVIDER_REGISTRIES` (an LLM model-provider knob) + deleted the vestigial `/api/internal/obot-registry`
  endpoint; added `OBOT_SERVER_DEFAULT_MCPCATALOG_PATH` (a **local FS dir**, not git — see §8). (b) **auth
  enable + federate** wired as a gated knob (default OFF); OIDC-provider federation is a runtime step
  (see §6). (c) `openclaw.json` **file-watch reload** fixed (in-place rewrite; SIGHUP was a no-op). (d)
  encryption-at-rest **init container** completed (verbatim upstream + exact resource list). (e)
  `requireOrgAdmin` role guard added (IAM-first, fail-closed). (f) Obot v0.23.1 confirmation recorded —
  **two items still need a live instance: the management API surface + the per-user connection-URL shape.**
- **P1** catalogue + access (admin) · **P2** install + identity mapping · **P3** credential connect + `credential_required` handoff · **P4** Claw activation + OAuth.
  **⚠️ P1–P4 are gated on the two P0.6 live-Obot checks** (management API + per-user connection URL): the
  publish/access-policy and activation steps drive those exact surfaces. Confirm against a running
  v0.23.1 before building, or fall back to GitOps (Git Source URLs) for the catalogue.

## 10. Open questions / risks
- **Obot auth federation** — ✅ resolved in P0: enable + federate; the OIDC-provider wiring is a runtime step (Obot has no env-only OIDC provider). Mapping = OAuth identity → Obot user, roles pre-seeded via admin/owner emails (Basic User for tenants, Admin for org admins).
- **Management API** — ⚠️ STILL OPEN: registry API is discovery only; how to drive publish/access-policy/credentials programmatically (Obot API vs GitOps + UI) needs a live v0.23.1. Lean GitOps (Git Source URLs) until confirmed.
- **Entitlement authority** — Obot access policies *can* enforce per-tenant natively; lean Obot-native, OpenCrane drives intent + identity, with Claw-level narrowing as defence-in-depth. Reconcile with IAM-first.
- **Role enforcement gap** — ✅ resolved in P0: `_RequireOrgAdmin` middleware + `isOrgAdmin` on the verified OIDC identity (fail-closed); ready to wrap the P1 catalogue routes.
- **OpenClaw reload** — ✅ resolved in P0: file-watch via in-place `openclaw.json` rewrite (SIGHUP was a no-op). **token rotation** still needs a reconcile refresh of `${OBOT_MCP_TOKEN}` (the rotating projected SA token).
- **Obot long-term licence** — MIT today (needed features all in core), VC-backed open-core; pin/mirror/CI-gate, keep seam thin.

## Sources
- Obot docs (obot-platform/obot `/docs`, v0.23.x): `functionality/mcp-servers.md`, `functionality/mcp-access-policies.md`, `functionality/mcp-registry-api.md`, `concepts/mcp-registry.md`, `configuration/user-roles.md`, `enterprise/overview.md`, `configuration/mcp-server-gitops.md`.
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices); [MCP Registry spec](https://github.com/modelcontextprotocol/registry).
