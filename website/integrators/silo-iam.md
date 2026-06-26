# Silo IAM: inheritance, sharing, and dataset scopes

How OpenCrane's IAM layer connects the user identity to the runtime agent —
covering grant inheritance, inter-user sharing, Cognee dataset derivation, and the
designed retrieval scope precedence.

> See also: [Authentication](/security/identity) (OIDC flow, session model, credential types),
> [Retrieval & memory (Cognee)](/integrators/retrieval-memory) (write-through ingest and the dataset model),
> [Control who can access what](/guide/permissions) (admin guide to grants and policies),
> [MCP gateway (Obot)](/integrators/mcp-gateway) (how entitlements reach the agent tool surface),
> [ClusterTenant members](/operators/cluster-tenant-members) (who may administer the org — the OrgMembership registry the org-manager gate reads).

---

## The principal set

An openclaw UserTenant is a 1:1 personal agent for one ClusterTenant user. Before
S4, a Tenant's effective entitlements were compiled over only the Tenant's own name —
the human user's group memberships played no part. After S4 that changes: the runtime
contract is compiled over the **principal set** `{tenant-name, subject}`.

```
┌─────────────────────────────────────────────────────────┐
│  Contract compile  (S4a)                                │
│                                                         │
│  principalIds = [ tenantName, tenant.subject ]          │
│                      │              │                   │
│                      ▼              ▼                   │
│          direct grants on       grants on the           │
│          the Tenant row         user's IdP subject      │
│                      │              │                   │
│                      └──────┬───────┘                   │
│                             ▼                           │
│             group grants where ANY principal            │
│             is a group member                           │
│                             │                           │
│                             ▼                           │
│         precedence pass: highest priority wins          │
│         Deny beats Allow at equal priority              │
│         newest createdAt breaks a full tie              │
└─────────────────────────────────────────────────────────┘
```

`tenant.subject` is the OIDC `sub` stored on the `Tenant` row at creation time (bound
via `Tenant.subject` — migration 0025). Tenants created before S4a that have no bound
subject compile over the tenant name only (the legacy path, unchanged).

The key consequence: **a user-level Deny always overrides a tenant-level Allow**, no
matter which principal carried either grant. Deny-over-Allow precedence is unchanged
and deterministic — it operates across the full merged candidate list.

Source:
[`grant-compiler.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/core/grants/grant-compiler.ts)
— `compileForPrincipals(principalIds, payloadType, prisma)`.

[`tenant-contract.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/routes/internal/tenant-contract.ts)
— the contract poll route that assembles the principal set and calls `compileForPrincipals`.

::: info Precedence rules
Three-level tie-break, evaluated in order:

1. Higher `priority` value wins.
2. At equal priority, `Deny` beats `Allow`.
3. At equal priority and same access, the newer `createdAt` wins.

This is global across all principals in the set — there is no "tenant grant beats
user grant" or vice versa. A single Deny anywhere in the set (at the winning priority)
suppresses the entitlement.
:::

---

## Inter-user sharing (S4d)

A user who holds an entitlement to a tool (MCP server) or skill bundle can share that
entitlement with another user or group. This is an explicit, identity-bound action:
the share is written as an `Allow` grant on the recipient, and the recipient's Tenant
picks it up on its next contract poll.

### How it works

```
┌────────────────────────────────────────────────┐
│  POST /api/v1/shares  (S4d)                    │
│                                                │
│  1. Resolve caller from OIDC session           │
│  2. Validate payloadType + recipientType       │
│  3. Confirm the payload exists (MCP/skill)     │
│  4. Confirm the group exists (group recipient) │
│  5. LEAST-PRIVILEGE GATE:                      │
│     compile(caller, payloadType) → Allow?      │
│     No → 403 (no escalation)                  │
│  6. Write Allow Grant (sharedBy = caller)      │
│     recipient picks up on next contract poll   │
└────────────────────────────────────────────────┘
```

The sharer is stamped on every row (`Grant.sharedBy`). List and revoke only retrieve
grants where `sharedBy` equals the caller — a sharer holds no power over grants
created by others or by the platform admin path.

### CLI

```bash
# Share an MCP server you hold with a specific user
oc share grant --type mcp-server --id <server-id> --with-user <oidc-subject>

# Share a skill bundle with a group, scoped to a department
oc share grant --type skill-bundle --id <bundle-id> --with-group <group-id> --scope department

# List the shares you have created
oc share list

# Revoke a share you created
oc share revoke <share-id>
```

### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/shares` | Create a share (least-privilege gated) |
| `GET` | `/api/v1/shares` | List your shares |
| `DELETE` | `/api/v1/shares/{id}` | Revoke a share you created |

Request body for `POST`:

```json
{
  "payloadType": "mcp-server",
  "payloadId": "<server-id>",
  "recipientType": "user",
  "recipientId": "<oidc-subject>",
  "scope": "personal",
  "note": "optional annotation"
}
```

`payloadType` must be `mcp-server` or `skill-bundle`. `recipientType` must be `user`
or `group`. `scope` must be one of `org`, `department`, `project`, or `personal`
(defaults to `personal`).

::: warning Least-privilege is enforced server-side
The gate compiles the caller's own grants at request time and requires an `Allow` on
the exact payload. A `Deny` or absent grant returns `403`. You cannot share an
entitlement you do not currently hold, and sharing never escalates privilege.
:::

Source:
[`routes/shares.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/routes/shares.ts)
— the full share router with the least-privilege gate at step 5.

---

## Dataset-scope derivation (S4c)

Cognee dataset memberships — which knowledge scopes a tenant's agent can retrieve
from — are derived automatically from IAM group expansion rather than being set
manually.

### The unified model

Every dataset tier IS a scope-typed `Group`. The five tiers map directly to the five
`GrantScope` values:

| Tier | `Group.scope` | Dataset key | Notes |
|------|--------------|-------------|-------|
| Org | `Org` | `"default"` | Singleton; every tenant is a member |
| Department | `Department` | `department` | S4c.1 — aligned with grant scope vocabulary |
| Team | `Team` | `team` | |
| Project | `Project` | `project` | |
| Personal | `Personal` | `personal` | Populated by resource share-groups |

```
┌──────────────────────────────────────────────────────────┐
│  _DeriveTenantDatasetMembership (S4c)                    │
│                                                          │
│  principals = { tenantName, subject }                    │
│                                                          │
│  for each Group in the group mirror:                     │
│    if any(principal ∈ group.members):                    │
│      add group.members → membership[group.scope tier]    │
│                                                          │
│  org tier → always ["default"]  (org singleton)         │
│  each tier → dedupe + sort (stable diff)                 │
│                                                          │
│  → { org, department, team, project, personal }          │
└──────────────────────────────────────────────────────────┘
```

The derivation reads only the local `Group` table — it never calls Cognee or any
external service. The result is compared (diffed) against the persisted projection. If
they differ, the control plane replaces the projection and pushes the new membership
to Cognee. If they are identical, no write occurs. This **diff-gate** prevents
redundant Cognee traffic on every contract poll.

Source:
[`core/grants/derive-dataset-membership.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/core/grants/derive-dataset-membership.ts).

### Resource share-groups (direct file and chat sharing)

Sharing a file or chat directly creates a **Personal-scoped resource group** — a
`Group` with `scope=Personal` and a deterministic name `resource:<type>:<id>`. The
group's members are the sharer and the recipient. Because Personal-scoped groups
populate the `personal` dataset tier via the derivation above, the recipient's agent
gains Cognee access to the shared item through the normal group-expansion path.

```bash
# Share a file with a colleague (POST /api/v1/resource-shares)
oc share resource --type file --id <file-id> --with <oidc-subject>

# Share a chat transcript
oc share resource --type chat --id <chat-id> --with <oidc-subject>

# List resource shares you are a member of
oc share resource list

# Revoke a recipient from a resource share
oc share resource revoke <group-id> --subject <oidc-subject>
```

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/resource-shares` | Create or add to a resource share-group |
| `GET` | `/api/v1/resource-shares` | List resource share-groups you are in |
| `DELETE` | `/api/v1/resource-shares/{groupId}/recipients/{subject}` | Remove a recipient |

The least-privilege rule applies here too: only a current member of the resource
group may add further recipients. A user who does not hold the resource cannot share it.

Source:
[`routes/resource-shares.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/routes/resource-shares.ts).

### Cognee sync mechanics

The contract poll loop (pod-side `entrypoint.sh`, calling `GET
/api/v1/internal/tenants/:name/contract`) triggers the derivation and Cognee sync:

1. Derive the membership from the group mirror.
2. Load the persisted projection from `TenantDatasetMembership`.
3. If they differ, replace the projection rows (in a single transaction) and push
   the new membership to Cognee via `PUT /v1/permissions/tenants/:name/awareness-grants`.
4. If they are identical, skip both writes.

The Cognee push is best-effort and timeout-bounded (default 5 s,
`COGNEE_PERMISSIONS_TIMEOUT_MS`). A Cognee failure is logged and captured — it does
not block the contract response or the DB write. The DB projection is the source of
truth; Cognee converges on the next successful push.

::: tip Isolation stays on the ACL, not the datasets param
The Cognee permissions ACL (`/v1/permissions/…`) is the isolation boundary — not the
`datasets=` query parameter. Passing arbitrary dataset names in the retrieval request
does not bypass the ACL. The dataset/node-set layer is a relevance partition, not a
security gate.
:::

---

## Retrieval scope precedence (designed — not yet implemented)

::: warning This section describes a designed but not yet built behaviour
The `DATASET_SCOPE_RETRIEVAL_PRECEDENCE` constant and the derivation of memberships
that feed it (S4c) are shipped. The retrieval cascade that acts on them is not yet
built (tracked as S4e). The section below describes the intended design.
:::

Once S4e is built, retrieval will use the following scope precedence, from most
relevant to least relevant:

```
Personal  →  Project  →  Team  →  Department  →  Org
(highest relevance)                          (lowest relevance)
```

Cognee has no native per-scope weighting and no exposed similarity score for the
graph-completion search family. Scope precedence is therefore **control-plane
orchestration over Cognee**, not a Cognee setting.

### Pattern A — cascade (start here)

Query the most-specific scope first. If fewer than `top_k` results are returned,
widen to the next scope to fill the remainder. Continue widening until either `top_k`
is satisfied or all scopes are exhausted.

```
query → Personal datasets    → ≥ top_k? → return
              ↓ not enough
        Project datasets     → ≥ top_k? → return
              ↓ not enough
        Team datasets        → ≥ top_k? → return
              ↓ not enough
        Department datasets  → ≥ top_k? → return
              ↓ not enough
        Org dataset ("default")          → return
```

Broad-scope results strictly trail narrower-scope results. No similarity score is
required. The precedence is encoded by construction.

### Pattern B — parallel + weighted re-rank (planned upgrade)

Fetch candidates from all scopes in parallel using `only_context=true` (CHUNKS mode).
Tag each result by its source scope, then re-rank by `similarity × scope_weight` and
synthesise. This interleaves broad context by relevance rather than trailing it, at
the cost of requiring a score surface.

Scope weights (indicative):

| Scope | Weight |
|-------|--------|
| Personal | 1.0 |
| Project | 0.8 |
| Team | 0.6 |
| Department | 0.4 |
| Org | 0.2 |

### Ingestion tagging

The harvesting-agent `_PushDocumentToCognee` will also pass
`node_set=[scope, "<scope>:<subject>"]` so scope is a first-class, filterable graph
tag. This makes scope a retrieval dimension in its own right, independent of dataset
placement.

### Isolation reminder

The isolation guarantee rests on the Cognee permissions ACL (the grants synced via
`/v1/permissions/…`), not the `datasets=` parameter. Dataset and node-set are
relevance/partition dimensions; the ACL is the security gate.
