# Silo read-model projection (Stage 4 follow-up)

Status: **design — needs one decision before implementation.** This is the remaining *live blocker*
after the Stage 4 feature move (commit `7d4b6d0`): the clustertenant-manager (silo) no longer owns the
ClusterTenant registry, but its per-org login still needs ClusterTenant data.

## The gap

After the move, the fleet-manager owns the authoritative `ClusterTenant` / `OrgMembership` / billing
registry (its own DB). The silo kept `ClusterTenant` + `OrgMembership` as *read-model* tables, but **nothing
populates them anymore** — the silo has no operator/watcher, and the fleet writes to its own registry DB, not
the silo's.

What actually depends on each silo read-model:

| Read-model | Silo consumer | Criticality |
|---|---|---|
| `ClusterTenant` (name, vanityDomain, **zitadelClientId**, **zitadelOrgId**) | `per-org-client.ts` → per-org **login** (`OidcAuthService.resolveLoginClient`) | 🔴 **critical** — login at `<org>.<base>` falls through to the masters client without it |
| `OrgMembership` | `/auth/me` introspection enrichment only (the `_RequireOrgAdmin` *gate* reads the OIDC group-derived `session.authUser.isOrgAdmin`, **not** this table) | 🟡 degraded display only |
| default `Tenant` | the owner's `<org>-default` workspace row | 🟡 workspace appears once projected |

Key fact: the `ClusterTenant` **CR** (cluster-scoped) currently carries `spec.{displayName, vanityDomain,
isolationTier, compute, owner}` — but **not** the Zitadel `clientId`/`orgId`, which the fleet sets in its
registry DB *after* `provisionOrg`. So the silo cannot get the login-critical ids from today's CR.

## The decision — how does the silo get ClusterTenant login data?

**Option A (recommended) — CR carries it; silo reads the CR, no silo DB read-model.**
- Fleet writes the Zitadel `clientId`/`orgId`/`redirectUri` onto the `ClusterTenant` CR **status** after
  `provisionOrg` (the fleet operator already writes CR status: `boundNamespace`, `phase`).
- Silo's `per-org-client.ts` resolves the org from the **CR** (read by name from the host's first label;
  by `vanityDomain` via a label/field match) instead of `prisma.clusterTenant`. The silo has a k8s client
  already; the CR is the single source of truth.
- **Net:** the silo's `ClusterTenant` read-model **table disappears** — one less projection to keep in sync.
  `clientId`/`orgId` are public OIDC identifiers (not secrets), so exposing them on the CR is fine.
- Cost: one k8s read per login (memoisable, like discovery already is). Testable with a mocked `customApi`,
  **no live validation needed**.

**Option B — fleet pushes a projection into each silo DB.** Fleet (on reconcile) writes the silo's
`ClusterTenant`/`OrgMembership` rows via the silo's internal API or a direct DB write. Keeps the silo's
current `prisma.clusterTenant` code unchanged, but adds a cross-service write path + couples fleet to every
silo's DB/endpoint. More moving parts; more failure modes.

**Option C — silo pulls from the fleet internal API at login.** Silo calls a fleet `/internal/cluster-tenants/:host`
endpoint during `resolveLoginClient`. Simple, but puts the fleet on the silo's **login hot path** (a fleet
outage blocks all silo logins) and needs new auth between the planes.

### Recommendation

**Option A.** It removes a read-model rather than adding a sync path, keeps the CR as the single source of
truth (consistent with the existing CRD-projection pattern), puts no other plane on the login hot path, and
is unit-testable without a live cluster. `OrgMembership` in the silo can stay empty for now (only `/auth/me`
display degrades; enforcement is group-based) — or, if richer `/auth/me` is wanted, the fleet can stamp the
owner onto the CR too (the owner is already on `spec.owner`).

### Implementation sketch (Option A)

1. **contracts**: add `clientId`/`orgId`/`redirectUri` to `ClusterTenantStatus` (or a dedicated
   `zitadel` sub-object).
2. **fleet**: after `provisionOrg` + registry update, patch the CR **status** with the Zitadel ids
   (the operator's status-writer is the natural home).
3. **silo `per-org-client.ts`**: resolve from the CR (by name + vanityDomain) instead of
   `prisma.clusterTenant`; memoise per host. Drop the silo `ClusterTenant` read-model table + its
   schema model (Tenant.clusterTenantRef stays a soft string ref).
4. **default `Tenant`**: fleet operator creates the `<org>-default` Tenant **CRD** on CT-ready (owner from
   `spec.owner`); the silo's existing Tenant projection-repair syncs CRD → silo DB.
5. Tests: mock `customApi` for the CR read; assert per-org resolution + masters-client fallthrough.
