# Spec: MCP Catalogue, Credentials & Per-User Activation

> **Status:** Draft spec for review · **Date:** 20 June 2026 · **Owner:** Jente Rosseel
> **Decision context:** Keep Obot as the catalogue + gateway + credential broker (MIT; fixed — see P0).
> OpenCrane does NOT rebuild catalogue/approval — it **drives Obot's native mechanism** and adds the thin
> glue: identity mapping + Claw activation. See [[reference_runtime_plane_config]].

## 1. Goal

An organisation curates which MCP tools its people may use; individuals install approved tools and connect
their own credentials **without the secret ever passing through the agent/LLM**; each person's OpenClaw
("Claw") becomes aware of the tool automatically.

- **Org admin** reviews the MCP catalogue and **approves/publishes** which MCP servers the org may use.
- **User** browses the *published* catalogue, **installs** a tool into their Claw, and **connects** a credential.
- **Platform** activates the tool in that user's Claw and brokers the credential server-side, so the
  secret never touches the pod or the LLM.

## 2. Design principle — use Obot's native model, don't rebuild it

Obot already provides catalogue + admin-publish + per-user access + per-user credentials natively. We were
about to invent an `McpServerApproval` model in the control plane — **don't.** Instead, OpenCrane drives
Obot's native features and owns only what Obot can't: mapping our OIDC identities to Obot, and getting the
tool into the OpenClaw runtime.

**What Obot provides natively** (from Obot docs/marketing; ⚠️ exact entity/API names to confirm against a
live Obot v0.23.x during P0):
- **Catalogue:** admins add MCP servers to a catalogue (via UI **or a Git repo**) and control which are
  available + how configured, then **publish** the catalogue to employees.
- **Registries (access control):** map catalogue servers to specific **users/groups** — "only authorized
  users can discover and connect to approved services." This *is* the approve/entitle mechanism.
- **Per-user credentials:** when a user enables a server, Obot collects the required config params (API
  keys / auth tokens) and passes them as env to the server process — Obot holds the secret; the tenant
  pod never sees it.
- **Per-user connection URL:** when a user selects an MCP, Obot generates a unique connection URL for AI
  clients. **This URL is the activation primitive** OpenCrane writes into the Claw (§6).

**What OpenCrane builds (the thin glue):**
1. Surface Obot's catalogue/approve/install/connect in the **WeOwnAI frontend** (we do NOT expose Obot's
   own admin UI to tenants).
2. **Identity mapping:** OpenCrane OIDC org-admin → Obot admin; OpenCrane user/tenant → Obot user/group.
3. **Claw activation:** operator writes Obot's per-user connection URL into `openclaw.json` `mcp.servers`.

## 3. Roles & governance (the core requirement)

**Only organisation admins may review the catalogue and approve/publish MCP servers. Non-admin users may
only install servers an admin has published.** Realised via Obot's catalogue + registries; *gated* in
OpenCrane by role.

| Capability | Org admin | User |
|---|---|---|
| View full catalogue (all servers + sources, incl. unpublished) | ✅ | ❌ |
| Approve/publish a server (add to catalogue + publish) | ✅ | ❌ |
| Map a server to users/groups (registry / access policy) | ✅ | ❌ |
| View **published** catalogue | ✅ | ✅ |
| Install (enable) a published server into own Claw | ✅ | ✅ |
| Connect own (Personal) credential | ✅ | ✅ |
| Set an Org-shared credential | ✅ | ❌ |

> ⚠️ **Dependency:** OpenCrane's `auth.middleware.ts` enforces **no per-route roles** today (public/OIDC/
> token fallback chain). An org-admin role model + `requireOrgAdmin` guard is a prerequisite (P0).

## 4. How approval works (replacing the invented model)

There is **no `McpServerApproval` model.** "Approved/published" = the server is **in Obot's published
catalogue and mapped (via an Obot registry) to the user/group.** Admin curation is best done **as code via
Obot's GitOps catalogue** (`OBOT_SERVER_DEFAULT_MCPCATALOG_PATH`, a git repo) — which is *also* the fix for
the broken catalogue-sync (see P0; the two converge). OpenCrane's existing `McpServer` rows become, at most,
a thin read-model/mirror for the frontend — not a parallel approval authority.

## 5. Flows

### 5.1 Admin — review & publish (drives Obot's catalogue)
1. Admin opens the catalogue in WeOwnAI (frontend → control-plane → Obot). Sees all servers + sources, capabilities, provenance, health.
2. Admin approves/publishes → the server is added to Obot's published catalogue (UI action or a commit to the GitOps catalogue) and mapped to the org's users/groups via an Obot registry. **Admin-only** (`requireOrgAdmin`).

### 5.2 User — browse & install (enable in Obot)
1. User sees only **published** servers mapped to them.
2. Install = enable the server in Obot for that user → Obot prepares a per-user connection (and prompts for any required credential, §5.3).
3. Uninstall = disable; reconcile removes it from the Claw (§6).

### 5.3 User — connect a credential (secure, out-of-band — never through the LLM)
The credential-entry channel is **human → (WeOwnAI/control-plane) → Obot**, OIDC-authenticated, structurally
separate from the agent's chat/LLM/MCP channel.
1. User opens the connect form for an installed server (their own OIDC session).
2. **Static token:** user pastes the API key → stored by **Obot** (its credential store); injected by Obot into the server at call time. Value is write-only; audit the event, not the value. Scope = Personal (any user) or Org-shared (admin).
3. **OAuth (PerUserObo):** user clicks "Connect" → browser OAuth → Obot does RFC-8693 OBO exchange. No paste.
4. The token never enters the pod, `openclaw.json`, the LLM context, or the MCP transport — the agent only ever gets the **connection URL**.

### 5.4 Activation — make the Claw aware (§6).

### 5.5 Credential-required handoff (agent asks, never receives the secret)
1. Agent calls an installed-but-unconnected server → broker returns structured `credential_required`.
2. Agent surfaces a **non-secret** "Connect <server>" deep link to the connect form (§5.3) — it does NOT ask for the token in chat.
3. User completes §5.3 out-of-band → broker resolves the credential → agent retries.
4. **Never use MCP `elicitation` for secrets** (it routes input through the agent/transport). Elicitation is for non-secret input only.

## 6. Activation in the Claw (`openclaw.json` reconcile)

OpenCrane already generates each tenant's `openclaw.json`. Activation = the operator writing each installed,
published server into `mcp.servers`, using **Obot's per-user connection URL** + the projected token:

```json
{ "mcp": { "servers": {
  "<server-name>": {
    "url": "<obot per-user connection URL>",
    "transport": "streamable-http",
    "headers": { "Authorization": "Bearer ${OBOT_MCP_TOKEN}" },
    "toolFilter": { "include": ["<allowed tools>"] },
    "enabled": true
  }
}}}
```

- **Entitlement**: only the user's published+installed servers are written (defence-in-depth on top of Obot's registry mapping).
- **Token**: projected SA token (`aud=obot-gateway`) surfaced as `${OBOT_MCP_TOKEN}` (OpenClaw interpolates env, not files; rotates ~600s → refresh on rotation).
- **Reload**: OpenClaw hot-applies `mcp.*` via **file-watch on `openclaw.json`**, **NOT SIGHUP**. The current entrypoint SIGHUP path is likely ineffective — reconcile must rewrite the file in place or call `openclaw mcp reload` (**P0 fix**).
- **Broker hop**: Obot validates the token, resolves the per-(tenant,user) credential, forwards upstream. Secret never returns to the pod (no token passthrough).

## 7. Security requirements (MCP best practices + our model)

- **No secret through the LLM/chat/MCP transport** — credential entry is the human→Obot channel only (§5.3); agent gets the connection URL.
- **No token passthrough** — Obot injects the per-server/per-user credential; never forwards the pod token upstream.
- **Identity from the verified projected token / OIDC session**, never request input.
- **Entitlement** mapped in Obot registries AND narrowed at the Claw by OpenCrane (defence-in-depth).
- **Custody** — Obot holds credentials encrypted at rest (P0: complete the `EncryptionConfiguration` init container so this actually works).
- **Admin-only approval** via `requireOrgAdmin` (P0).
- **Audit** every approve/publish/install/credential/brokered call; never the secret value.
- **Existence-hiding** — non-published/non-entitled servers return 404.

## 8. API / CLI surface (API/CLI-first; frontend is just another client)

The "Obot frontend features" are surfaced as **OpenCrane API clients** that drive Obot (we do NOT expose
Obot's admin UI to tenants). ⚠️ Whether OpenCrane drives Obot via **Obot's REST API** or via the **GitOps
catalogue + identity mapping** is the key implementation choice — **confirm Obot's external API surface
during P0.**

| Action | OpenCrane API | `oc` CLI |
|---|---|---|
| List catalogue (all / published) | `GET /api/v1/mcp/catalog[?view=all]` | `oc mcp catalog [--all]` |
| Approve/publish (admin) | `POST /api/v1/mcp/servers/:id/publish` | `oc mcp publish <id>` |
| Map to users/groups (admin) | `POST /api/v1/mcp/servers/:id/access` | `oc mcp grant <id> --to <subj>` |
| Install / uninstall | `POST /DELETE /api/v1/mcp/installs[/:id]` | `oc mcp install <id>` / `uninstall` |
| Connect / remove credential | `POST /DELETE /api/v1/mcp/servers/:id/credentials` | `oc mcp credentials add <id>` / `rm` |
| OAuth connect (Phase 4) | `GET /api/v1/mcp/servers/:id/connect` → redirect | (browser only) |

Frontend views: **Catalogue** (browse + admin publish), **My Tools** (install + connection status), **Connect** (set token / OAuth).

## 9. Dependencies & phasing

- **P0 — Keep-Obot-and-fix (SEPARATE SESSION / handoff):** (a) wire Obot's **GitOps catalogue**
  (`OBOT_SERVER_DEFAULT_MCPCATALOG_PATH`) correctly, replacing the mis-wired `OBOT_SERVER_PROVIDER_REGISTRIES`
  across the deployment + `drift-repairer.ts` + its test + the `/api/internal/obot-registry` endpoint —
  this is *also* the catalogue mechanism for this spec; (b) the `openclaw.json` **file-watch reload** fix
  (SIGHUP is ineffective); (c) the encryption-at-rest **init container**; (d) a **role model +
  `requireOrgAdmin`** guard; (e) **confirm Obot's REST API / registry / connection-URL surface** against a
  live Obot v0.23.1. *This spec depends on P0.*
- **P1 — Catalogue + access (admin):** surface Obot's catalogue + publish + registry mapping in the frontend; admin guard.
- **P2 — Install + identity mapping:** user install/enable → OpenCrane↔Obot identity map.
- **P3 — Credential connect (StaticFallback) + the `credential_required` handoff.**
- **P4 — Claw activation** (`openclaw.json` reconcile with Obot connection URL) + **PerUserObo/OAuth** connect.

## 10. Open questions / risks

- **Obot external API surface** — can our frontend drive Obot's catalogue/registry/credentials via a stable REST API, or must we use GitOps catalogue + identity mapping? (Confirm in P0; the docs site wasn't machine-readable here.)
- **Entitlement authority** — Obot registries vs OpenCrane grant compiler. This spec leans **Obot-native mechanism, OpenCrane-driven intent**, with Claw-level narrowing as defence-in-depth. Reconcile with IAM-first before P1.
- **Role enforcement gap** — no per-route RBAC today (P0).
- **OpenClaw reload** is file-watch not SIGHUP — verify on the pinned version.
- **Token rotation** — projected SA token rotates; reconcile must refresh.
- **Obot long-term licence** — MIT today, VC-backed open-core ($35M seed); pin/mirror/CI-license-gate, keep the seam thin so Obot stays swappable.

## Sources
- Obot docs: [MCP Server Catalogs](https://docs.obot.ai/concepts/admin/mcp-server-catalogs/), [MCP Registries](https://docs.obot.ai/functionality/mcp-registries/), [MCP Server GitOps](https://docs.obot.ai/configuration/mcp-server-gitops/)
- [Obot — Central MCP Repository](https://obot.ai/central-mcp-repository/), [MCP Management Platform](https://obot.ai/mcp-management-platform/)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
