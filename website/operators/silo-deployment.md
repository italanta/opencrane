# Silo deployment model

OpenCrane splits a platform installation into a single **fleet release** (cluster-wide admin plane) and one **silo release** per ClusterTenant — so every customer's runtime planes, operator, and database are fully dedicated and isolated from every other customer's.

> See also:
> [Fleet and silo operating model](/operators/fleet-silo-model) — how the fleet-manager and clustertenant-manager differ, what each owns, and how to configure fleet OIDC and Zitadel management.
> [Networking & isolation](/operators/networking) — the NetworkPolicy floor and the silo boundary.
> [Linkerd identity substrate](/operators/linkerd-identity) — the mTLS layer that rides on top of the silo boundary.
> [Silo IAM: inheritance & sharing](/integrators/silo-iam) — how IAM policies, skills, and resource shares are scoped per silo.

---

## Why silos exist

Before the silo model, the platform ran shared singleton services — one Obot, one skill-registry, one LiteLLM, one Postgres — multiplexing every ClusterTenant's data behind application-level access controls. That design has a fundamental weakness: isolation depends entirely on every plane's ACL being correct, and the manager must constantly infer *which tenant* a given request or database row belongs to.

The silo model eliminates both problems in the same move: each ClusterTenant gets its own dedicated instances of every runtime plane and its own database. The silo *is* the scope, so there is no tenant to infer and no shared ACL to trust.

---

## Fleet vs silo at a glance

```
┌───────────────────────────────────────────────────────────────┐
│  FLEET release (one per cluster)                              │
│  namespace: opencrane-system                                  │
│  script: apps/fleet-platform/deploy.sh                        │
│                                                               │
│  ┌──────────────────────────────────────────────────┐         │
│  │  fleet-manager                                   │         │
│  │  ClusterTenant lifecycle · billing               │         │
│  │  OrgMembership · platform DNS                    │         │
│  │  Zitadel IAM admin · SA-key rotation             │         │
│  │  Fleet registry DB (fleet's own Postgres)        │         │
│  └──────────────────────────────────────────────────┘         │
│  ┌─────────────┐                                              │
│  │  Zitadel    │  (trusted OIDC IdP for both planes)          │
│  └─────────────┘                                              │
│  clusterTenantManagement.enabled: true                        │
│  billing.enabled: true                                        │
│  Cluster-wide infra: ingress-nginx, external-dns,             │
│    CloudNativePG operator, cert-manager                       │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  SILO release (one per ClusterTenant)                         │
│  namespace: opencrane-<cluster-tenant>                        │
│  script: apps/clustertenant-platform/deploy.sh --cluster-tenant <name>  │
│                                                               │
│  ┌───────────────────┐  ┌──────────┐  ┌─────────────────┐    │
│  │ clustertenant-    │  │ operator │  │ Obot / MCP      │    │
│  │ manager           │  │ (scoped  │  │ gateway         │    │
│  │ (tenant-facing    │  │  to this │  └─────────────────┘    │
│  │  surface + CT     │  │  silo)   │  ┌─────────────────┐    │
│  │  read-model)      │  └──────────┘  │ skill-registry  │    │
│  └───────────────────┘               └─────────────────┘    │
│  ┌───────────────────┐               ┌─────────────────┐    │
│  │  CNPG Postgres    │               │ LiteLLM         │    │
│  │  (per-CT DB,      │               └─────────────────┘    │
│  │   this NS only)   │               ┌─────────────────┐    │
│  └───────────────────┘               │ Cognee          │    │
│                                      └─────────────────┘    │
│  clusterTenantManagement.enabled: false                       │
│  billing.enabled: false                                       │
│  Reuses cluster-wide infra installed by the fleet release     │
└───────────────────────────────────────────────────────────────┘
```

| Concern | Fleet release | Silo release |
|---|---|---|
| Primary manager | `fleet-manager` | `clustertenant-manager` |
| Helm image key | `fleetManager.image` | `clustertenantManager.image` |
| Namespace | `opencrane-system` | `opencrane-<cluster-tenant>` |
| ClusterTenant lifecycle + billing | Yes (`clusterTenantManagement.enabled: true`) | No |
| Zitadel IAM admin + SA key | Yes (`fleetManager.zitadel.*`) | No |
| Per-org user login (OIDC) | Fleet OIDC (`fleetManager.oidc.*`) | Silo OIDC (`clustertenantManager.oidc.*`) |
| Fleet registry DB | Yes (`fleetManager.database.*`) | No |
| Runtime planes (Obot, skill-registry, LiteLLM, Cognee) | No | Yes |
| Operator | No (fleet-manager reconciles ClusterTenants) | Yes (namespace-scoped to this silo) |
| Per-silo Postgres | No | Yes — one CNPG `Cluster` CR per silo namespace |
| Cluster-wide infra (ingress-nginx, external-dns, CNPG operator, cert-manager) | Installed here (once) | Reused from fleet release |

::: tip Two charts, two install profiles
The fleet release uses the `opencrane-fleet` chart (`apps/fleet-platform`) and the silo release uses the `opencrane-silo` chart (`apps/clustertenant-platform`). The deploy scripts set the appropriate profile flags (`fleetManager.clusterTenantApi.enabled`, `billing.enabled`, namespace) for each role.
:::

---

## Deploy sequence

You must install the fleet release first. The fleet release installs the cluster-wide singletons (ingress-nginx, external-dns, the CloudNativePG operator, cert-manager) that every silo reuses. `deploy-silo.sh` actively enforces this: it preflights for the CloudNativePG CRD (`clusters.postgresql.cnpg.io`) and exits with a clear error if the fleet release has not been installed.

### Step 1 — install the fleet release

```bash
apps/fleet-platform/deploy.sh \
    --base-domain dev.opencrane.ai \
    [--cert-manager --acme-email ops@example.com --dns01-provider clouddns] \
    [--ingress-ip 34.1.2.3]
```

Required flags: `--base-domain`. Optional: `--ingress-ip` (derived automatically from the ingress-nginx LoadBalancer when omitted), `--cert-manager` and its TLS sub-flags.

This installs the `opencrane-fleet` chart into `opencrane-system` with `fleetManager.clusterTenantApi.enabled=true` and `billing.enabled=true`. The fleet-manager and all cluster-wide infrastructure (CRDs, ingress-nginx, external-dns, CNPG operator, cert-manager) are installed here. No runtime planes (Obot, skill-registry, LiteLLM, Cognee) are part of this release — those live in silos.

### Step 2 — install one silo per ClusterTenant

```bash
apps/clustertenant-platform/deploy.sh \
    --base-domain dev.opencrane.ai \
    --cluster-tenant acme \
    [--namespace opencrane-acme] \
    [--ingress-ip 34.1.2.3]
```

Required flags: `--base-domain` and `--cluster-tenant`. Optional: `--namespace` (defaults to `opencrane-<cluster-tenant>`), `--ingress-ip` (derived from the cluster-wide ingress-nginx LoadBalancer when omitted).

Repeat this command for each ClusterTenant. Each invocation:

- installs into the silo namespace (`opencrane-<cluster-tenant>` by default);
- passes `--no-ingress-nginx --no-external-dns --no-db-operator` so the cluster-wide singletons are not re-installed;
- applies a dedicated CNPG `Cluster` CR in the silo namespace — one Postgres per silo, reconciled by the cluster-wide CNPG operator;
- sets `clusterTenantManagement.enabled=false` and `billing.enabled=false`.

::: info One Postgres per silo
Each silo gets its own CNPG `Cluster` in its own namespace. The silo's clustertenant-manager connects to its own database — there is no shared database and no cross-tenant query path. The cluster-wide CloudNativePG operator (installed by the fleet release) watches all namespaces and reconciles every silo's `Cluster` CR.
:::

### Upgrade

Re-run the relevant deploy script with `--reuse-values` to inherit the current Helm values and apply only your overrides. Upgrade the fleet release and each silo release independently — they use separate charts and are separate Helm releases.

---

## Isolation properties

Each silo's isolation rests on three independent layers:

1. **Dedicated instances** — no plane is shared between silos. Data and credentials are co-resident only within a silo's own namespace.
2. **Namespace isolation + NetworkPolicy floor** — the default-deny NetworkPolicy in each silo namespace blocks all cross-silo traffic at L3/L4. See [Networking & isolation](/operators/networking).
3. **Linkerd mTLS identity (optional)** — when Linkerd is installed, workload identity is pinned by SPIFFE SVID, adding a second layer keyed on cryptographic identity rather than network position. See [Linkerd identity substrate](/operators/linkerd-identity).

The operator in each silo is namespace-scoped (`requireWatchNamespace`). It owns that silo's Ingress, `DNSEndpoint`, and certificate binding — and only those. A silo operator cannot write resources in another silo's namespace.

---

## Helm chart internals

Both the fleet-manager and clustertenant-manager deployments are always rendered by the chart. What differs is which features each exposes:

- **Fleet-manager** renders its ClusterTenant lifecycle, billing, Zitadel-admin, and platform-DNS routes only when `clusterTenantManagement.enabled=true`. The fleet-manager's cluster-scoped RBAC and the Zitadel rotation `Role`/`RoleBinding` are gated on the same flag.
- **Clustertenant-manager** renders the tenant-facing surface (tenants, policies, groups, budgets, model routing, sessions) and holds ClusterTenant/OrgMembership as local read-models projected from the fleet.

Source: [`apps/fleet-platform/templates/fleet-manager-deployment.yaml`](https://github.com/italanta/opencrane/blob/main/apps/fleet-platform/templates/fleet-manager-deployment.yaml) and [`apps/clustertenant-platform/templates/clustertenant-manager-deployment.yaml`](https://github.com/italanta/opencrane/blob/main/apps/clustertenant-platform/templates/clustertenant-manager-deployment.yaml).

---

## What is not yet automated

::: warning Future work
Two significant pieces of automation are **not yet shipped** and must be done manually for now:

**Silo provisioning on ClusterTenant creation.** When a new ClusterTenant is registered via the fleet API, the corresponding silo release is not automatically installed. You must run `deploy-silo.sh` by hand for each ClusterTenant. Automating this — so the fleet stamps out a silo release on ClusterTenant creation — is tracked as future work.

**Data migration off the shared database.** Existing installations that used the old shared-singleton model (one Postgres for all tenants) must migrate each ClusterTenant's data into its own per-silo database. No automated migration tooling is shipped. Stage this migration carefully: provision each silo's database, copy the relevant rows, verify, then cut over the silo clustertenant-manager to its new database.
:::

---

## Environment variables set by the chart

### Fleet-manager

| Variable | Description |
|---|---|
| `OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED` | Mounts the ClusterTenant lifecycle, Zitadel-admin, and platform-DNS routes. Set from `clusterTenantManagement.enabled`. |
| `OPENCRANE_BILLING_ENABLED` | Mounts the billing-accounts routes. Set from `billing.enabled`. |
| `ZITADEL_MGMT_API_URL` | Zitadel instance base URL for the Management API. Set from `fleetManager.zitadel.mgmtApiUrl`. |
| `ZITADEL_MGMT_SA_KEY` | Service-account key JSON for Zitadel (JWT bearer). Set from `fleetManager.zitadel.existingSecret`. |
| `ZITADEL_MGMT_SECRET_NAME` | Kubernetes Secret name the fleet-manager patches during key rotation. Derived from `fleetManager.zitadel.existingSecret`. |
| `PLATFORM_BASE_DOMAIN` | Base domain for per-org Zitadel redirect URI provisioning. Set from `--base-domain`. |

### Clustertenant-manager (silo)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Per-silo Postgres connection string. Set from `clustertenantManager.database.existingSecret` or `url`. |
| `OIDC_ISSUER_URL` | Per-org OIDC issuer for user login. Set from `clustertenantManager.oidc.issuerUrl`. |

Set these via Helm values or the deploy scripts; do not set them by hand.
