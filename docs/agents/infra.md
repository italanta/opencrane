# Build, Test & Infrastructure

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.

## Build And Test

- Install deps: `pnpm install`
- Build all: `pnpm build`
- Test all: `pnpm test`
- Build single package: `pnpm --filter @opencrane/fleet-operator build`
- Test single package: `pnpm --filter @opencrane/clustertenant-operator test`

## Infrastructure Architecture Context

Verified June 2026:

- **`multiInstance.enabled` is the master switch** for coexisting multiple OpenCrane installs in one cluster. It flips: operator + control-plane RBAC from `ClusterRole`/`ClusterRoleBinding` → namespaced `Role`/`RoleBinding`; cert issuer `ClusterIssuer` → namespaced `Issuer`; external-secrets `ClusterSecretStore` → namespaced `SecretStore`; CRDs install once cluster-wide (`--skip-crds` on releases); and a default-deny cross-instance `NetworkPolicy` per namespace. Scope resolution lives in the `k8s-platform` Helm library chart's `libs/k8s-platform/templates/_helpers.tpl` (e.g. `opencrane.mcpGatewayUrl`, `opencrane.litellmShared`), which picks release-prefixed in-cluster names vs. external shared endpoints.
- **Each plane is independently `instance` (release-local) or `shared`** (LiteLLM, Obot, skill-registry, external-secrets) via `values.yaml` — so one install can BYO a shared LiteLLM while owning its own gateway.
- **Terraform has two entry points:** `libs/k8s-platform/terraform/cloud/gcp/main.tf` provisions the full GCP stack in 5 phases (VPC/subnets → **GKE Autopilot**, private nodes → Artifact Registry → in-cluster Bitnami PostgreSQL + the OpenCrane chart → Cloud DNS zone + reserved static global IP + the shared DNS-writer Workload-Identity binding); `libs/k8s-platform/terraform/core/main.tf` is **cloud-agnostic** (assumes a ready kubeconfig, applies the chart only — works on k3d, EKS, AKS, on-prem). Terraform writes only the **install-time** records (apex, `*.<domain>`, control-plane host) into the zone; **per-org `<org>.<domain>` A records are written at runtime by external-dns** from the operator's `DNSEndpoint` CRs — Terraform never writes them. The platform `*.<domain>` wildcard covers org hosts `<org>.<domain>` (one label); that is all that is needed because there are no per-user subdomains. The `dns` module also provisions the single `roles/dns.admin` GSA that BOTH external-dns and the cert-manager DNS-01 solver impersonate (one binding, shared). `<domain>` is the platform base domain. See [`cluster-architecture.md` → Tenancy Model](./cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).
- **GCS buckets are provisioned in-operator at reconcile time via Workload Identity, NOT by Terraform.** Terraform sets up cloud IAM/networking; per-UserTenant storage is a runtime operator concern.
- **Deploy scripts.** The central fleet chart deploys via `apps/fleet-platform/deploy.sh` and each silo via `apps/clustertenant-platform/deploy.sh`; both drive the shared engine in `libs/k8s-platform/` (`k8s-deploy.sh`, `gke-deploy.sh`, `configure-oidc.sh`, plus `deploy-single-tenant.sh`). Legacy installers (`wizard.sh` interactive UX → `install.sh` → `deploy.sh`, plus `vps-deploy.sh`) still live under `platform/`. Local dev uses k3d value profiles under `libs/k8s-platform/tests/`: `values-k3d-local.yaml` (fast), `-strict.yaml` (prod-like), `-e2e.yaml`.
- **`libs/k8s-platform/tests/multi-instance-conformance.sh` validates isolation statically** via `helm template` (no live cluster) — checks per-instance `WATCH_NAMESPACE`, namespaced RBAC, absence of cross-instance cluster-scoped issuers/stores, and default-deny NetworkPolicies. Run it after touching Helm RBAC/scope logic.

## Infrastructure Layout

Infrastructure-as-code lives under `apps/*-platform/` (the Helm deploy charts) and `libs/k8s-platform/` (the shared engine, terraform, and tests):

| Path | Owns |
|------|------|
| `libs/k8s-platform/terraform/` | Cloud identities, trust bindings, IAM role attachments |
| `apps/fleet-platform/` (chart `opencrane-fleet`) | Central-plane K8s service accounts, RBAC bindings, workload identity annotations, NetworkPolicy, CRDs |
| `apps/clustertenant-platform/` (chart `opencrane-silo`) | Per-silo plane workloads + NetworkPolicies (litellm, obot gateway, skill-registry, OCI store) |
| `libs/k8s-platform/` (Helm library chart + shared deploy engine) | Shared named-templates (`templates/_helpers.tpl`), `k8s-deploy.sh` / `gke-deploy.sh` / `configure-oidc.sh` / `deploy-single-tenant.sh` |
| `apps/fleet-platform/deploy.sh`, `apps/clustertenant-platform/deploy.sh` | Fleet / silo deploy flows |
| `platform/deploy.sh`, `platform/install.sh`, `platform/wizard.sh`, `platform/vps-deploy.sh` | Legacy install / setup flows |
| `libs/k8s-platform/tests/` | Platform-level tests |

## Terraform / Helm Split Of Responsibility

This split is the concrete implementation of the [Central Identity Model](./architecture.md#central-identity-model):

- **Terraform** defines cloud identities, trust bindings, and IAM role attachments — cloud IAM is the source of truth for cloud resource access.
- **Helm** defines Kubernetes service accounts, RBAC bindings, and workload identity annotations — Kubernetes RBAC is the source of truth for Kubernetes API access.
- Application code should consume the identity these layers provision, never invent a parallel auth scheme.

See [`k8s.md`](./k8s.md) for the per-service defaults (dedicated service accounts, token automount, least-privilege RBAC) these templates must satisfy.
