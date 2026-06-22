# Build, Test & Infrastructure

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.

## Build And Test

- Install deps: `pnpm install`
- Build all: `pnpm build`
- Test all: `pnpm test`
- Build single package: `pnpm --filter @opencrane/operator build`
- Test single package: `pnpm --filter @opencrane/control-plane test`

## Infrastructure Architecture Context

Verified June 2026:

- **`multiInstance.enabled` is the master switch** for coexisting multiple OpenCrane installs in one cluster. It flips: operator + control-plane RBAC from `ClusterRole`/`ClusterRoleBinding` → namespaced `Role`/`RoleBinding`; cert issuer `ClusterIssuer` → namespaced `Issuer`; external-secrets `ClusterSecretStore` → namespaced `SecretStore`; CRDs install once cluster-wide (`--skip-crds` on releases); and a default-deny cross-instance `NetworkPolicy` per namespace. Scope resolution lives in `platform/helm/templates/_helpers.tpl` (e.g. `opencrane.mcpGatewayUrl`, `opencrane.litellmShared`), which picks release-prefixed in-cluster names vs. external shared endpoints.
- **Each plane is independently `instance` (release-local) or `shared`** (LiteLLM, Obot, skill-registry, external-secrets) via `values.yaml` — so one install can BYO a shared LiteLLM while owning its own gateway.
- **Terraform has two entry points:** `terraform/cloud/gcp/main.tf` provisions the full GCP stack in 5 phases (VPC/subnets → **GKE Autopilot**, private nodes → Artifact Registry → in-cluster Bitnami PostgreSQL + the OpenCrane chart → Cloud DNS wildcard → static global IP); `terraform/core/main.tf` is **cloud-agnostic** (assumes a ready kubeconfig, applies the chart only — works on k3d, EKS, AKS, on-prem). A DNS wildcard matches exactly one label, so the platform wildcard `*.<base>` covers **org apexes** `<org>.<base>` only; per-user **UserTenant** gateway hosts `<user>.<org>.<base>` (two labels) are covered by **per-org wildcards** `*.<org>.<base>` issued/declared at org-provision time, not by the platform wildcard. `<base>` itself is the **ClusterTenant** base domain. See [`cluster-architecture.md` → Tenancy Model](./cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).
- **GCS buckets are provisioned in-operator at reconcile time via Workload Identity, NOT by Terraform.** Terraform sets up cloud IAM/networking; per-UserTenant storage is a runtime operator concern.
- **Deploy scripts form a hierarchy:** `wizard.sh` (interactive UX) → `install.sh` (scripted installer, local/gcp modes; delegates GCP to `deploy.sh`) → `deploy.sh` (bootstrap). Local dev uses k3d value profiles under `platform/tests/`: `values-k3d-local.yaml` (fast), `-strict.yaml` (prod-like), `-e2e.yaml`.
- **`platform/tests/multi-instance-conformance.sh` validates isolation statically** via `helm template` (no live cluster) — checks per-instance `WATCH_NAMESPACE`, namespaced RBAC, absence of cross-instance cluster-scoped issuers/stores, and default-deny NetworkPolicies. Run it after touching Helm RBAC/scope logic.

## Infrastructure Layout

Infrastructure-as-code lives under `platform/`:

| Path | Owns |
|------|------|
| `platform/terraform/` | Cloud identities, trust bindings, IAM role attachments |
| `platform/helm/` | Kubernetes service accounts, RBAC bindings, workload identity annotations, NetworkPolicy |
| `platform/deploy.sh`, `platform/install.sh`, `platform/wizard.sh` | Local deploy / install / setup flows |
| `platform/tests/` | Platform-level tests |

## Terraform / Helm Split Of Responsibility

This split is the concrete implementation of the [Central Identity Model](./architecture.md#central-identity-model):

- **Terraform** defines cloud identities, trust bindings, and IAM role attachments — cloud IAM is the source of truth for cloud resource access.
- **Helm** defines Kubernetes service accounts, RBAC bindings, and workload identity annotations — Kubernetes RBAC is the source of truth for Kubernetes API access.
- Application code should consume the identity these layers provision, never invent a parallel auth scheme.

See [`k8s.md`](./k8s.md) for the per-service defaults (dedicated service accounts, token automount, least-privilege RBAC) these templates must satisfy.
