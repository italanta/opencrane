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

OpenCrane also runs **company-wide information gathering agents** (system services with elevated permissions) that:
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

OpenCrane consists of five core layers: a **Control Plane API** that manages tenants and policies, a **Kubernetes Operator** that reconciles tenant resources, a **Crossplane** layer that provisions cloud infrastructure, **Per-Tenant Pods** running isolated OpenClaw instances with retrieval plugins, and **Company-Wide Information Agents** that gather and index organizational knowledge.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                 Company-Wide Information Gathering Layer                        │
│   Central Agents: Slack → Teams → Email → Ticketing → Index in Org Knowledge    │
└──────────────┬─────────────────────────────────────────────────────────┬────────┘
               │                                                         │
    ┌──────────▼──────────┐                              ┌───────────────▼────────┐
    │  Control Plane      │                              │  Org Knowledge Index   │
    │  (Express.js)       │                              │  • Departments         │
    │  • CRUD APIs        │                              │  • Projects            │
    │  • Audit logging    │                              │  • Team hierarchy      │
    │  • Dual-write to K8s│                              │  • Company context     │
    │    and PostgreSQL   │                              └────────────────────────┘
    └────────┬────────────┘
             │
    ┌────────▼────────────────────────────────────────────────────────┐
    │  Kubernetes Control Plane (GKE/K8s 1.28+)                       │
    ├────────┬────────────────────────┬─────────────────┬─────────────┤
    │ Operator                │ Crossplane              │ RBAC        │
    │ (Node.js)              │ (Cloud Resources)        │ & Policies  │
    │ • Watch Tenant CRs     │ • GCS buckets            │             │
    │ • Watch AccessPolicy   │ • IAM bindings           │             │
    │ • Reconcile K8s        │ • Cloud SQL users        │             │
    │   resources            │ • Service accounts       │             │
    │ • Deploy pods          │                          │             │
    │ • Manage networking    │                          │             │
    └────────┬───────────────────────────┬──────────────┴─────────────┘
             │                           │
    ┌────────▼───────────────────────────▼──────────────────────────────┐
    │                         Per-Tenant Pods                           │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
    │  │ jente.oc │  │ bob.oc   │  │niels.oc  │  │info-harvest      │   │
    │  │ OpenClaw │  │ OpenClaw │  │ OpenClaw │  │Agent (system)    │   │
    │  │(isolated)│  │(isolated)│  │(isolated)│  │(gathers org data)│   │
    │  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────────────┤   │
    │  │Private:  │  │Private:  │  │Private:  │  │Private:          │   │
    │  │• Drive   │  │• Drive   │  │• Drive   │  │• Drive           │   │
    │  │• Secrets │  │• Secrets │  │• Secrets │  │• Secrets         │   │
    │  │• Config  │  │• Config  │  │• Config  │  │                  │   │
    │  ├──────────┤  ├──────────┤  ├──────────┤  │                  │   │
    │  │Retrieval │  │Retrieval │  │Retrieval │  │                  │   │
    │  │Plugin    │  │Plugin    │  │Plugin    │  │                  │   │
    │  │(queries  │  │(queries  │  │(queries  │  │                  │   │
    │  │ Org data)│  │ Org data)│  │ Org data)│  │                  │   │
    │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘   │
    └────────┬───────────────────────────────────────────────────────┬──┘
             │                                                       │
    ┌────────▼─────────────┐                        ┌────────────────▼────────┐
    │ Shared Storage       │                        │ PostgreSQL Audit Log    │
    │ ┌────────────────┐   │                        │ • Tenants               │
    │ │ Shared Skills  │   │                        │ • Policies              │
    │ │ /shared/       │   │                        │ • Skills registry       │
    │ │ ├── org/       │   │                        │ • Token usage           │
    │ │ └── teams/{T}/ │   │                        │ • Audit trail           │
    │ └────────────────┘   │                        └─────────────────────────┘
    └──────────────────────┘
```

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
- 🎯 **RAG-powered retrieval**: Vector similarity search for org knowledge; dynamic context enrichment
- 🎯 **Conversation-level governance**: Inspect and log conversations for security/policy alignment
- 🎯 **Multi-cluster deployment**: Geo-replication and cross-region failover
- 🎯 **Advanced RBAC**: Fine-grained resource-level permissions (per-skill, per-project visibility)

**Phase 4+ (Long-term):**
- 🔮 **Inter-tenant orchestration**: Assistants collaborating on shared tasks
- 🔮 **Custom plugins**: Tenant-developed plugins for domain-specific retrieval
- 🔮 **Real-time knowledge sync**: Sub-second propagation of org data to retrieval indexes
- 🔮 **Federated learning**: Insights shared across tenants without exposing private data

**Not on roadmap (by design):**
- ❌ Conversation inspection/logging (privacy-first architecture)
- ❌ Centralized conversation storage (data stays with tenant)
- ❌ Vendor lock-in (bring your own LLM provider)

### Context Management: How Personal Assistants Connect to Organizational Knowledge

Each tenant's assistant uses a **retrieval plugin** to discover both shared skills and organizational context—departments, projects, teammates—based on role-based access rules.

```
Personal Assistant (Tenant Pod)              Retrieval Plugin                 Org Knowledge
┌──────────────────────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│  jente's OpenClaw Instance       │    │ Retrieval Plugin    │    │  Org Knowledge Index │
│                                  │    │ (RBAC-aware)        │    │                      │
│  1. During agentic loop:         │    │                     │    │ • Teams/projects     │
│     "Who in marketing can help?" │───►│ Check access rules: │───►│ • Department data    │
│                                  │    │ Is jente in mktg?   │    │ • Shared context     │
│  2. Retrieves from:              │    │ Can she see this?   │    │ • Company policies   │
│     • Shared skills              │    │                     │    │                      │
│     • Org context (RBAC-filtered)│    │ Build rich context  │    │ Returned filtered    │
│     • Team knowledge             │    │ for agentic loop    │    │ based on role        │
│                                  │    │                     │    │                      │
│  3. Can promote knowledge:       │    │                     │    │                      │
│     Send local skill             │───►│ Validation layer    │───►│ New shared skill     │
│     → shared library review      │    │                     │    │ (pending review)     │
└──────────────────────────────────┘    └─────────────────────┘    └──────────────────────┘
```

### Key Design Decisions

- **Tenant isolation**: Each user runs in their own pod with per-tenant storage (private drive: GCS bucket, PVC, or local storage) mounted via CSI. IAM-enforced: each pod's Workload Identity service account can only access its own storage.
- **Retrieval plugins**: Every tenant pod runs a retrieval plugin that extends the agentic loop with organizational context. The plugin queries the Org Knowledge Index with RBAC filtering, ensuring tenants only see data they're permitted to access.
- **Operator-driven reconciliation**: Kubernetes CRDs (Tenant, AccessPolicy) are the source of truth. The operator watches for changes and idempotently reconciles: service accounts, secrets, deployments, ingress, network policies.
- **Shared organizational data**: A central Org Knowledge Index (PostgreSQL + optional vector DB) exposes departments, projects, team hierarchies, and company policies. Role-based access rules control visibility—each tenant can only retrieve information their role permits.
- **Shared skills library**: A ReadWriteMany PVC mounted read-only into all tenant pods and retrieval plugins enables org-wide and team-specific skill discovery. Skills are organized by scope: `/shared-skills/org/` and `/shared-skills/teams/{team}/`.
- **Credentials isolation**: Encrypted emptyDir (memory-backed) for pod-local secrets + K8s Secrets for encryption keys. Org-wide secrets via External Secrets Operator + cloud provider secret management (GCP Secret Manager, etc.).
- **Policy enforcement**: AccessPolicy CRDs define domain allowlists, network rules, and role-based access to shared resources, converted by the operator into Kubernetes NetworkPolicy and CiliumNetworkPolicy resources.
- **Company-wide information gathering agents**: System-level agents (authenticated with elevated permissions) harvest data from organizational channels (Slack, Teams, email, ticketing systems) and index it into the Org Knowledge Index for retrieval by tenant assistants.
- **Dual-write pattern**: Control plane writes tenant and policy state to both K8s CRDs (source of truth for reconciliation) and PostgreSQL (queryable audit store for dashboards and reporting).
- **Cost tracking**: Per-tenant LiteLLM virtual API keys route LLM requests through a cost metering layer. Token usage and budgets are persisted in Prisma for audit and enforcement.
- **IaC**: Terraform for static infrastructure (GKE, Cloud SQL, VPC). Crossplane for dynamic per-tenant resources (GCS buckets, IAM bindings, cloud SQL users).

### Storage Layout

```
Pod filesystem (ephemeral):
  /data/secrets/                     -- Encrypted emptyDir (pod-local secrets)
  /etc/openclaw/encryption-key/      -- K8s Secret projected as file

Per-tenant private drive (GCS, PVC, or local storage - IAM-scoped):
  /data/openclaw/
    ├── runtime/                     -- OpenClaw npm install (persists across restarts)
    ├── config/
    ├── agents/
    ├── sessions/
    ├── uploads/
    └── knowledge/                   -- Personal documents & context

Shared skills library (ReadOnly PVC):
  /shared-skills/
    ├── org/                         -- Org-wide skills
    └── teams/{team}/                -- Team-scoped skills (access controlled by Retrieval Plugin)

Org Knowledge Index (PostgreSQL + optional Vector DB):
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
