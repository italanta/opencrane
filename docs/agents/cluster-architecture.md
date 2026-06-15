# Kubernetes Cluster Architecture

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) and [`k8s.md`](./k8s.md).
> This is the authoritative topology reference. Operational coding rules (service-account defaults,
> auth-less routes, Workload Identity) are in [`k8s.md`](./k8s.md); the Helm/Terraform ownership
> split is in [`infra.md`](./infra.md). Verified against the tree June 2026.

## Mental Model

OpenCrane runs a **containerised control plane + reconciling operator + per-tenant agent pods** in
one Kubernetes cluster. The cluster is built to host **N strictly-isolated customer instances side by
side**. A Helm chart deploys the platform planes (release-local by default); the operator then
creates tenant workloads at runtime. Isolation strength is a per-customer choice (`isolationTier`).

```
┌────────────────────────────────────────────────────────────────────────┐
│  Kubernetes cluster  (GKE Autopilot in cloud; k3d/EKS/AKS/on-prem also)  │
│                                                                          │
│  Cluster-scoped (once):  CRDs · ClusterTenant CRs · (MI) cross-inst deny │
│                                                                          │
│  ┌── install / instance namespace (e.g. "opencrane" or "oc-acme") ────┐ │
│  │  PLATFORM PLANES (Helm-deployed, 1 replica each by default)         │ │
│  │   • operator            reconciles CRs → tenant workloads           │ │
│  │   • control-plane :8080  API /api/v1 + internal /api/internal       │ │
│  │   • litellm     :4000    LLM cost/budget proxy (egress for pods)    │ │
│  │   • mcp-gateway :8080    Obot — MCP runtime, polls control-plane    │ │
│  │   • skill-registry :5000 entitlement-gated skill delivery          │ │
│  │   • skill-oci-store :5000 Zot OCI registry (optional)              │ │
│  │                                                                     │ │
│  │  TENANT WORKLOADS (operator-created, one set per Tenant CR)         │ │
│  │   Deployment(OpenClaw, 1 replica) · Service · Ingress · ConfigMap   │ │
│  │   · Secrets(enc-key, litellm-key) · SA · (CT) ResourceQuota+LimitRange │
│  └─────────────────────────────────────────────────────────────────────┘ │
│         ▲ external traffic: GCE LB (GCP) / ingress-nginx (on-prem)       │
│           → control-plane:8080  and  *.domain → tenant Ingress           │
└────────────────────────────────────────────────────────────────────────┘
```

## Physical Cluster

- **Cloud target: GKE Autopilot** (`platform/terraform/cloud/gcp/`) — Google-managed nodes, pay-per-pod, private nodes, VPC-native with secondary IP ranges for pods/services, Cloud NAT egress, Cloud DNS wildcard pointing at a reserved static global IP. Provisioned in phases: networking → cluster → Artifact Registry → in-cluster Bitnami PostgreSQL + the chart → DNS.
- **Cloud-agnostic target** (`platform/terraform/core/`) — assumes a ready kubeconfig and applies only the chart; works on k3d (local dev/e2e), EKS, AKS, on-prem. `hosting.provider: onprem` makes cloud storage/identity no-ops.

## Helm Template Inventory

Everything the chart can deploy lives in `platform/helm/templates/` (`_helpers.tpl` holds the scope-resolution logic):

| Template | Creates |
|----------|---------|
| `operator-deployment.yaml` / `operator-rbac.yaml` | Operator Deployment + SA + (Cluster)Role/Binding |
| `control-plane-deployment.yaml` / `-service.yaml` / `-rbac.yaml` | Control-plane Deployment, ClusterIP `:8080`, SA + RBAC (incl. TokenRequest mint, pod kill-switch) |
| `litellm-deployment.yaml` / `-service.yaml` / `-secret.yaml` | LiteLLM Deployment, ClusterIP `:4000`, master-key Secret |
| `obot-mcp-gateway-deployment.yaml` / `mcp-gateway-service.yaml` | Obot gateway Deployment, ClusterIP `:8080` |
| `skill-registry-deployment.yaml` / `-service.yaml` | Skill-registry Deployment (+ ClusterRole for TokenReview), ClusterIP `:5000` |
| `skill-oci-store.yaml` | Optional Zot OCI registry Deployment + Service + PVC `:5000` |
| `networkpolicy-planes.yaml` | Per-plane ingress allow-lists (the auth-less `/api/internal` boundary) |
| `networkpolicy.yaml` | Baseline tenant egress policy |
| `networkpolicy-multi-instance.yaml` | Cross-instance default-deny (rendered only when `multiInstance.enabled`) |
| `cluster-issuer.yaml` | cert-manager `ClusterIssuer` (or namespaced `Issuer` in MI) — selfSigned dev / ACME DNS-01 prod |
| `external-secrets-store.yaml` / `external-secrets.yaml` | `ClusterSecretStore`/`SecretStore` + `ExternalSecret` (GCP/Azure/AWS secret managers) |
| `awareness-prometheusrule.yaml` / `awareness-grafana-dashboard.yaml` | Awareness SLO alerts + Grafana dashboard ConfigMap |
| `validate-config.yaml` | Pre-install validation hook (rejects unsafe non-dev config) |

CRDs are shipped separately under `platform/helm/crds/` (see below), not in `templates/`.

## The Planes, Wired

All planes are **ClusterIP-only** (no external LB) — external traffic arrives through Ingress. Internal DNS is `<release>-<plane>.<namespace>.svc`. Each plane is independently release-local (`instance`) or `shared` via `values.yaml` (`sharedPlatform.*`).

- **operator** → Kubernetes API only. Watches Tenant/AccessPolicy/ClusterTenant CRs; injects the other planes' URLs into tenant pods. Deep-dive: [`apps/operator.md`](./apps/operator.md).
- **control-plane** (`:8080`) → Postgres + K8s API + Cognee + LiteLLM. The hub everything else talks to. Deep-dive: [`apps/control-plane.md`](./apps/control-plane.md).
- **mcp-gateway / Obot** (`:8080`) → polls control-plane `GET /api/internal/obot-registry`; tenant pods reach MCP servers through it (projected token `aud=obot-gateway`).
- **skill-registry** (`:5000`) → validates tenant projected token (`aud=skill-registry`) via TokenReview, proxies to control-plane internal bundle endpoint. Deep-dive: [`apps/skill-registry.md`](./apps/skill-registry.md).
- **litellm** (`:4000`) → the only LLM egress path for tenant pods; operator mints a per-tenant virtual key Secret; enforces budget.

## Namespace Model

**Single-install (default):** one release namespace holds all planes + all tenant workloads; CRDs and RBAC are cluster-scoped singletons. Ref-less Tenants land here.

**Multi-instance (`multiInstance.enabled: true`):** each customer install gets its own namespace (`oc-acme`, `oc-globex`, …) with its own planes, namespaced RBAC, namespaced cert Issuer/SecretStore, and a default-deny cross-instance NetworkPolicy. CRDs are installed **once** cluster-wide (`--skip-crds` on releases). See [Multi-Instance](#multi-instance-cluster-shape).

**Per-ClusterTenant fencing (when a Tenant has `clusterTenantRef`):** the operator provisions/uses the parent's bound namespace with a **PSA `restricted`** label, a `ResourceQuota` (cpu/mem/pods/storage/gpu), and a `LimitRange` (per-container defaults — required because the quota constrains `requests.*`).

## Network Topology

- **Ingress:** GCE Ingress (GCP) or ingress-nginx (on-prem). External clients hit control-plane `:8080`; tenants are exposed at `<tenant>.<ingressDomain>` → tenant Service.
- **`networkpolicy-planes.yaml`** restricts control-plane ingress to: ingress controller, operator, mcp-gateway, skill-registry, and tenant pods (contract re-pull). The Zot OCI store accepts the control-plane only. Because `/api/internal/*` has **no auth middleware**, this policy is its only boundary — see [`k8s.md`](./k8s.md#internal-routes-without-auth-middleware).
- **Tenant egress** is default-DNS + the CIDR/FQDN allow-lists compiled from the tenant's AccessPolicy (standard NetworkPolicy always; optional CiliumNetworkPolicy for FQDN filtering).
- **TLS:** cert-manager issues a wildcard cert (ACME DNS-01 in prod, selfSigned in dev). Issuance is driven API-first via control-plane `/api/v1/platform/dns`, not raw `kubectl`.

## Isolation Tiers

`ClusterTenantIsolationTier` (`libs/contracts/src/cluster-tenant.types.ts`) determines cluster placement:

| Tier | Cluster shape | Status |
|------|---------------|--------|
| `shared` | Namespace on bin-packed shared nodes; ResourceQuota caps the customer. | ✅ Built |
| `dedicatedNodes` | Namespace + a tainted node pool; operator stamps `nodeSelector`+`tolerations` (from `compute.mode=dedicated`, `compute.nodePool`). | ✅ Built |
| `dedicatedCluster` | Customer gets its own kube-apiserver via an **external provisioner** (webhook seam, AGPL-clean; Kamaji-shaped). | ⏸️ **Parked** — control-plane validates and rejects with `422 TIER_UNAVAILABLE` unless a provisioner is registered. |

The provisioner seam is a registry (`apps/control-plane/src/core/cluster-tenants/`) with a built-in shared provisioner plus an optional external webhook (`CLUSTER_TENANT_PROVISIONER_WEBHOOK_*`).

## Multi-Instance Cluster Shape

`multiInstance.enabled` flips these safety defaults (conformance-tested statically by `platform/tests/multi-instance-conformance.sh`):

| Concern | Single-install | Multi-instance |
|---------|---------------|----------------|
| Operator/control-plane RBAC | `ClusterRole`/`ClusterRoleBinding` | namespaced `Role`/`RoleBinding` per instance |
| Operator watch scope | `WATCH_NAMESPACE=""` (all) | scoped + **fail-closed** if unset (`REQUIRE_WATCH_NAMESPACE`) |
| CRDs | installed with the release | installed once cluster-wide, `--skip-crds` on releases |
| cert Issuer / SecretStore | `ClusterIssuer` / `ClusterSecretStore` | namespaced `Issuer` / `SecretStore` |
| Cross-instance traffic | n/a | default-deny NetworkPolicy, same-instance allow only |

## Workload Identity

- **Cloud (GKE):** operator's SA carries `iam.gke.io/gcp-service-account: …`; GKE exchanges the projected K8s token for a GSA access token so the operator can provision GCS buckets without static creds. On-prem this is absent.
- **In-cluster (tenant pods):** up to three audience-bound projected SA tokens mounted read-only under `/var/run/opencrane/tokens/` — `aud=obot-gateway|skill-registry|control-plane`, kubelet-rotated (`projectedTokenTtlSeconds`). Each receiving plane validates the audience via TokenReview. These tokens are never exposed to a browser.

## CRDs

Six CRDs in `platform/helm/crds/`, across **two API groups**:

| CRD | Group | Scope |
|-----|-------|-------|
| `Tenant` | `tenant.opencrane.io` | Namespaced — the OpenClaw agent-pod definition. |
| `AccessPolicy` | `tenant.opencrane.io` | Namespaced — egress/MCP/dataset policy. |
| `ClusterTenant` | `opencrane.io` | **Cluster-scoped** — the customer/isolation unit. |
| `MCPServer` | `opencrane.io` | Namespaced — MCP server registration. |
| `Schedule` | `opencrane.io` | Namespaced — recurring task schedule. |
| `SkillRegistry` | `opencrane.io` | Namespaced — skill registry catalog. |

All use `spec`/`status` subresources: spec is user/control-plane-owned, status is operator-owned.
