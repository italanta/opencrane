# Fleet and silo operating model

OpenCrane's Stage 4 architecture splits platform management into two distinct managers — the cluster-wide **fleet-manager** and the per-ClusterTenant **clustertenant-manager** — so that fleet-level administration (ClusterTenant lifecycle, billing, Zitadel IAM, platform DNS) is cleanly separated from the tenant-facing runtime that lives inside each silo.

> See also:
> [Silo deployment model](/operators/silo-deployment) — how `deploy-multi-tenant.sh` and `deploy-silo.sh` stamp out the fleet and silo releases.
> [Authentication](/security/identity) — how fleet OIDC and per-silo OIDC differ and how each is configured.
> [Zitadel key rotation](/security/zitadel-key-rotation) — rotating the fleet-manager's Zitadel service-account key.
> [Networking & isolation](/operators/networking) — the NetworkPolicy floor each silo enforces.

---

## Two managers, two surfaces

```
┌──────────────────────────────────────────────────────────────────┐
│  FLEET PLANE  (one per cluster)                                  │
│  namespace: opencrane-system                                     │
│  image: ghcr.io/italanta/opencrane-fleet-manager                 │
│                                                                  │
│  fleet-manager:                                                  │
│    • ClusterTenant lifecycle (create / update / delete)          │
│    • Billing accounts                                            │
│    • OrgMembership management                                    │
│    • Platform DNS (wildcard cert / ClusterIssuer)                │
│    • Zitadel IAM admin (per-org Zitadel Org provisioning)        │
│    • SA-key rotation (sole holder of IAM_OWNER SA key)           │
│    • Registry DB (fleet's own Postgres — ClusterTenant catalogue)│
│                                                                  │
│  OIDC: fleetManager.oidc.* — its OWN Zitadel project            │
│  DB:   fleetManager.database.*                                   │
└──────────────────────────────────────────────────────────────────┘

       ┌── projects public OIDC ids onto ClusterTenant CR ──▶
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  SILO PLANE  (one per ClusterTenant)                             │
│  namespace: opencrane-<cluster-tenant>                           │
│  image: ghcr.io/italanta/opencrane-clustertenant-manager         │
│                                                                  │
│  clustertenant-manager:                                          │
│    • Tenant (UserTenant / OpenClaw pod) lifecycle                │
│    • AccessPolicy, Group, MCP server management                  │
│    • Skills, budgets, model routing, sessions                    │
│    • ClusterTenant + OrgMembership as LOCAL read-models          │
│      (projected from the fleet; no Zitadel management calls)     │
│    • Projection repair loop                                      │
│                                                                  │
│  OIDC: clustertenantManager.oidc.* — per-org login               │
│  DB:   clustertenantManager.database.*  (per-silo Postgres)      │
│                                                                  │
│  runtime planes: Obot / MCP gateway, skill-registry, LiteLLM,   │
│                  Cognee                                          │
│  operator: namespace-scoped to this silo only                    │
└──────────────────────────────────────────────────────────────────┘
```

The two managers use **separate container images**, separate Helm sections, separate databases, and separate OIDC registrations. The fleet-manager is the **sole holder** of the Zitadel management SA key and the only component that makes Zitadel Management API calls. The clustertenant-manager reads the ClusterTenant data as a projected read-model — it makes no Zitadel management calls.

---

## What the fleet-manager owns

| Responsibility | Detail |
|---|---|
| ClusterTenant registry | The `POST/PATCH/DELETE /cluster-tenants` API. Creates the CRD in the cluster, the Postgres row in the fleet registry DB, and — when `fleetManager.zitadel.mgmtApiUrl` is set — provisions the matching Zitadel Organisation |
| Billing accounts | `GET/POST /billing-accounts` — gated by `billing.enabled` |
| OrgMembership | `POST /cluster-tenants/{name}/members` — cross-silo membership reconciliation |
| Platform DNS | `GET/POST /platform/dns` — configures the wildcard cert DNS-01 ClusterIssuer |
| Zitadel IAM admin | `POST /admin/zitadel/sa-key:rotate` — validate-then-swap rotation of the SA key |
| Silo seed | On ClusterTenant ready, seeds the `<org>-default` Tenant CRD so the silo's clustertenant-manager picks it up |

All fleet routes are exposed on the fleet-manager's own service and endpoint — not on the per-silo clustertenant-manager.

---

## What the clustertenant-manager owns

| Responsibility | Detail |
|---|---|
| UserTenant (OpenClaw pod) lifecycle | `GET/POST/PATCH/DELETE /tenants` |
| AccessPolicy, Group, MCP servers | Tenant-scoped IAM configuration |
| Skills, model routing, budgets, sessions | All per-silo runtime configuration |
| ClusterTenant read-model | Local projection of the ClusterTenant CR + OrgMembership CRs — read-only, no fleet write path |
| Projection repair | `POST /tenants/repair`, `POST /policies/repair` |

The clustertenant-manager's OIDC (`clustertenantManager.oidc.*`) is used for per-user, per-org login. It resolves the OIDC issuer from `clustertenantManager.oidc.issuerUrl` and uses standard OIDC discovery — no Zitadel Management API calls are made from this component.

---

## Helm configuration

### Fleet-manager OIDC (fleet plane)

The fleet-manager registers its **own** Zitadel project for fleet-operator and billing login. This is separate from each silo's per-org OIDC configuration.

```yaml
fleetManager:
  oidc:
    issuerUrl: "https://<your-instance>.zitadel.cloud"
    clientId: "<fleet-client-id>"
    redirectUri: "https://fleet.<base>/api/v1/auth/callback"
    existingSecret: "fleet-oidc-secret"   # keys: OIDC_CLIENT_SECRET, OIDC_SESSION_SECRET
    platformOperatorGroups: "platform-operators"
    orgAdminGroups: "org-admins"
    platformOperatorSeedEmail: ""         # bootstrap only; clear once groups are wired
```

::: tip Seed email is a bootstrap-only escape hatch
Set `platformOperatorSeedEmail` to the email of your first fleet operator before any Zitadel group mapping exists. Remove it once the IdP group-to-role mapping is working — an empty value fails closed (nobody is granted operator via the seed).
:::

### Fleet-manager Zitadel management

The fleet-manager is the **sole IAM\_OWNER** holder. It provisions per-org Zitadel Organisations on ClusterTenant creation and rotates the SA key in-place.

```yaml
fleetManager:
  zitadel:
    mgmtApiUrl: "https://<your-instance>.zitadel.cloud"
    existingSecret: "fleet-zitadel-sa-key"   # key: service-account-key (JWT bearer JSON)
    serviceAccountKeyKey: service-account-key
```

When `existingSecret` is set and `clusterTenantManagement.enabled` is true, the chart renders a namespaced `Role` + `RoleBinding` granting the fleet-manager's ServiceAccount `patch` on that single named Secret — the minimum RBAC surface for in-place key rotation. Source: [`apps/fleet-platform/templates/fleet-manager-zitadel-rotation-rbac.yaml`](https://github.com/italanta/opencrane/blob/main/apps/fleet-platform/templates/fleet-manager-zitadel-rotation-rbac.yaml).

### Per-silo OIDC (clustertenant-manager)

Each silo's clustertenant-manager has its own OIDC registration for per-org user login. The issuer is typically the same Zitadel instance, but using the **per-org Zitadel Organisation project** that the fleet-manager provisioned — not the fleet project.

```yaml
clustertenantManager:
  oidc:
    issuerUrl: "https://<your-instance>.zitadel.cloud"
    clientId: "<silo-client-id>"
    redirectUri: "https://<org>.<base>/api/v1/auth/callback"
    existingSecret: "silo-oidc-secret"   # keys: OIDC_CLIENT_SECRET, OIDC_SESSION_SECRET
    platformOperatorGroups: ""
    orgAdminGroups: "org-admins"
```

::: info No Zitadel management from the silo
The `clustertenantManager.oidc` block controls per-org *login* only. The silo makes no Zitadel Management API calls. The `fleetManager.zitadel` block is the only path to the Zitadel admin surface — it lives in the fleet plane, not the silo.
:::

### Self-service gate

The ClusterTenant management API, Zitadel-admin routes, and platform-DNS RBAC on the fleet-manager are all gated by `clusterTenantManagement.enabled` (the flag `deploy-multi-tenant.sh` sets to `true`; `deploy-silo.sh` sets it to `false`):

```yaml
clusterTenantManagement:
  enabled: true   # true on the fleet/multi-tenant install; false on each silo
billing:
  enabled: true   # true on the fleet install; false on each silo
```

---

## Environment variables (fleet-manager)

The Helm chart sets these on the fleet-manager pod; you do not set them directly:

| Variable | Set when | Description |
|---|---|---|
| `OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED` | `clusterTenantManagement.enabled` | Mounts the ClusterTenant lifecycle, Zitadel-admin, and platform-DNS routes |
| `OPENCRANE_BILLING_ENABLED` | `billing.enabled` | Mounts the billing-accounts routes |
| `ZITADEL_MGMT_API_URL` | `fleetManager.zitadel.mgmtApiUrl` | Zitadel Management API base URL |
| `ZITADEL_MGMT_SA_KEY` | from `fleetManager.zitadel.existingSecret` | SA key JSON (JWT bearer) at pod start |
| `ZITADEL_MGMT_SECRET_NAME` | derived from `fleetManager.zitadel.existingSecret` | Secret name the fleet-manager patches during in-place key rotation |
| `PLATFORM_BASE_DOMAIN` | `--base-domain` at install | Used to derive per-org redirect URIs when provisioning Zitadel Orgs |
| `OIDC_ISSUER_URL` | `fleetManager.oidc.issuerUrl` | Fleet OIDC issuer (fleet's own Zitadel project) |
| `OIDC_CLIENT_ID` | `fleetManager.oidc.clientId` | Fleet OIDC client id |

---

## Per-org login and silo projection

When the fleet-manager provisions a ClusterTenant, it projects the public Zitadel Organisation and OIDC application ids onto the cluster-scoped `ClusterTenant` CR. The silo's clustertenant-manager reads these from the CR to configure per-org login without needing its own Zitadel management access.

The fleet operator also seeds the `<org>-default` Tenant CRD when the ClusterTenant reaches ready state. A silo projection-repair loop (`POST /tenants/repair`) surfaces this in the silo API, so the default UserTenant appears without a separate provisioning step.

---

## Checking fleet-manager health

```bash
# Fleet-manager health
kubectl logs -n opencrane-system deployment/opencrane-fleet-manager --tail 50

# Confirm ClusterTenant routes are mounted (expect 200)
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<fleet-host>/api/v1/cluster-tenants

# Zitadel SA key probe (platform-operator gated)
oc --fleet-url https://<fleet-host> admin zitadel rotate-key --key-file /dev/null 2>&1 | head -5
# Should fail with validation error (422), not auth error (403)
```

→ For the SA-key rotation runbook, see [Zitadel key rotation](/security/zitadel-key-rotation).
→ For deploying a silo, see [Silo deployment model](/operators/silo-deployment).
