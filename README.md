# OpenCrane Platform

Multi-tenant [OpenClaw](https://github.com/openclaw/openclaw) platform on Kubernetes. Each tenant (team member) gets an isolated OpenClaw instance with per-tenant cloud storage and IAM-scoped access, behind a subdomain (`jente.opencrane.ai`).

## Architecture

```
         ┌──────────────────────────┐          ┌──────────────────────────┐
         │      Control Plane       │◄────────►│   Cloud SQL (Postgres)   │
         │   admin.opencrane.ai     │          │   org / users / state    │
         │   Express + Prisma       │          ├──────────────────────────┤
         └─────────────┬────────────┘          │        Skills Repo       │
                       │                       │   versioned AI skills    │
                       ▼                       └──────────────────────────┘

┌────────────────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌────────────────────────────┐
│ Cross-Repo Operator Plane  │   │     jente.oc     │   │     bob.oc       │   │    Egress Control Plane    │
│                            │   │     OpenClaw     │   │     OpenClaw     │   │                            │
│ - repo reconcile           │   │    (isolated)    │   │    (isolated)    │   │ - outbound policy          │
│ - skill deployment         │   ├────────┬─────────┤   ├────────┬─────────┤   │ - proxy / allowlists       │
│ - config push              │   │   GCS  │ IAM     |   │   GCS  │ IAM     │   | - secrets brokerage        │  
│ - bootstrap sync           │   │ bucket │+ Secret │   │ bucket │+ Secret │   │ - AI token access          │
│ - rollout coordination     │   │        │ Vault   │   │ IAM    │ Vault   │   │ - audit / rate limiting    │
│                            │   └──────────────────┘   └──────────────────┘   │ - external access control  │
│                            │   ┌──────────────────┐                          │                            │
│                            │   │     sara.oc      │                          │                            │
│                            │   │     OpenClaw     │                          │                            │
│                            │   │    (isolated)    │                          │                            │
│                            │   ├────────┬─────────┤                          │                            │
│                            │   │   GCS  │ IAM     │                          │                            │
│                            │   │ bucket │+ Secret │                          │                            │
│                            │   │        │ Vault   │                          │                            │
└────────────────────────────┘   └──────────────────┘                          └────────────────────────────┘
```

### Key Design Decisions

- **Tenant isolation**: Each user runs in their own pod with a dedicated GCS bucket mounted via GCS Fuse CSI. IAM-enforced: each pod's Workload Identity service account can only access its own bucket.
- **GCS-resident OpenClaw**: The Docker image is a slim Node 22 runtime. OpenClaw is npm-installed into the per-tenant GCS bucket on first boot and persists across pod restarts. Tenants update independently via `openclaw update`.
- **Credentials**: Encrypted emptyDir (memory-backed) for pod-local secrets + K8s Secret for encryption key. Org-wide secrets via External Secrets Operator + GCP Secret Manager.
- **Skills**: Developed individually in tenant pods, promoted to team/org via a shared ReadWriteMany PVC (GCP Filestore).
- **Access control**: Network-level domain allowlisting via CiliumNetworkPolicy, managed by AccessPolicy CRDs.
- **Observability**: Structured JSON logs (pino) shipped to Cloud Logging by GKE natively. No in-cluster logging stack required.
- **Dual-write**: Control plane writes tenant state to both K8s CRDs (source of truth for operator) and PostgreSQL (query store for dashboard/API).
- **IaC**: Terraform for static infra (GKE, Cloud SQL, VPC). Crossplane for dynamic per-tenant resources (GCS buckets, IAM bindings).

### Storage Layout

```
Pod filesystem (ephemeral):
  /data/secrets/                     -- Encrypted emptyDir (pod-local secrets)
  /etc/openclaw/encryption-key/      -- K8s Secret projected as file

GCS Fuse CSI mount (per-tenant bucket, IAM-scoped):
  /data/openclaw/
    ├── runtime/                     -- OpenClaw npm install (persists across restarts)
    ├── config/
    ├── agents/
    ├── sessions/
    ├── uploads/
    └── knowledge/

Shared skills (ReadOnly PVC, GCP Filestore):
  /shared-skills/                    -- Org/team skills library
```

## Components

| Component | Path | Description |
|-----------|------|-------------|
| Helm chart | `helm/opencrane/` | K8s manifests, CRDs, operator + control plane deployments |
| Operator | `operator/` | Watches Tenant/AccessPolicy CRDs, reconciles per-tenant resources |
| Control Plane | `control-plane/` | Express REST API with Prisma ORM for tenant/skill/policy management |
| Docker | `docker/` | Container images for tenant pods, operator, and control plane |
| Skills | `skills/shared/` | Org/team shared skill library |
| Terraform | `terraform/` | GCP infrastructure: GKE, Cloud SQL, VPC, Crossplane |

## Quick Start

### Prerequisites

- Node 22+, pnpm 10+
- Kubernetes 1.28+ (GKE recommended)
- Helm 3
- Terraform 1.5+ (for GCP deployment)
- PostgreSQL 15+ (Cloud SQL or local)

### Development

```bash
pnpm install
pnpm build
pnpm test
```

### GCP Deployment

```bash
# 1. Provision infrastructure
cd terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars  # edit with your GCP project
terraform init && terraform apply

# 2. Install the platform
helm install opencrane helm/opencrane \
  -f helm/opencrane/values-gcp.yaml \
  --set tenant.storage.gcpProject=my-project \
  --set ingress.domain=opencrane.ai \
  --set controlPlane.database.existingSecret=opencrane-cloudsql

# 3. Create a tenant
kubectl apply -f - <<EOF
apiVersion: opencrane.io/v1alpha1
kind: Tenant
metadata:
  name: jente
spec:
  displayName: Jente
  email: jente@example.com
EOF
```

The operator creates a GCS bucket, Workload Identity service account, encryption key, deployment, service, and ingress. Access at `https://jente.opencrane.ai`.

### Version Pinning

Pin a tenant to a specific OpenClaw version:

```yaml
apiVersion: opencrane.io/v1alpha1
kind: Tenant
metadata:
  name: jente
spec:
  displayName: Jente
  email: jente@example.com
  openclawVersion: "2026.3.15"
```

Without `openclawVersion`, tenants install `latest` on first boot and can self-update via `openclaw update`.

## License

MIT
