# Obot MCP Gateway

How OpenCrane runs and governs **MCP (Model Context Protocol) servers** for tenant
agents. Obot is the in-cluster **runtime gateway**; the control plane is the
**source of truth** for the catalog and per-tenant entitlements.

> See also: [skills-registry.md](/integrators/skill-registry) (the sibling delivery plane),
> [agent-workspace.md](/integrators/agent-workspace) (how the agent learns and is governed),
> [auth.md](/security/identity) (token audiences), and [hosting-architecture.md](/operators/hosting).

## What Obot is

Obot is the upstream [`obot-platform/obot`](https://github.com/obot-platform/obot)
MCP gateway, deployed as a managed in-cluster plane. Tenant agents (OpenClaw) reach
their MCP tools *through* Obot rather than connecting to each MCP server directly;
Obot holds the live server connections and routes calls.

Crucially, Obot does **not** own the list of servers. It is **config-slaved** to the
control plane: it polls the control-plane registry and serves whatever the control
plane has published. The direction of truth is always **control plane → Obot**.

```
oc CLI / API ──▶ Control plane (McpServer rows + grants)
                      │  GET /api/internal/obot-registry   ◀── Obot polls (OBOT_SERVER_PROVIDER_REGISTRIES)
                      ▼
                 Obot MCP Gateway ──routes──▶ MCP servers
                      ▲
   tenant pod (OpenClaw) ──aud=obot-gateway projected token──┘   (in-cluster only)
```

## Deployment & network posture

- **Workload:** `apps/clustertenant-platform/templates/obot-mcp-gateway-deployment.yaml` +
  `mcp-gateway-service.yaml`; configured by the `mcpGateway` block in
  `apps/clustertenant-platform/values.yaml` (image `ghcr.io/obot-platform/obot`, 1 replica, port
  8080). Requires a per-instance, release-prefixed `<release>-obot` Secret (resolved by
  the `opencrane.obotSecretName` Helm helper) with key `dsn` for Obot's own Postgres.
- **Auth disabled, network-gated.** `OBOT_SERVER_ENABLE_AUTHENTICATION=false` — Obot
  itself runs no auth. Access is enforced at the network layer: the
  `mcp-gateway-ingress` policy in `apps/clustertenant-platform/templates/networkpolicy-planes.yaml`
  admits port 8080 **only** from tenant, control-plane, and operator pods. There is
  no external ingress; the browser never reaches Obot.
- **Kubernetes runtime backend.** `OBOT_SERVER_MCPRUNTIME_BACKEND=kubernetes` — Obot
  spawns MCP servers as in-cluster pods.

## Catalog sync (control plane → Obot)

- The control plane owns the `McpServer` table (Prisma model in
  `apps/clustertenant-operator/prisma/schema.prisma`): `id`, `name` (unique), `description`,
  `endpoint`, `transport`, `scope`, `status`, `capabilities`, plus optional
  `sourceId` linking to a `ThirdPartySource` (MCP registry / git / manual upload).
- It exposes the Obot-wire catalog at **`GET /api/internal/obot-registry`**
  ([obot-registry.ts](https://github.com/italanta/opencrane/blob/main/apps/clustertenant-operator/src/routes/internal/obot-registry.ts)),
  serving only `status = Active` servers, ordered by name. The endpoint is **not**
  behind `___AuthMiddleware`; NetworkPolicy is its access control.
- Obot is pointed at it via `OBOT_SERVER_PROVIDER_REGISTRIES` and polls to sync.
- **Management surface:** CRUD lives at `/api/v1/mcp-servers`
  ([mcp-servers.ts](https://github.com/italanta/opencrane/blob/main/apps/clustertenant-operator/src/routes/mcp-servers.ts)) and via
  `oc mcp …`. Third-party sources are ingested through the
  fetch → scan → validate → register → entitle pipeline.

## How a tenant pod reaches Obot

The operator injects a **projected ServiceAccount token with audience
`obot-gateway`** into every tenant pod at
`/var/run/opencrane/tokens/obot-gateway.token`, alongside `OPENCRANE_MCP_GATEWAY_URL`
([3-deployment.ts](https://github.com/italanta/opencrane/blob/main/apps/fleet-operator/src/tenants/deploy/3-deployment.ts)). The pod
(OpenClaw) calls Obot server-side with that token. This token is **workload
identity** — it is never handed to a browser. (The browser's path to the pod is the
separate pairing-link broker; see [auth.md](/security/identity).)

## MCP policy: three enforcement points, one decision

A grant decision in the control plane fans out to three consumers, all derived from
the same grant-compiler output — so they cannot disagree by construction:

1. **Obot catalog** — synced from the registry; determines which servers the gateway
   will route at all.
2. **Runtime contract policy** — `policy.mcpServers.allow/deny` in the effective
   contract, re-pulled by the pod
   ([tenant-contract.ts](https://github.com/italanta/opencrane/blob/main/apps/clustertenant-operator/src/routes/internal/tenant-contract.ts)).
3. **In-pod enforcement** — `entrypoint.sh` `_load_mcp_policy` / `_mcp_server_is_enabled`
   evaluate, in precedence order: tenant-CRD `mcpPolicy.deny` (always wins) → tenant-CRD
   `mcpPolicy.allow` → AccessPolicy deny → AccessPolicy allow.

The agent's **awareness** of its tools (`TOOLS.md`, see
[skills-registry.md](/integrators/skill-registry) and the contract's `workspace` block) is
derived from the same allow-set — so what the agent *thinks* it can use stays aligned
with what IAM *lets* it use. Awareness is descriptive; Obot + the runtime policy are
the enforcement boundary.

## Keeping Obot from drifting

The operator's runtime-plane drift repairer
([drift-repairer.ts](https://github.com/italanta/opencrane/blob/main/apps/fleet-operator/src/runtime-planes/drift-repairer.ts)) runs on a
~60s interval and re-patches Obot's critical env (`OBOT_SERVER_PROVIDER_REGISTRIES`,
`OBOT_SERVER_ENABLE_AUTHENTICATION`, `OBOT_SERVER_MCPRUNTIME_BACKEND`) in place if it
drifts from control-plane intent — without a pod restart, preserving `valueFrom`
references. Image/replica/resource changes are **not** reconciled here; use Helm.

## Current state & gaps

- ✅ Obot deployed as a config-slaved plane; catalog sync + drift repair live.
- ✅ Control-plane `McpServer` CRUD + grants; per-tenant allow/deny compiled into the
  contract and enforced in-pod.
- 🔶 Credential brokering for downstream MCP auth (per-user creds, encryption at rest)
  is **not** in this phase — `OBOT_SERVER_ENCRYPTION_PROVIDER=none`. The earlier
  "RFC 8693 credential shim" remains a target, not current behaviour.
