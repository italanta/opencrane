# API overview

The OpenCrane control plane exposes a versioned HTTP API at `/api/v1`.

::: tip Looking for the endpoint list?
This page covers authentication, error envelopes, and pagination conventions. For
the full, browsable endpoint and schema reference, see the
[interactive API reference](/reference/api).
:::

A machine-readable OpenAPI 3.1 description is emitted from the build and served at runtime:

```
GET /api/v1/openapi.json
```

Use the OpenAPI document as the authoritative contract. This reference provides a human-readable overview and authentication guide.

---

## Authentication

All endpoints (except the auth and OpenAPI routes listed below) require a bearer token.

**Header format:**
```
Authorization: Bearer <token>
```

**Current paths:**
- **Bearer token** — set `OPENCRANE_TOKEN` or pass `--token` to the CLI. This is the automation and break-glass path.
- **OIDC** — human operators authenticate via `GET /api/v1/auth/login` → callback → session cookie. See the [Auth](#auth) section below.

Projected ServiceAccount tokens will replace static bearer tokens once Kubernetes workload identity support lands.

---

## Base URL

All API routes are prefixed with `/api/v1`. Infrastructure routes (`/healthz`, `/prom`) are unprefixed.

---

## Endpoints

### Tenants

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tenants` | List all tenants |
| `POST` | `/tenants` | Create a tenant |
| `GET` | `/tenants/{name}` | Get a tenant by name |
| `PUT` | `/tenants/{name}` | Update a tenant |
| `DELETE` | `/tenants/{name}` | Delete a tenant |
| `POST` | `/tenants/{name}/suspend` | Suspend a tenant pod |
| `POST` | `/tenants/{name}/resume` | Resume a suspended tenant |
| `GET` | `/tenants/{name}/datasets` | Get tenant dataset memberships |
| `PUT` | `/tenants/{name}/datasets` | Update tenant dataset memberships |
| `GET` | `/tenants/{name}/effective-contract` | Get the compiled runtime contract for a tenant |
| `GET` | `/tenants/drift` | Report projection drift between CRDs and PostgreSQL |
| `POST` | `/tenants/repair` | Repair drifted tenant projections (dry-run by default; append `?dryRun=false` to apply) |

### Access Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/policies` | List all access policies |
| `POST` | `/policies` | Create a policy |
| `GET` | `/policies/{name}` | Get a policy by name |
| `PUT` | `/policies/{name}` | Update a policy |
| `DELETE` | `/policies/{name}` | Delete a policy |
| `GET` | `/policies/drift` | Report drift for policy projections |
| `POST` | `/policies/repair` | Repair drifted policy projections |

### MCP Servers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/mcp-servers` | List MCP server registrations |
| `POST` | `/mcp-servers` | Register an MCP server |
| `GET` | `/mcp-servers/{id}` | Get an MCP server |
| `PUT` | `/mcp-servers/{id}` | Update an MCP server |
| `DELETE` | `/mcp-servers/{id}` | Delete an MCP server |

### Groups

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/groups` | List groups |
| `POST` | `/groups` | Create a group |
| `GET` | `/groups/{id}` | Get a group |
| `PUT` | `/groups/{id}` | Update a group |
| `DELETE` | `/groups/{id}` | Delete a group |

### Skills Catalogue

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/skills/catalog` | List skill bundles |
| `POST` | `/skills/catalog` | Publish a skill bundle |
| `GET` | `/skills/catalog/{id}` | Get a skill bundle |
| `PUT` | `/skills/catalog/{id}` | Update a skill bundle |
| `DELETE` | `/skills/catalog/{id}` | Remove a skill bundle |

### Third-Party Sources

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/third-party-sources` | List registered third-party sources |
| `POST` | `/third-party-sources` | Register a third-party source |
| `GET` | `/third-party-sources/{id}` | Get a source |
| `PUT` | `/third-party-sources/{id}` | Update a source |
| `DELETE` | `/third-party-sources/{id}` | Remove a source |

### Access Tokens

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/access-tokens` | List access tokens |
| `POST` | `/access-tokens` | Create an access token |
| `DELETE` | `/access-tokens/{id}` | Revoke an access token |

### Provider Keys

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/providers/keys` | List configured provider API keys |
| `PUT` | `/providers/keys` | Set a provider API key |
| `DELETE` | `/providers/keys/{provider}` | Remove a provider key |

### AI Budget

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ai-budget/global` | Get global budget settings |
| `PUT` | `/ai-budget/global` | Update global budget settings |
| `GET` | `/ai-budget/accounts` | List per-user account budgets |
| `PUT` | `/ai-budget/accounts/{userId}` | Set a user account budget |
| `DELETE` | `/ai-budget/accounts/{userId}` | Remove a user account budget |
| `GET` | `/ai-budget/{tenantName}/spend` | Get current spend for a tenant |
| `GET` | `/ai-budget/{tenantName}/litellm-key` | Get a tenant's LiteLLM virtual key |
| `POST` | `/ai-budget/{tenantName}/litellm-key/revoke` | Revoke a tenant's LiteLLM virtual key |

### Audit

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/audit` | Query audit log entries with optional tenant filter and cursor pagination |

**Query parameters:** `tenant`, `limit` (default 100), `cursor`.

Responses include `{ data, pagination: { limit, hasMore, nextCursor? } }`.

### Token Usage

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/token-usage` | Query token usage records |

### Metrics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/metrics/server` | Server health and aggregate platform metrics |
| `GET` | `/metrics/projection-drift` | Tenant and AccessPolicy CRD-to-PostgreSQL drift counts, lag, and alert state |

Prometheus-format metrics are also available at `/prom` (unprefixed).

### Auth

These endpoints do not require a bearer token.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login` | Initiate OIDC login; redirects to the identity provider |
| `GET` | `/auth/callback` | OIDC callback; establishes a session |
| `POST` | `/auth/logout` | End the current session |
| `GET` | `/auth/me` | Return the current session principal |

---

## Error Envelopes

All `4xx` and `5xx` responses return a consistent envelope:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Common codes: `TENANT_NOT_FOUND`, `POLICY_NOT_FOUND`, `VALIDATION_ERROR`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`, `DATASET_DENIED`, `UNAUTHORIZED`.

---

## Pagination

Endpoints that return collections use cursor-based keyset pagination:

```json
{
  "data": [ ... ],
  "pagination": {
    "limit": 100,
    "hasMore": true,
    "nextCursor": "eyJ..."
  }
}
```

Pass `?cursor=<nextCursor>` to fetch the next page.

---

## Infrastructure Routes

These are served without the `/api/v1` prefix and require no auth:

| Route | Description |
|-------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /prom` | Prometheus metrics |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 spec |
