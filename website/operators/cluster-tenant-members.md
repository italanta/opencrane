# ClusterTenant member management

Managing who can administer a ClusterTenant (organisation) — the roles, the API + CLI surface, and the guardrail that prevents an org from losing all its owners.

> See also:
> [Silo IAM: inheritance & sharing](/integrators/silo-iam) — how org membership feeds grant compilation and dataset-scope derivation for the agents inside a silo.
> [Networking & isolation](/operators/networking) — the per-silo default-deny baseline that this org model sits on top of.
> [Zitadel key rotation](/security/zitadel-key-rotation) — the IdP-side complement: Zitadel service-account keys versus the local membership registry described here.

---

## What the membership registry is

Each ClusterTenant owns a set of **OrgMembership** rows in the control-plane database. These rows record which OIDC subjects (users) can manage the org and at what role. The org-manager gate — the middleware that guards every ClusterTenant write and the members API itself — reads this registry to decide whether to admit or reject a request.

::: info Local registry, not Zitadel grants
`OrgMembership` rows are **control-plane-local**: they live in the platform's own database and are not Zitadel role grants. Adding a member here does not automatically create a Zitadel grant, and removing one does not touch the IdP. The registry's purpose is to control who may call the management API for a given org; it is not the full RBAC model for what users _inside_ the org can access (that is handled by the grant/policy system described in [Silo IAM](/integrators/silo-iam)).
:::

The three membership roles are:

| Role | What it can do |
|------|----------------|
| `Owner` | Full management of the org — members, config, deletion. At least one `Owner` must always exist. |
| `Admin` | Same management rights as Owner via the API; cannot be used to demote/remove the last Owner. |
| `Member` | Read — currently reserved; the org-manager gate admits `Owner` and `Admin` only. |

---

## The last-owner guardrail

An org must always retain at least one `Owner`. The API enforces this in two places:

- **Removing an `Owner`** via `DELETE /members/:subject` when they are the sole Owner → HTTP 409, code `LAST_OWNER`.
- **Demoting an `Owner`** to `Admin` or `Member` via `POST /members` when they are the sole Owner → HTTP 409, code `LAST_OWNER`.

Both operations are rejected before the database write. The error message is explicit: `"Cannot remove/demote the last Owner of an organisation."` Promoting a second user to `Owner` first unblocks either operation.

::: warning Transferring ownership
Always add the new owner before removing the old one. Attempting to remove or demote the sole owner will be rejected with 409, and the org will remain intact.
:::

---

## API reference

All member endpoints sit under the org path and are gated by the org-manager middleware: a platform operator or an `Owner`/`Admin` of the named org may call them. The caller's identity is taken from the OIDC session — there is no request parameter for it.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/cluster-tenants/:name/members` | List all members (subject + role), ordered by `createdAt` ascending. |
| `POST` | `/api/v1/cluster-tenants/:name/members` | Add a new member or update an existing member's role (upsert on subject). |
| `DELETE` | `/api/v1/cluster-tenants/:name/members/:subject` | Remove a member from the org. |

### Request body for POST

```json
{
  "subject": "<oidc-sub>",
  "role": "Owner | Admin | Member"
}
```

`subject` must be a non-blank OIDC `sub` string — the same value stored on the `Tenant` row when a user's assistant was created. `role` must be exactly `Owner`, `Admin`, or `Member`; anything else returns HTTP 400.

### Response shapes

`GET` returns an array:

```json
[
  { "subject": "auth0|abc123", "role": "Owner" },
  { "subject": "auth0|def456", "role": "Admin" }
]
```

`POST` returns the upserted row:

```json
{ "subject": "auth0|def456", "role": "Admin" }
```

`DELETE` returns a confirmation envelope:

```json
{ "subject": "auth0|def456", "status": "removed" }
```

### Error codes

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `VALIDATION_ERROR` | Missing or invalid `subject` or `role`. |
| 401 | `UNAUTHORIZED` | No authenticated session. |
| 403 | `FORBIDDEN_ORG_SCOPE` | Caller is neither a platform operator nor an Owner/Admin of this org. |
| 404 | `CLUSTER_TENANT_NOT_FOUND` | No ClusterTenant with that name exists. |
| 404 | `MEMBERSHIP_NOT_FOUND` | `DELETE` target subject is not a member of the org. |
| 409 | `LAST_OWNER` | The operation would leave the org with zero Owners. |

Source: [`apps/control-plane/src/routes/cluster-tenant-members.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/routes/cluster-tenant-members.ts)

---

## CLI reference

The `oc cluster-tenant members` sub-group mirrors the API exactly. Output defaults to table mode; pass `--output json` for machine-readable results.

### List members

```bash
oc cluster-tenant members list <org-name>
oc cluster-tenant members list <org-name> --output json
```

Prints the `subject` and `role` columns for every member of the named org.

### Add or update a member

```bash
# Add a new owner
oc cluster-tenant members add <org-name> \
  --subject auth0|abc123 \
  --role Owner

# Promote an existing member to admin
oc cluster-tenant members add <org-name> \
  --subject auth0|def456 \
  --role Admin
```

`add` is an upsert: if the subject already has a row, only the role is changed. The last-owner guardrail applies — demoting the sole Owner returns a 409.

### Remove a member

```bash
oc cluster-tenant members remove <org-name> <subject>
```

Prints a confirmation on success. The sole Owner cannot be removed (409).

Source: [`apps/cli/src/commands/cluster-tenants.ts`](https://github.com/italanta/opencrane/blob/main/apps/cli/src/commands/cluster-tenants.ts)

---

## How the gate uses the registry

The `_RequireOrgManager` middleware is applied to every route mounted under `/api/v1/cluster-tenants/:name/members`, as well as to ClusterTenant write routes (PUT, DELETE on `/:name`). Its decision tree is:

```
┌─────────────────────────────────────────────────────┐
│  _RequireOrgManager                                 │
│                                                     │
│  1. No session?                                     │
│     dev-mode bypass → pass                          │
│     real auth → 401                                 │
│                                                     │
│  2. isPlatformOperator? → pass (manages any org)    │
│                                                     │
│  3. No :name in path (collection route)? → 403      │
│     (a per-org member cannot read the whole fleet)  │
│                                                     │
│  4. OrgMembership lookup for (orgName, subject):    │
│     role = Owner or Admin → pass                    │
│     else → 403                                      │
└─────────────────────────────────────────────────────┘
```

The gate never leaks which specific check failed — every rejection returns the same `FORBIDDEN_ORG_SCOPE` code. A platform operator (identified by the `isPlatformOperator` session flag) bypasses the membership check and can manage every org.

Source: [`apps/control-plane/src/infra/middleware/cluster-tenant-org-admin.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/infra/middleware/cluster-tenant-org-admin.ts)

---

## Operational notes

**Finding a user's OIDC subject.** The `subject` field is the OIDC `sub` claim from the user's identity provider (Zitadel in the default setup). It is stored on the user's `Tenant` row when an assistant is created. You can retrieve it with:

```bash
oc tenants show <tenant-name> --output json | jq '.subject'
```

**Bootstrapping the first owner.** When a ClusterTenant is first created, it has no OrgMembership rows. A platform operator must add the first `Owner` via the API or CLI before an org admin can manage the org through their own session.

**Membership is not IdP group membership.** A user may be a member of a Zitadel group without appearing in `OrgMembership`, and vice versa. The org-manager gate reads only `OrgMembership`. The grant/policy system that governs what the user's _agent_ can access reads the Zitadel group projection — both systems are independent.
