# OpenCrane Platform

## The Vision: AI Skills for Every Employee

AI agent skills are transforming how organizations build AI workflows. Tools like [OpenClaw](https://github.com/openclaw/openclaw) and Hermes are creating a new experience: a **personal AI assistant for every employee**. They learn your work patterns, integrate with your tools, and automate your most repetitive tasks—without requiring you to write a single line of code.

At the individual level, these tools work beautifully. One person, one assistant, endless possibilities.

**But what happens when you scale?** How do you give every member of your organization their own intelligent assistant? How do you share skills across teams? How do you manage context across different employees/projects/departments, and extend the agentic loop's context search with this information? How do you share context from the individual to the team? How do you keep them secure, compliant, and up-to-date? How do you prevent chaos?

### Meet OpenCrane

OpenCrane is a **control plane for organizational AI**. It sits on top of agent frameworks and gives organizations the power to issue personal assistants to every employee while maintaining complete control over security, governance, and organizational knowledge.

**Your organization stays in control:**
- **Personal assistants at scale**: Deploy a private AI assistant for every employee in minutes—each one isolated, secure, and acting on behalf of that employee.
- **Vendor independence**: Choose your LLM provider—Claude, GPT, open-source models—without lock-in. Manage your organization's own skills repository, build proprietary workflows, and share best practices on your own terms.
- **Self-hosted, data-sovereign**: Deploy OpenCrane on your infrastructure. Your organizational data—documents, conversations, collected information—stays on your network, never sent to external vendors. Shared skills are stored and versioned in your repository.
- **Security and governance**: One control plane manages identity, access control, skill deployment, network policies, cost tracking, and audit across all assistants.
- **Scale from day one**: From 10 employees to 10,000—the same Kubernetes-native architecture scales seamlessly.

## How It Works

Each employee gets their own **private AI assistant**—an isolated OpenClaw instance running as a Kubernetes pod. This assistant:

- **Knows who you are**: Holds your personal access tokens and can read and write data across the organization's platforms *as you*
- **Stays private**: Your conversations with the AI are stored locally in your pod's encrypted storage. OpenCrane enforces network-level policies and budget controls, but does not log or inspect conversation contents.
- **Accesses organizational knowledge**: Discovers shared skills from the organization's skill library (mounted read-only), enabling your assistant to use org-wide and team-specific capabilities without learning each skill individually.

OpenCrane orchestrates all of this by:
- **Infrastructure Management**: Deploying and managing assistants for each employee. Supporting local or remote LLM models. Enforcing token budgets and cost limits per employee.
- **Organizational knowledge**: Mounting shared skills so assistants can discover and use org-wide and team-specific capabilities.
- **Scalable architecture**: The same multi-tenant, Kubernetes-native design works from 10 to 10,000 employees.
- **Updates and skills**: Managing skill updates and deployments across the organization.
- **Secure storage**: All data stored in your organization's infrastructure, encrypted at rest.

**Roadmap (Phase 2+)**: Central monitoring agents (harvest data from Slack, Teams, email), dynamic context enrichment via RAG, conversation-level governance (inspect for security/policy alignment).

## Architecture

OpenCrane consists of three layers: a **Control Plane API** that manages tenants and policies, an **Operator** that reconciles resources on Kubernetes, and isolated **Per-Tenant Pods** running OpenClaw instances.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Control Plane (Express.js)                       │
│                 API: Tenant CRUD, Policy Management, Audit               │
│            Dual-write: K8s CRDs (source of truth) + PostgreSQL           │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
                ┌──────────────────────────────────────┐
                │      Kubernetes Operator (Node.js)   │
                │  Watches Tenant & AccessPolicy CRDs  │
                │  Reconciles: RBAC, Storage, Secrets  │
                └──────────────────────────────────────┘
                        │                    │
        ┌───────────────┴────────────────┬──┴───────────────┐
        ▼                                ▼                  ▼
    ┌─────────────┐              ┌─────────────┐     ┌──────────────┐
    │  jente.oc   │              │   bob.oc    │     │  sara.oc     │
    │  OpenClaw   │              │  OpenClaw   │     │  OpenClaw    │
    │ (isolated)  │              │ (isolated)  │     │ (isolated)   │
    ├─────────────┤              ├─────────────┤     ├──────────────┤
    │ Per-tenant: │              │ Per-tenant: │     │ Per-tenant:  │
    │ • Private   │              │ • Private   │     │ • Private    │
    │   bucket    │              │   bucket    │     │   bucket     │
    │ • IAM       │              │ • IAM       │     │ • IAM        │
    │ • Secrets   │              │ • Secrets   │     │ • Secrets    │
    ├─────────────┤              ├─────────────┤     ├──────────────┤
    │ Shared:     │              │ Shared:     │     │ Shared:      │
    │ • Skills    │              │ • Skills    │     │ • Skills     │
    │   PVC       │              │   PVC       │     │   PVC        │
    │ • Network   │              │ • Network   │     │ • Network    │
    │   Policies  │              │   Policies  │     │   Policies   │
    └─────────────┘              └─────────────┘     └──────────────┘
        │
        └────────────────────────────┬────────────────────────────
                                     │
        ┌────────────────────────────┴────────────────────────────┐
        ▼                                                          ▼
    ┌──────────────────────┐                      ┌─────────────────────┐
    │  Shared Skills PVC   │                      │  PostgreSQL (Audit) │
    │ ┌──────────────────┐ │                      │ • Tenants           │
    │ │ /shared-skills/  │ │                      │ • Policies          │
    │ │ ├── org/         │ │                      │ • Skills registry   │
    │ │ ├── teams/       │ │                      │ • Token usage       │
    │ │ └── ...skills... │ │                      │ • Budget snapshots  │
    │ └──────────────────┘ │                      │ • Audit logs        │
    └──────────────────────┘                      └─────────────────────┘
```

### Context Management: How Personal Assistants Connect to Organizational Knowledge

Each tenant's assistant accesses organizational knowledge through **shared skills**—a read-only volume mounted into every pod.

```
Personal Assistant (Tenant Pod)              Organizational Knowledge
┌──────────────────────────────────┐        ┌──────────────────────────────┐
│  jente's OpenClaw Instance       │        │  Shared Skills PVC           │
│                                  │        │  (ReadWriteMany mount)       │
│  1. During agentic loop:         │        │                              │
│     Discovers available skills   │◄───────┼──/shared-skills/org/        │
│     by scanning filesystem       │        │    ├── skill-a.md           │
│                                  │        │    ├── skill-b.md           │
│  2. Has access to:               │        │                              │
│     • Organization-wide skills   │        │  /shared-skills/teams/      │
│     • Team-scoped skills         │        │    └── engineering/         │
│     • Personal knowledge         │        │        ├── deploy-skill.md  │
│       (/data/openclaw/knowledge) │        │        └── debug-skill.md   │
│                                  │        │                              │
│  3. Operates within policies:    │        │  Control Plane:             │
│     • Network rules              │        │  • Scans PVC for skills     │
│     • Budget limits              │        │  • Updates Prisma registry  │
│     • Domain allowlists          │        │  • Indexes for discovery    │
└──────────────────────────────────┘        └──────────────────────────────┘
```

**Phase 1 Focus**: Static skill sharing and network-level governance.

**Phase 2+ Roadmap**: 
- Central monitoring agents (harvest data from Slack, Teams, email)
- Dynamic context enrichment (RAG-powered org knowledge)
- Conversation-level governance (inspect for security/policy alignment)

### Key Design Decisions

- **Tenant isolation**: Each user runs in their own pod with per-tenant storage (GCS bucket or PVC) mounted via CSI. IAM-enforced: each pod's Workload Identity service account can only access its own storage.
- **Operator-driven reconciliation**: Kubernetes CRDs (Tenant, AccessPolicy) are the source of truth. The operator watches for changes and idempotently reconciles: service accounts, secrets, deployments, ingress, network policies.
- **Shared organizational data**: Read-only shared storage exposes departments, projects, and team metadata. Access to shared resources (skills, project data) is controlled via role-based policies tied to each tenant's membership.
- **Shared skills library**: A ReadWriteMany PVC mounted read-only into all tenant pods enables org-wide and team-specific skill discovery. Skills are organized by scope: `/shared-skills/org/` and `/shared-skills/teams/{team}/`.
- **Credentials isolation**: Encrypted emptyDir (memory-backed) for pod-local secrets + K8s Secrets for encryption keys. Org-wide secrets via External Secrets Operator + cloud provider secret management (GCP Secret Manager, etc.).
- **Policy enforcement**: AccessPolicy CRDs define domain allowlists, network rules, and role-based access to shared resources, converted by the operator into Kubernetes NetworkPolicy and CiliumNetworkPolicy resources.
- **Dual-write pattern**: Control plane writes tenant and policy state to both K8s CRDs (source of truth for reconciliation) and PostgreSQL (queryable audit store for dashboards and reporting).
- **Cost tracking**: Per-tenant LiteLLM virtual API keys route LLM requests through a cost metering layer. Token usage and budgets are persisted in Prisma for audit and enforcement.
- **IaC**: Terraform for static infrastructure (GKE, Cloud SQL, VPC). Crossplane for dynamic per-tenant resources (GCS buckets, IAM bindings, cloud SQL users).

### Storage Layout

```
Pod filesystem (ephemeral):
  /data/secrets/                     -- Encrypted emptyDir (pod-local secrets)
  /etc/openclaw/encryption-key/      -- K8s Secret projected as file

Per-tenant bucket (GCS or PVC, IAM-scoped):
  /data/openclaw/
    ├── runtime/                     -- OpenClaw npm install (persists across restarts)
    ├── config/
    ├── agents/
    ├── sessions/
    ├── uploads/
    └── knowledge/                   -- Personal documents & context

Shared organizational data (ReadOnly PVC, GCP Filestore):
  /shared-org/
    ├── departments/                 -- Org structure, team membership
    ├── projects/                    -- Project metadata, ownership
    └── access-rules/                -- Role-based access policies
  
Shared skills library (ReadOnly PVC):
  /shared-skills/
    ├── org/                         -- Org-wide skills
    └── teams/{team}/                -- Team-scoped skills (access controlled by org data)

Security layer:
  • Kubernetes RBAC controls which tenants can read which shared data
  • AccessPolicy CRDs define visibility rules (tenant label selectors)
  • Pod ServiceAccount Workload Identity scopes access at cloud provider level
  • Org metadata indexes which skills/projects are visible to each tenant/team
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

AGPL-3.0-or-later
