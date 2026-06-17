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

See [`CHANGELOG.md`](CHANGELOG.md) for the capabilities shipped so far and [`plan-done.md`](plan-done.md) for the history behind them.

## Architecture

OpenCrane is **Kubernetes-native** and **API-first**. At its center is a headless
**control plane** — a versioned REST API plus the `oc` CLI. From there, the platform:

- runs **one isolated OpenClaw pod per employee**, each with its own encrypted storage;
- configures the shared in-cluster planes those assistants draw on — **skills**,
  **tools (MCP)**, and **organizational knowledge**;
- compiles your access policies into per-assistant grants; and
- runs an **operator** that keeps every assistant and plane reconciled.

An employee signs in once to reach their assistant, and assistants reach the shared
planes only with short-lived, scoped credentials. Conversations stay inside the pod —
OpenCrane governs access, budgets, and networking, but never inspects them.

📐 See the illustrated **[architecture overview](https://opencrane.ai/advanced/architecture)** — diagrams of the control plane, the sign-in flow, and the deny-by-default access model.

```
┌──────────────────────────────────────────────────┐      ┌──────────────────────────────┐
│                  Control Plane                   │◄────►│  Cloud SQL + Skills Repo     │
│                admin.opencrane.ai                │      │  org / dept / team /         │
│     Express + Prisma + absorbed Obot admin UI    │      │  tenant / individual / state │
│  • MCP install + in-cluster registry (desired)   │      └──────────────────────────────┘
│  • Obot control & config authority               │
│  • Control-plane UI manages Obot + skills        │
│  • Permission compiler · effective-contract API  │
└──────────────────────┬───────────────────────────┘
                       │  (0) config   (1) grants   (2) contract
                       ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Kubernetes Cluster (OpenCrane)                                  │
│                                                                                                │
│  Platform / Control            Tenant Runtime Pillar               MCP & Egress Plane          │
│                                                                                                │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌──────────────────────────────┐  │
│  │ Operator Control       │    │       jente.oc         │    │ Obot MCP Gateway            ▒▒▒▒▒▒ NETWORKPOLICY TO WEB
│  │ - tenant/policy        │    │       OpenClaw         │    │ (headless · config-slaved)   │  │
│  │   reconcile            │    │      (isolated)        │    │ - native admin disabled      │  │
│  │ - projected-token +    │    ├───────────┬────────────┤    │ - validate projected JWT     │  │
│  │   contract injection   │    │ Personal  │    IAM     │    │ - per-call scope check       │  │
│  │ - reconciles Obot      │    │   Drive   │ + Workload │    │ - credential broker/shim     │  │
│  │   config + registry    │    │           │  Identity  │    ├──────────────────────────────┤  │
│  │ - drift detect/repair  │    │           |            |    │ In-cluster MCP servers       │  │
│  └────────────────────────┘    │           |            |    │ (registry-pulled, run        │  │
│                                └──────┬────┬────────────┘    │  locally)                    │  │
│  ┌────────────────────────┐           |    │  (3) JWT        ├──────────────────────────────┤  │
│  │ Cognee Brain           │◄──────┬────────┴────────────────►│ Obot token store             │  │
│  │ - retrieval / memory   │       |   |                      │ - per-user downstream creds  │  │
│  └──────────▲─────────────┘       |   |                      │ - encrypted; pod-unreachable │  │
│             │                     |   |                      └──────────────────────────────┘  │
│  ┌──────────┴─────┬───────────┐   |   |                                                        │
│  │ Skill Registry │Skills     │   |   |                      ┌──────────────────────────────┐  │
│  │ & Delivery     │ Access    │◄──┘   └ ─(jente.oc)─ ─ ─ ───►│ Egress Control Plane         ▒▒▒▒▒▒
│  │ - OCI/ORAS     │ Permission│                              │ - allowlists / DLP / audit   │  │
│  │ - scan/ingest  │ Gate      │                              │ - network egress authority   │  │
│  └────────────────┴───────────┘                              └──────────────────────────────┘  │
│                                ┌────────────────────────┐                                      │
│                                │  jane.oc (isolated)    │    ┌──────────────────────────────┐  │
│                                └────────────────────────┘    │ Harvesting Agents            ▒▒▒▒▒▒
│                                ┌────────────────────────┐    │ - ingest -> Cognee           │  │
│                                │  niels.oc (isolated)   │    └──────────────────────────────┘  │
│                                └────────────────────────┘                                      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘

Legend
(0) config — control plane owns Obot's registry, IdP/gateway/auth, lifecycle; operator reconciles + drift-repairs.
(1) grants — per-tenant compiled scope, pushed live; revocation effective next call.
(2) contract — versioned effective-contract the pod re-pulls at loop boundaries.
(3) JWT — short-lived, audience-bound projected SA token; shim injects downstream creds server-side, never to the pod.
```

## Components

| Component | Path | Description |
|-----------|------|-------------|
| Helm chart | `platform/helm/` | K8s manifests, CRDs, operator + control plane deployments |
| Operator | `apps/operator/` | Watches Tenant/AccessPolicy CRDs, reconciles per-tenant resources via `HostingAdapter` |
| Control Plane | `apps/control-plane/` | Headless Express REST API (`/api/v1`) with Prisma ORM; emits `openapi.json` at build time |
| CLI | `apps/cli/` | `oc` binary — full administrative surface over the control-plane API |
| Contracts | `libs/contracts/` | Generated TypeScript client + DTOs from `openapi.json`; consumed by CLI and external surfaces |
| Docker | `docker/` | Container images for tenant pods, operator, and control plane |
| Skills | `skills/shared/` | Org/team shared skill library |
| Terraform | `terraform/` | `core/` (cloud-agnostic) + `cloud/gcp/` (GCP-specific) |
| Docs site | `website/` | VitePress documentation site published to GitHub Pages |

## Documentation

📖 **Full documentation site: [opencrane.ai](https://opencrane.ai)** —
getting started, concepts, operator & integrator guides, and an interactive API
reference. The site is built with [VitePress](https://vitepress.dev) from
[`website/`](website/). Contributor/agent coding guidance stays in
[`AGENTS.md`](AGENTS.md) and [`docs/agents/`](docs/agents/).

| Doc | Covers |
|-----|--------|
| [Identity & connection auth](https://opencrane.ai/security/identity) | How people sign in and how a browser connects to its assistant |
| [Connection security model](https://opencrane.ai/security/connection-security) | How OpenCrane keeps the browser↔assistant connection secure |
| [Hosting architecture](https://opencrane.ai/operators/hosting) | On-prem-default hosting adapters, the cloud seam, and cert-manager TLS issuance |
| [MCP gateway (Obot)](https://opencrane.ai/integrators/mcp-gateway) | Connecting assistants to external tools over MCP |
| [Skill registry & delivery](https://opencrane.ai/integrators/skill-registry) | Skill catalog, scan/entitle pipeline, and per-read delivery |
| [Retrieval & memory](https://opencrane.ai/integrators/retrieval-memory) | Cognee retrieval plane: datasets, AccessPolicy mapping, freshness |
| [API overview](https://opencrane.ai/reference/api-overview) · [CLI reference](https://opencrane.ai/reference/cli) · [Runbook](https://opencrane.ai/operators/runbook) | HTTP API reference · `oc` CLI reference · operational runbook |

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

The `strict` profile does not emulate GCP-only capabilities such as Workload Identity, GCS bucket provisioning, External Secrets, GCE ingress, or Cloud DNS. It is intended to validate the same core application wiring and stricter production-style chart inputs locally.

### GCP Deployment

```bash
# 1. Provision infrastructure
cd terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars  # edit with your GCP project
terraform init && terraform apply

# 2. Install the platform
helm install opencrane platform/helm \
  -f platform/helm/values/gcp.yaml \
  --set hosting.gcp.projectId=my-project \
  --set ingress.domain=opencrane.ai \
  --set controlPlane.database.existingSecret=opencrane-cloudsql

# 3. Create a tenant via the oc CLI
export OPENCRANE_URL=https://opencrane.ai
export OPENCRANE_TOKEN=<your-access-token>

oc tenants create \
  --name jente \
  --display-name "Jente" \
  --email jente@example.com

# Or via CRD directly
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

The operator provisions everything the tenant needs — storage, identity, an encryption key, and its own ingress. With `ingress.domain=opencrane.ai`, the `jente` assistant is reachable at `https://jente.opencrane.ai`. See [Set up your domain](https://opencrane.ai/guide/dns) for DNS and TLS.

### CLI Quick Reference

```bash
# Point the CLI at your control plane
export OPENCRANE_URL=https://opencrane.ai
export OPENCRANE_TOKEN=<your-access-token>

oc tenants list                         # list all tenants
oc tenants get jente                    # inspect a tenant
oc tenants suspend jente                # scale to zero
oc tenants resume jente                 # bring back

oc policies list                        # list access policies
oc mcp list                             # list MCP servers
oc skills list                          # list skill catalog
oc budget spend jente                   # current spend for a tenant

oc audit list --tenant jente --limit 50 # query the audit log
oc metrics server                       # server utilisation snapshot
oc auth me                              # current auth identity

oc tenants list --output json | jq '.[].name'   # machine-readable output
```

See the [CLI reference](https://opencrane.ai/reference/cli) for the full command reference and the [API reference](https://opencrane.ai/reference/api) for the HTTP API.

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
