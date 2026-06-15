# Lib: contracts (`@opencrane/contracts`)

> Deep-dive for `libs/contracts`. Index: [`../app-specific.md`](../app-specific.md). Verified June 2026.

**The keystone.** Single source of truth for cross-package types and the typed control-plane client.
Consumed by the CLI, control-plane, operator, and awareness SDK. Import from the barrel only.

## What's in `src/`

- **`index.ts`** — the one barrel; re-exports everything below + the client.
- **`client.ts`** — `___CreateControlPlaneClient(baseUrl, token?)` builds an `openapi-fetch` client typed by `paths`; injects `Authorization: Bearer` when a token is given. Exports `ControlPlaneClient` and `paths`.
- **`generated/api.ts`** — **auto-generated**, do not hand-edit. The `paths` type map.
- Domain type files (CRD-mirroring enums + DTOs): `cluster-tenant.types.ts`, `grant.types.ts`, `group.types.ts`, `mcp-server.types.ts`, `skill-bundle.types.ts`, `third-party-source.types.ts`.

## The type-generation pipeline

The control-plane emits `apps/control-plane/openapi.json`; the contracts `generate` script runs
`openapi-typescript apps/control-plane/openapi.json -o src/generated/api.ts`, and `build` is
`pnpm generate && tsc`. So **the OpenAPI spec drives the client types** — after changing a
control-plane route's request/response shape, regenerate here rather than hand-typing. Runtime client
is `openapi-fetch` (tiny, typed `GET`/`POST`/… over `paths`).

## CRD-mirroring enums (the canonical values)

- `ClusterTenantIsolationTier`: `shared` · `dedicatedNodes` · `dedicatedCluster`
- `ClusterTenantComputeMode`: `shared` · `dedicated`
- `ClusterTenantPhase`: `pending` · `provisioning` · `ready` · `failed`
- `GrantAccess`: `allow`·`deny` · `GrantScope`: `org`·`department`·`project`·`personal` · `GrantSubjectType`: `group`·`tenant`·`user`
- `McpServerTransport`: `streamable-http`·`sse`·`websocket` · `McpServerStatus`: `active`·`degraded`·`draft` · `McpCredentialBrokeringMode`: `static`·`obo`
- `SkillBundleStatus`: `published`·`review`·`draft` · `SkillPromotionStatus`: `proposed`·`approved`·`rejected`
- `ThirdPartySourceKind`: `mcp-registry`·`anthropic-skills`·`git-repository`·`manual-upload`

These are shared by backend, CLI, and (where relevant) the frontend — never redefine them per app.
`ClusterTenantProvisionerRegistry`/`...Capability` are the webhook-provisioner seam used for the
`dedicatedCluster` tier.
