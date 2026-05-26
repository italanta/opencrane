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
- **Accesses organizational knowledge directly**: Queries Cognee from the OpenClaw/Clawdbot runtime during the agentic loop, with policy-compatible dataset scope selection and citations.

OpenCrane also runs **company-wide information gathering agents** (dedicated tenant deployments with elevated permissions) that:
- Continuously harvest organizational knowledge from Slack, Teams, email, ticketing systems, and other company platforms
- Index this knowledge into a centralized Org Knowledge Index
- Make it available to all tenant assistants via retrieval plugins (role-based access)

OpenCrane orchestrates all of this by:
- **Infrastructure Management**: Deploying and managing assistants for each employee. Supporting local or remote LLM models. Enforcing token budgets and cost limits per employee.
- **Permissions Control Plane**: Managing dataset memberships and permissions in Cognee (for org/team/project/personal scopes) without sitting in the retrieval request path.
- **Uniform Awareness Runtime**: Enforcing a common awareness contract across tenant runtimes (query rewrite rules, scope selection, citations, fallback, freshness behavior).
- **Organizational Knowledge**: Company-wide agents harvest and index org data; direct tenant retrieval runtimes make it accessible based on role and dataset scope.
- **Scalable architecture**: The same multi-tenant, Kubernetes-native design works from 10 to 10,000 employees.
- **Skill sharing**: Managing skill updates and deployments across the organization.
- **Secure storage**: All data stored in your organization's infrastructure, encrypted at rest.

See [**Current State** and **Roadmap**](#current-state-phase-1) below for implementation details and future capabilities.

## Architecture

OpenCrane is represented here as a clean operating model: a central **Control Plane** backed by **Cloud SQL + Skills Repo**, a **Cognee Brain** for retrieval orchestration, isolated **OpenClaw tenant pods**, and explicit in-cluster platform planes for operator control, harvesting, MCP servers, and egress guardrails.

```
┌──────────────────────────┐      ┌──────────────────────────────┐
│      Control Plane       │◄────►│  Cloud SQL + Skills Repo     │
│   admin.opencrane.ai     │      │  org / users / teams /       │
│   Express + Prisma       │      │  projects / state            │
└─────────────┬────────────┘      └──────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Kubernetes Cluster (OpenCrane)                                          │
│                                                                                                           │
│ Local infrastructure                      Tenant Runtime Pillar                      Egress Pillar        │
│                                                                                                           │
│ ┌────────────────────────────┐         ┌────────────────────────────┐            ┌──────────────────────┐ │
│ │ Operator Control           │         │         jente.oc           │            │ Egress Control Plane │ │
│ │ - tenant/policy reconcile  │         │         OpenClaw           │            │ - outbound policy    │ │
│ │ - rollout coordination     │         │        (isolated)          │            │ - proxy / allowlists │ │
│ └────────────────────────────┘         ├────────────┬───────────────┤            │ - secrets brokerage  │ │
│                                        │    GCS     │      IAM      │            │ - AI token access    │ │
│ ┌────────────────────────────┐         │   bucket   │ + SecretVault │            │ - audit / rate limit │ │
│ │ Cognee Brain               │         └────────────────────────────┘            │ - external access ctl│ │
│ │ - retrieval orchestration  │                                                   │ - MCP egress policy  │ │
│ │ - endpoint authorization   │         ┌────────────────────────────┐            │ - external endpoint  │ │
│ │ - policy-aware memory      │         │         jane.oc            │            │ - DLP / exfil checks │ │
│ └────────────────────────────┘         │         OpenClaw           │            │ - identity attestatio│ │
│                                        │        (isolated)          │            └──────────────────────┘ │
│ ┌────────────────────────────┐         ├────────────┬───────────────┤                                     │
│ │ MCP Server Plane           │         │    GCS     │      IAM      │                                     │
│ │ - tenant/org MCP servers   │         │   bucket   │ + SecretVault │                                     │
│ │ - policy-checked tool API  │         └────────────────────────────┘                                     │
│ │ - protocol participation   │                                                                            │
│ └────────────────────────────┘         ┌────────────────────────────┐                                     │
│                                        │         niels.oc           │                                     │
│ ┌────────────────────────────┐         │         OpenClaw           │                                     │
│ │ Harvesting Agents          │         │        (isolated)          │                                     │
│ │ - Slack/Teams connectors   │         ├────────────┬───────────────┤                                     │
│ │ - ingest + normalize docs  │         │    GCS     │      IAM      │                                     │
│ │ - publish to Cognee        │         │   bucket   │ + SecretVault │                                     │
│ └────────────────────────────┘         └────────────────────────────┘                                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

In this view, the left control pillar is split into separate Operator Control, Cognee Brain, MCP Server Plane, and Harvesting Agents blocks, while Egress Control enforces outbound and model-access guardrails.

### Direct Retrieval Runtime: Extending Tenant Context

Each tenant pod runs a **retrieval runtime** that bridges the isolated assistant with organizational knowledge during the agentic loop. In Phase 4, retrieval is direct from OpenClaw/Clawdbot to Cognee; the control-plane remains responsible for permissions and policy distribution only. This runtime:

1. **Receives queries** from the OpenClaw agent as it needs context
2. **Queries Cognee directly** for relevant departments, projects, teammates, and policy context
3. **Applies uniform awareness contract behavior** for scope selection, citations, fallback, and freshness handling
4. **Respects permission grants** produced by control-plane dataset membership sync
5. **Can push knowledge back** — skills developed locally can be promoted to shared libraries after review

```
During Agentic Loop:
┌─────────────────────────────────────┐
│  OpenClaw Assistant Reasoning       │
│  "Who is on the engineering team?"  │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  Retrieval Runtime                  │
│  (runs within tenant pod)           │
│  1. Resolve awareness contract      │
│     version and active scopes       │
│  2. Query Cognee directly           │
│  3. Return: Members, projects,      │
│     shared skills + citations       │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Cognee Knowledge Plane                           │
│  Enforces dataset memberships synced by control   │
│  plane and returns scope-filtered results         │
└──────────────────────────────────────────────────┘
```

### Phase 4 Architecture Direction

- **Direct retrieval path**: OpenClaw/Clawdbot calls Cognee directly for knowledge retrieval.
- **Control-plane authority boundary**: Control-plane sets and syncs permissions/dataset memberships only; no retrieval proxy.
- **Uniform Awareness Contract**: Fleet-wide hybrid model using:
  - declarative contract schema as source of truth,
  - shared OpenClaw SDK as execution engine,
  - control-plane served effective-contract endpoint per scope.
- **Rollout safety**: SemVer contract compatibility, tenant-cohort canaries, optional shadow mode, and contract-ID rollback.
- **Skills sharing protocol**: Explicit promotion/demotion flow across personal, project, department, and org scopes with immutable digest-pinned versions.
- **Legacy removal target**: Filesystem-only sharing path is removed after protocol cutover.

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
- ✅ **Direct retrieval cutover**: Retrieval path is direct from OpenClaw/Clawdbot to Cognee
- ✅ **Permission sync boundary**: Control-plane manages Cognee dataset memberships and grants (no retrieval proxy)

**Retrieval plugin foundation (basic):**
- ✅ Static skill discovery from filesystem during agentic loop
- ✅ Skill metadata indexed in PostgreSQL for discovery
- ⏳ **In progress**: Uniform awareness contract SDK + control-plane effective-contract delivery
- ⏳ **In progress**: Skill-sharing protocol runtime and OCI-backed bundle distribution

### Roadmap (Plan-Aligned)

**Phase 2 (Cost Control + Retrieval Foundation, largely completed):**
- ✅ LiteLLM is integrated in-cluster through the root chart, with operator-managed tenant virtual keys and spend/budget APIs.
- ✅ Retrieval authorization model is locked: retrieval is direct OpenClaw/Clawdbot -> Cognee, and control-plane handles dataset permission mapping only.
- ✅ Harvesting-agent MVP foundation is in place with connector and metrics scaffolding.
- ✅ AccessPolicy outcomes are translated to Cognee dataset memberships.
- ✅ Projection-drift detection, repair routes, and threshold-based alerting are implemented.
- ⏳ Remaining hardening: explicit control-plane-managed env update propagation path into tenant runtime.

**Phase 3 (Self-Service Provisioning + Memory Cutover, completed with deferred items tracked):**
- ✅ Portal flow shipped in the existing Angular control-plane-ui: self-provisioning, tenant dashboard, tenant detail, and dataset membership UI.
- ✅ Memory path cut over from PostgreSQL-only retrieval to Cognee write-through with direct runtime retrieval.
- ✅ AccessPolicy-compatible dataset permission sync to Cognee is active.
- ⏸️ Explicitly deferred: approval workflow expansion, optional approval 2FA, OIDC migration, and freshness/invalidation implementation details controlled from Clawdbot.

**Phase 4 (Fleet Organizational Awareness, current focus):**
- 🎯 Uniform Awareness Contract across all OpenClaws using a hybrid model:
  - declarative contract schema,
  - shared OpenClaw SDK execution layer,
  - control-plane effective-contract delivery endpoint by scope.
- 🎯 Safe fleet rollouts via SemVer compatibility, canary cohorts, optional shadow-mode validation, and contract-ID rollback.
- 🎯 Org knowledge fabric standardization with schema v2 and connector conformance checks.
- 🎯 Awareness policy compiler to translate AccessPolicy + dataset membership into Cognee grants and runtime hints.
- 🎯 Fleet evaluation harness and awareness SLO dashboards (policy safety, freshness, citation coverage, latency).
- 🎯 Skills sharing protocol runtime with control-plane monitoring for participation health and version drift.
- 🎯 Hierarchical skill registry (org/department/project/personal) with immutable OCI digest-pinned bundles.
- 🎯 Legacy filesystem-only skill sharing removed after protocol cutover, with optional pull-through cache retained for startup resilience.

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

### Local Deployment

```bash
# Default local stack: operator + control-plane + LiteLLM + in-cluster PostgreSQL
./platform/install.sh local

# Strict local stack: same core workloads, but with prod-style Helm validation
# and an explicit LiteLLM master-key Secret matching the GCP control flow.
./platform/install.sh local --profile strict
```

The `strict` profile does not emulate GCP-only capabilities such as Workload Identity, GCS/Crossplane bucket provisioning, External Secrets, GCE ingress, or Cloud DNS. It is intended to validate the same core application wiring and stricter production-style chart inputs locally.

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
