# App: skill-registry (`@opencrane/skill-registry`)

> Deep-dive for `apps/skill-registry`. Index: [`../app-specific.md`](../app-specific.md). Verified June 2026.

A minimal in-cluster **delivery proxy** that gates skill-bundle content on tenant identity +
entitlement. It holds **no** entitlement logic of its own — it authenticates the caller and delegates
the authorization decision to the control-plane. Express + `pino-http`, listens on `:5000`.

## Bootstrap (`src/index.ts`, `src/config.ts`)

Loads config (`PORT`, `CONTROL_PLANE_URL`; missing values throw at startup), builds an in-cluster K8s client (`KubeConfig.loadFromCluster()`), mounts the router with the `AuthenticationV1Api`.

## Endpoints (`src/routes.ts`)

- `GET /healthz` → `{ status: "ok" }` (probe).
- `GET /bundles/:digest`:
  1. Require `Authorization: Bearer <token>`.
  2. **TokenReview** (`src/token-review.ts`) with `audiences: ["skill-registry"]`; reject if not authenticated or audience missing. Parse tenant from `system:serviceaccount:<ns>:<name>`.
  3. Proxy to control-plane `GET /api/internal/bundles/{digest}/content?tenantName=…`.
  4. **Existence-hiding:** non-entitled *and* non-existent both surface as `404` — never `403` — so a tenant can't probe which bundles exist. Forwards `content-type` + `X-Skill-Name`/`X-Skill-Digest` on success.

## Security model

The audience check (`aud=skill-registry`) prevents cross-service reuse of a tenant's projected token. RBAC is a cluster-scoped ClusterRole **only** for TokenReview (which cannot be namespaced) — no data-plane access. Logs tenant + digest + rejection reason for audit.

## In-flight

OCI/Zot-backed bundle content is being introduced control-plane-side (resolve OCI-first, DB fallback); the registry stays a pass-through either way.
