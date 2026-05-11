# OpenCrane Platform

## The Vision: AI Skills for Every Employee

AI agent skills are transforming how organizations build AI workflows. Tools like [OpenClaw](https://github.com/openclaw/openclaw) and Hermes are creating a new experience: a **personal AI assistant for every employee**. They learn your work patterns, integrate with your tools, and automate your most repetitive tasks—without requiring you to write a single line of code.

At the individual level, these tools work beautifully. One person, one assistant, endless possibilities.

**But what happens when you scale?** How do you give every member of your organization their own intelligent assistant? How do you share skills across teams? How do you manage context across different employees/projects/departments, and extend the agentic loop's context search with this information? How do you share context from the individual to the team? How do you keep them secure, compliant, and up-to-date? How do you prevent chaos?

## Why OpenCrane? The Risk of Vendor-Hosted Solutions

Existing vendor-hosted AI platforms (like Claude Cowork and OpenAI's emerging skills solutions) offer convenience, but at a hidden cost: **existential risk**. Here's why self-hosting your AI organization matters:

**The Problem with Vendor-Hosted Skills:**
- **Vendor becomes your competitor**: When you build and host skills on any vendor platform, that vendor learns your workflows, best practices, and domain expertise. They can commercialize this knowledge or offer it to your competitors.
- **Loss of competitive advantage**: Your proprietary skills—the institutional knowledge that differentiates you—are indexed, analyzed, and potentially shared or monetized by the host.
- **Pricing lock-in**: Vendors can unilaterally change pricing, restrict features, or discontinue services. You have no fallback; your skills are stuck in their ecosystem.
- **Data governance nightmare**: Personal conversations between employees and AI are potentially visible to the vendor. Regulatory compliance (GDPR, HIPAA, SOC 2) becomes uncertain when your data lives in someone else's infrastructure.
- **Model switching trap**: Build your skills on Claude today, need GPT-4 tomorrow? Your skills are tightly coupled to the vendor's platform. Migration is painful or impossible.

**Why Self-Hosting Matters:**
- **You own your skills**: Proprietary workflows and knowledge stay in your control, not monetized by vendors.
- **Competitive moat**: Build institutional knowledge that's unique to your organization, unavailable to competitors.
- **True data sovereignty**: Employee conversations, company context, and organizational intelligence stay on your infrastructure—never shared with third parties.
- **Model independence**: Switch between Claude, GPT-4, open-source models, or your own without losing your skills investment.
- **Regulatory compliance**: Full audit trails, RBAC, encryption, and data residency under your control.

**The Difference:**
| Aspect | Vendor-Hosted Solutions | Self-Hosted (OpenCrane) |
|--------|------------------------|------------------------|
| **Skill ownership** | Vendor hosts & can analyze your skills | You own everything |
| **Competitive risk** | Vendor learns your workflows | Your workflows stay private |
| **Model switching** | Locked to vendor's LLM | Use any LLM provider |
| **Data residency** | Vendor's servers | Your infrastructure |
| **Regulatory control** | Vendor's terms; compliance uncertain | Full compliance under your control |
| **Pricing** | Vendor can change at will | You control infrastructure costs |

OpenCrane solves this by giving organizations a **self-hosted control plane** where personal assistants, shared skills, and organizational knowledge stay completely under your control—while still providing the convenience and scale of a cloud-native platform.

### Meet OpenCrane

OpenCrane is a **control plane for organizational AI**. It sits on top of agent frameworks and gives organizations the power to issue personal assistants to every employee while maintaining complete control over security, governance, organizational knowledge, and information access.

**Your organization stays in control:**
- **Personal assistants at scale**: Deploy a private AI assistant for every employee in minutes—each one isolated, secure, and acting on behalf of that employee.
- **Vendor independence**: Choose your LLM provider—Claude, GPT, open-source models—without lock-in. Manage your organization's own skills repository, build proprietary workflows, and share best practices on your own terms.
- **Self-hosted, data-sovereign**: Deploy OpenCrane on your infrastructure. Your organizational data—documents, conversations, collected information—stays on your network, never sent to external vendors. Shared skills are stored and versioned in your repository.
- **Security and governance**: One control plane manages identity, access control, skill deployment, network policies, cost tracking, audit, and RBAC-filtered access to organizational knowledge across all assistants.
- **Organizational intelligence**: Company-wide information gathering agents harvest knowledge from your platforms (Slack, Teams, email, tickets) and make it available to assistants through retrieval plugins, with automatic role-based filtering.
- **Scale from day one**: From 10 employees to 10,000—the same Kubernetes-native architecture scales seamlessly.

## How It Works

Each employee gets their own **private AI assistant**—an isolated OpenClaw instance running as a Kubernetes pod. This assistant:

- **Knows who you are**: Holds your personal access tokens and can read and write data across the organization's platforms *as you*
- **Stays private**: Your conversations with the AI are stored locally in your pod's encrypted storage. OpenCrane enforces network-level policies and budget controls, but does not log or inspect conversation contents.
- **Accesses organizational knowledge**: Uses a retrieval plugin to discover shared skills and organizational context—teams, projects, company policies—during the agentic loop, with automatic RBAC filtering based on your role.

OpenCrane also runs **company-wide information gathering agents** (dedicated tenant deployments with elevated permissions) that:
- Continuously harvest organizational knowledge from Slack, Teams, email, ticketing systems, and other company platforms
- Index this knowledge into a centralized Org Knowledge Index
- Make it available to all tenant assistants via retrieval plugins (role-based access)

OpenCrane orchestrates all of this by:
- **Infrastructure Management**: Deploying and managing assistants for each employee. Supporting local or remote LLM models. Enforcing token budgets and cost limits per employee.
- **Retrieval Plugins**: Every tenant pod runs a retrieval plugin that extends the agentic loop with RBAC-filtered organizational context.
- **Organizational Knowledge**: Company-wide agents harvest and index org data; retrieval plugins make it accessible based on role.
- **Scalable architecture**: The same multi-tenant, Kubernetes-native design works from 10 to 10,000 employees.
- **Skill sharing**: Managing skill updates and deployments across the organization.
- **Secure storage**: All data stored in your organization's infrastructure, encrypted at rest.

See [**Current State** and **Roadmap**](#current-state-phase-1) below for implementation details and future capabilities.

## Architecture

OpenCrane is represented here as a clean operating model: a central **Control Plane** backed by **Cloud SQL + Skills Repo**, a **Cross-Repo Operator Plane**, isolated **OpenClaw tenant pods**, and an **Egress Control Plane** that enforces network and AI access guardrails.

```
    ┌──────────────────────────┐          ┌───────────────────────────┐
    │      Control Plane       │◄────────►│   Cloud SQL (Postgres)    │
    │   admin.opencrane.ai     │          │   org / users / state     │
    │   Express + Prisma       │          ├───────────────────────────┤
    └─────────────┬────────────┘          │ Versioned AI Skills Repo  │
                  │                       │ Tenant Managment          │
                  │                       │ Access Control Management │
                  │                       │ Shared Context Management │                 
                  ▼                       └───────────────────────────┘
┌────────────────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌────────────────────────────┐
│ Cross-Repo Operator Plane  │   │     jente.oc     │   │     jane.oc      │   │    Egress Control Plane    │
│                            │   │     OpenClaw     │   │     OpenClaw     │   │                            │
│ - repo reconcile           │   │    (isolated)    │   │    (isolated)    │   │ - outbound policy          │
│ - skill deployment         │   ├────────┬─────────┤   ├────────┬─────────┤   │ - proxy / allowlists       │
│ - config push              │   │   GCS  │ IAM     │   │   GCS  │ IAM     │   │ - secrets brokerage        │
│ - bootstrap sync           │   │ bucket │+ Secret │   │ bucket │+ Secret │   │ - AI token access          │
│ - rollout coordination     │   │        │ Vault   │   │ IAM    │ Vault   │   │ - audit / rate limiting    │
│                            │   └──────────────────┘   └──────────────────┘   │ - external access control  │
│ - Department & Project     │                                                 │                            │
│     documents              │                                                 │                            │
│ - Company-Wide Agents      │   ┌──────────────────┐                          │                            │
│                            │   │     niels.oc     │                          │                            │
│                            │   │     OpenClaw     │                          │                            │
│                            │   │    (isolated)    │                          │                            │
│                            │   ├────────┬─────────┤                          │                            │
│                            │   │   GCS  │ IAM     │                          │                            │
│                            │   │ bucket │+ Secret │                          │                            │
│                            │   │        │ Vault   │                          │                            │
└────────────────────────────┘   └──────────────────┘                          └────────────────────────────┘
```

In this view, the Egress Control Plane represents the network and model-access guardrails (including AI token access and rate controls), while the operator plane handles tenant rollout and shared skill distribution.

### Retrieval Plugins: Extending Tenant Context

Each tenant pod runs a **retrieval plugin** that bridges the isolated assistant with organizational knowledge during the agentic loop. This plugin:

1. **Receives queries** from the OpenClaw agent as it needs context
2. **Queries the Org Knowledge Index** for relevant departments, projects, teammates, company policies
3. **Respects role-based access** — returns only knowledge the tenant can access based on their team/permissions
4. **Can push knowledge back** — skills developed locally can be promoted to shared libraries after review

```
During Agentic Loop:
┌─────────────────────────────────────┐
│  OpenClaw Assistant Reasoning       │
│  "Who is on the engineering team?"  │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  Retrieval Plugin                   │
│  (runs within tenant pod)           │
│  1. Check: Can this tenant access   │
│     engineering team info?          │
│  2. Query Org Index                 │
│  3. Return: Members, projects,      │
│     shared skills (filtered)        │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Org Knowledge Index (PostgreSQL + Vector DB)    │
│  Returns filtered results based on tenant RBAC   │
└──────────────────────────────────────────────────┘
```

### Current State (Phase 1)

OpenCrane Phase 1 delivers a **production-ready multi-tenant control plane** with isolated assistant deployments, skill sharing, and governance.

**What's working today:**
- ✅ **Multi-tenant isolation**: Each employee gets an isolated Kubernetes pod with dedicated storage (private drive)
- ✅ **Operator-driven lifecycle**: Automatic deployment, updates, and policy reconciliation via Kubernetes CRDs
- ✅ **Shared skills library**: Org-wide and team-scoped skills mounted read-only into all tenant pods
- ✅ **Network policies**: Domain allowlisting and IP restrictions enforced via Kubernetes NetworkPolicy and CiliumNetworkPolicy
- ✅ **Cost control**: Per-tenant budgets and token tracking via LiteLLM integration
- ✅ **Audit trail**: All tenant and policy changes dual-written to K8s (source of truth) and PostgreSQL (queryable)
- ✅ **IAM-first identity**: Workload Identity for pod authentication; no shared bearer tokens
- ✅ **Self-hosted**: Deploy on your infrastructure (Kubernetes 1.28+); full data sovereignty
- ✅ **Helm & Terraform IaC**: Production-ready deployment templates

**Retrieval plugin foundation (basic):**
- ✅ Static skill discovery from filesystem during agentic loop
- ✅ Skill metadata indexed in PostgreSQL for discovery
- ⏳ **In progress**: RBAC-aware retrieval plugin SDK for accessing org context

### Roadmap (Phase 2+)

**Phase 2 (Near-term):**
- 🚀 **Dynamic retrieval plugins**: Retrieval plugin SDK with RBAC filtering for querying Org Knowledge Index
- 🚀 **Company-wide harvesting agents**: System agents that continuously index knowledge from Slack, Teams, email, ticketing systems
- 🚀 **Org Knowledge Index**: PostgreSQL backend with optional vector DB for similarity search
- 🚀 **Knowledge promotion**: Workflows for promoting locally-developed skills to shared libraries with governance/review

**Phase 3 (Medium-term):**
┌──────────────────────────────────────────────────────────────────────────┐
│ Control Plane (Express + Prisma)                                        │
│ • Tenant CRUD APIs • Policy management                                  │
│ • Issues and controls assistant + harvester tenants                     │
│ • Configures GuardLLM policy bundles + LiteLLM routing                 │
│ • Dual-write to K8s CRDs and Postgres                                   │
└──────────────┬───────────────────────────────────────────────────────────┘
      │
  ┌─────────┴──────────┬─────────────────────────┐
  │                    │                         │
  ▼                    ▼                         ▼
┌─────────────────┐  ┌──────────────────┐   ┌────────────────────────────┐
│ K8s Operator    │  │ Crossplane       │   │ Kubernetes Control Plane   │
│ (Node.js)       │  │ (Cloud resources)│   │ (GKE/K8s 1.28+)            │
│ • Watch CRDs    │  │ • GCS buckets    │   │                            │
│ • Reconcile K8s │  │ • IAM bindings   │   │ Assistant Tenant Pods      │
│ • Deploy pods   │  │ • Cloud SQL users│   │ ┌──────────┐  ┌──────────┐ │
│ • Networking    │  │ • Service accts  │   │ │ jente.oc │  │ bob.oc   │ │
└─────────────────┘  └──────────────────┘   │ │ OpenClaw │  │ OpenClaw │ │
                    │ │(isolated)│  │(isolated)│ │
                    │ ├──────────┤  ├──────────┤ │
                    │ │Private:  │  │Private:  │ │
                    │ │• Drive   │  │• Drive   │ │
                    │ │• Secrets │  │• Secrets │ │
                    │ │• Config  │  │• Config  │ │
                    │ ├──────────┤  ├──────────┤ │
                    │ │Retrieval │  │Retrieval │ │
                    │ │Plugin    │  │Plugin    │ │
                    │ │(RBAC)    │  │(RBAC)    │ │
                    │ └────┬─────┘  └────┬─────┘ │
                    │      │             │       │
                    │ Topic Harvesters (small)   │
                    │ ┌────────────────────────┐ │
                    │ │ Slack Project X        │ │
                    │ │ Harvester (tenant)     │ │
                    │ │ pull + index           │ │
                    │ └──────────┬─────────────┘ │
                    │ ┌────────────────────────┐ │
                    │ │ WhatsApp Project Y     │ │
                    │ │ Harvester (tenant)     │ │
                    │ │ pull + index           │ │
                    │ └──────────┬─────────────┘ │
                    └────────────┼───────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Network Guardrails Plane (Egress Control)                               │
│ • Outbound policies • Proxy/allowlists • Secrets brokerage              │
│ • AI token access • Audit/rate limiting • External access control       │
└──────────────────────────────┬───────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ LLM Control Gateway (in-cluster): LiteLLM + GuardLLM                   │
│ • Tenant/model routing • Guardrails and policy checks                  │
│ • Quota and budget enforcement • Usage and audit telemetry             │
└──────────────────────────────┬───────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ LLM Providers: Claude / OpenAI / OSS / self-hosted                     │
└──────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│ Org Knowledge Index (outside K8s control graph)      │
│ (PostgreSQL + optional Vector DB)                    │
│ • Departments / projects / policies / team context   │
│ • Harvested org data                                 │
│ • RBAC visibility rules                              │
└───────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ PostgreSQL Audit Log                                 │
│ • Tenant state • Policy changes • Skills registry    │
│ • Token usage and budgets • Audit trail              │
└──────────────────────────────────────────────────────┘
  • Org structure: departments, team hierarchies, membership
  • Projects: metadata, ownership, tags
  • Role-based access rules: defines visibility for each tenant
  • Indexed knowledge: harvested from Slack, Teams, email, ticketing systems
  • Queryable via retrieval plugins with RBAC filtering

Security layer:
  • Kubernetes RBAC controls pod access to Org Knowledge Index
  • Retrieval Plugin enforces role-based visibility (tenant label selectors)
  • Pod ServiceAccount Workload Identity scopes cloud provider access
  • Company-wide agents authenticated with elevated permissions to write to Index
  • Tenant assistants authenticated with limited read permissions (RBAC-filtered)
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
