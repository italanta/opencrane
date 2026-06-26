# Silo deployment model (S6 / ADR 0002)

OpenCrane S6 splits a platform installation into two distinct release shapes — a single shared **central** release and one **silo** release per ClusterTenant — so that every customer's runtime planes, operator, and database are fully dedicated and isolated from every other customer's.

> See also:
> [Networking & isolation](/operators/networking) — the S2 NetworkPolicy floor and the silo boundary that this deployment model maps onto.
> [Linkerd identity substrate](/operators/linkerd-identity) — the S5 mTLS layer that rides on top of the silo boundary.
> [Silo IAM: inheritance & sharing](/integrators/silo-iam) — how IAM policies, skills, and resource shares are scoped per silo.
> [ClusterTenant members](/operators/cluster-tenant-members) — managing membership within a ClusterTenant.

---

## Why silos exist

Before S6, the platform ran shared singleton services — one Obot, one skill-registry, one LiteLLM, one Postgres — that multiplexed every ClusterTenant's data behind application-level access controls. That design has a fundamental weakness: isolation depends entirely on every plane's ACL being correct, and the shared control-plane must constantly infer *which tenant* a given request or database row belongs to (the "resolution-ambiguity class").

The silo model eliminates both problems in the same move: each ClusterTenant gets its own dedicated instances of every runtime plane and its own database. The silo *is* the scope, so there is no tenant to infer and no shared ACL to trust.

::: tip Two release shapes, one chart
Both shapes use the same Helm chart and the same control-plane image. The `deploymentRole` value selects which templates render and which API routes the control-plane mounts. You never manage two charts — only two deployment profiles.
:::

---

## Central vs silo at a glance

```
┌───────────────────────────────────────────────────────────────┐
│  CENTRAL release (one per cluster)                            │
│  namespace: opencrane-system                                  │
│  deploymentRole: central                                      │
│                                                               │
│  ┌─────────────────┐   ┌──────────────┐                       │
│  │  control-plane  │   │   Zitadel    │                       │
│  │  (fleet/admin   │   │   (IdP)      │                       │
│  │   surface only) │   └──────────────┘                       │
│  └─────────────────┘                                          │
│  ClusterTenant manager ON · billing ON                        │
│  No runtime planes (Obot/MCP, skill-registry, LiteLLM, etc.) │
│  Cluster-wide infra: ingress-nginx, external-dns,             │
│    CloudNativePG operator, cert-manager                       │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  SILO release (one per ClusterTenant)                         │
│  namespace: opencrane-<cluster-tenant>                        │
│  deploymentRole: silo                                         │
│                                                               │
│  ┌─────────────────┐  ┌──────────┐  ┌────────────────────┐   │
│  │  control-plane  │  │ operator │  │ Obot / MCP gateway │   │
│  │  (tenant-facing │  │ (scoped  │  └────────────────────┘   │
│  │   surface only) │  │  to this │  ┌────────────────────┐   │
│  └─────────────────┘  │  silo)   │  │  skill-registry    │   │
│  ┌─────────────────┐  └──────────┘  └────────────────────┘   │
│  │  CNPG Postgres  │               ┌────────────────────┐    │
│  │  (per-CT DB,    │               │  LiteLLM           │    │
│  │   this NS only) │               └────────────────────┘    │
│  └─────────────────┘               ┌────────────────────┐    │
│                                    │  Cognee            │    │
│                                    └────────────────────┘    │
│  ClusterTenant manager OFF · billing OFF                      │
│  Reuses cluster-wide infra installed by the central release   │
└───────────────────────────────────────────────────────────────┘
```

| Concern | Central | Silo |
|---|---|---|
| `deploymentRole` | `central` | `silo` |
| Namespace | `opencrane-system` | `opencrane-<cluster-tenant>` |
| control-plane routes mounted | Fleet / super-admin (`_ServesFleetSurface`) | Tenant-facing (`_ServesTenantSurface`) |
| Zitadel | Yes | No |
| ClusterTenant manager + billing | Yes | No |
| Obot / MCP gateway | No | Yes |
| skill-registry | No | Yes |
| LiteLLM | No | Yes |
| Cognee | No | Yes |
| Operator | No | Yes (namespace-scoped to this silo) |
| CloudNativePG Postgres | Shared cluster-wide operator only | One dedicated `Cluster` CR per silo namespace |
| Installs cluster-wide infra | Yes (ingress-nginx, external-dns, CNPG operator, cert-manager) | No (reuses central's) |

---

## How the control-plane knows its role

Both release shapes use the same container image. The Helm chart sets the `OPENCRANE_CONTROL_PLANE_ROLE` environment variable from `deploymentRole`, and the control-plane reads it at boot via `_ControlPlaneRole()` in [`apps/control-plane/src/infra/deployment-role.ts`](https://github.com/italanta/opencrane/blob/main/apps/control-plane/src/infra/deployment-role.ts).

- `central` → only `_ServesFleetSurface()` routes mount (ClusterTenant lifecycle, Zitadel key management, platform DNS, billing).
- `silo` → only `_ServesTenantSurface()` routes mount (tenants, policies, skills, model routing, MCP servers, AI budget, sessions, …).
- The audit log and infrastructure endpoints (`/healthz`, `/prom`) mount in both roles.

An unrecognised value causes the control-plane to crash at boot with a clear error — misconfigurations are loud, not silent.

::: warning Do not set OPENCRANE_CONTROL_PLANE_ROLE manually
The deploy scripts set this via Helm's `deploymentRole`. If you set it by hand and it disagrees with the Helm value, the chart will render the wrong template set while the process mounts the wrong routes — a split-brain you will find very difficult to debug. Always use the deploy scripts.
:::

---

## Deploy sequence

You must install the central release first. The central release brings up the cluster-wide singletons (ingress-nginx, external-dns, the CloudNativePG operator, cert-manager) that every silo reuses. `deploy-silo.sh` actively enforces this: it preflights for the CloudNativePG CRD (`clusters.postgresql.cnpg.io`) and exits with a clear error if the central release has not been installed.

### Step 1 — install the central release

```bash
./platform/deploy-multi-tenant.sh \
    --base-domain dev.opencrane.ai \
    [--cert-manager --acme-email ops@example.com --dns01-provider clouddns] \
    [--ingress-ip 34.1.2.3]
```

Required flags: `--base-domain`. Optional: `--ingress-ip` (derived automatically from the ingress-nginx LoadBalancer when omitted), `--cert-manager` and its TLS sub-flags, any `k8s-deploy.sh` flag.

This installs into `opencrane-system` with `deploymentRole=central`, `clusterTenantManager.enabled=true`, and `billing.enabled=true`. No runtime planes are rendered. All cluster-wide infrastructure (ingress-nginx, external-dns, the CloudNativePG operator, cert-manager) is installed once here.

### Step 2 — install one silo per ClusterTenant

```bash
./platform/deploy-silo.sh \
    --base-domain dev.opencrane.ai \
    --cluster-tenant acme \
    [--namespace opencrane-acme] \
    [--ingress-ip 34.1.2.3]
```

Required flags: `--base-domain` and `--cluster-tenant`. Optional: `--namespace` (defaults to `opencrane-<cluster-tenant>`), `--ingress-ip` (derived from the cluster-wide ingress-nginx LoadBalancer when omitted).

Repeat this command for each ClusterTenant. Each invocation:

- installs into the silo namespace (`opencrane-<cluster-tenant>` by default);
- passes `--no-ingress-nginx --no-external-dns --no-db-operator` so the cluster-wide singletons are not re-installed;
- applies a dedicated `Cluster` CR (CloudNativePG) in the silo namespace — one Postgres per silo, reconciled by the cluster-wide CNPG operator;
- sets `deploymentRole=silo`, `clusterTenantManager.enabled=false`, and `billing.enabled=false`.

::: info One Postgres per silo
Each silo gets its own CNPG `Cluster` in its own namespace. The silo control-plane connects to its own database, so there is no shared database and no cross-tenant query path. The cluster-wide CloudNativePG operator (installed by the central release) watches all namespaces and reconciles every silo's `Cluster` CR.
:::

### Upgrade

Upgrades follow the same shape: re-run the relevant deploy script with `--reuse-values` to inherit the current Helm values and apply only your overrides. Upgrade the central release and all silo releases independently — they share a chart but are separate Helm releases.

---

## Helm chart internals

The single chart uses two Helm template helpers (defined in [`platform/helm/templates/_helpers.tpl`](https://github.com/italanta/opencrane/blob/main/platform/helm/templates/_helpers.tpl)) to condition which templates render:

- `opencrane.isCentral` — true when `deploymentRole` is `central` (or unset, since `central` is the default). Controls whether Zitadel, the fleet API, and the cluster-wide infra templates render.
- `opencrane.isSilo` — true when `deploymentRole` is `silo`. Controls whether the operator, Obot, skill-registry, LiteLLM, Cognee, and the per-CT networking templates render.

Any value other than `central` or `silo` causes `helm template` / `helm install` to fail immediately with a clear error, so a typo in `deploymentRole` is caught before any cluster change is made.

The `deploymentRole` value in [`platform/helm/values.yaml`](https://github.com/italanta/opencrane/blob/main/platform/helm/values.yaml) defaults to `central`, which preserves the previous single-install behaviour: a plain `helm install` with no profile renders the central super-admin surface, which is the same as what a legacy multi-tenant install produced.

---

## Isolation properties

Each silo's isolation rests on three independent layers:

1. **Dedicated instances** — no plane is shared between silos. Data and credentials are co-resident only within a silo's own namespace.
2. **Namespace isolation + NetworkPolicy floor (S2)** — the default-deny NetworkPolicy in each silo namespace blocks all cross-silo traffic at L3/L4. See [Networking & isolation](/operators/networking).
3. **Linkerd mTLS identity (S5, optional)** — when Linkerd is installed, workload identity is pinned by SPIFFE SVID, adding a second layer keyed on cryptographic identity rather than network position. See [Linkerd identity substrate](/operators/linkerd-identity).

The operator in each silo is namespace-scoped (`requireWatchNamespace`). It owns that silo's `<org>.<base>` Ingress, `DNSEndpoint`, and certificate binding — and only those. A silo operator cannot write resources in another silo's namespace.

---

## What is not yet automated

::: warning Future work
Two significant pieces of automation are **not yet shipped** and must be done manually for now:

**Silo provisioning on ClusterTenant creation.** When a new ClusterTenant is registered via the central control-plane API, the corresponding silo release is not automatically installed. You must run `deploy-silo.sh` by hand for each ClusterTenant. Automating this — so the central provisioner stamps out a silo release when a ClusterTenant is created — is tracked as future work.

**Data migration off the shared database.** Existing installations that used the old shared-singleton model (one Postgres for all tenants) must migrate each ClusterTenant's data into its own per-silo database. No automated migration tooling is shipped. Stage this migration carefully: provision each silo's database, copy the relevant rows, verify, then cut over the silo control-plane to its new database and decommission the tenant's rows from the shared database.
:::

---

## Environment variables set by the chart

| Variable | Central | Silo | Description |
|---|---|---|---|
| `OPENCRANE_CONTROL_PLANE_ROLE` | `central` | `silo` | Selects which API routes mount at boot. |
| `OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED` | `true` | `false` | Enables the ClusterTenant self-service manager routes. |
| `OPENCRANE_BILLING_ENABLED` | `true` | `false` | Enables the billing account routes. |

These are set by the Helm chart templates; you do not set them directly in values. Use `deploymentRole` in `values.yaml` or the `--deployment-role` flag in `k8s-deploy.sh`.
