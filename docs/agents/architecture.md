# Platform Architecture & Identity

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.
>
> This file holds the platform's identity *philosophy*. The operational Kubernetes rules that
> implement it live in [`k8s.md`](./k8s.md); the Terraform/Helm split that defines it lives in
> [`infra.md`](./infra.md).

## Platform Topology

The non-obvious shape of the system (verified June 2026). Read this before touching tenancy, auth, or cross-service flow.

**Tenant model is a two-tier hierarchy:**

- `ClusterTenant` (cluster-scoped CRD, **optional** parent) — the first-class *customer* / isolation unit. Carries `isolationTier`, compute mode, and resource quota; binds a namespace (`status.boundNamespace`).
- `Tenant` (namespaced CRD, always exists) — **is** the OpenClaw agent-pod definition (one pod per Tenant). There is no separate "openclaw" CRD; "OpenClaw" is the pod runtime.
- A `Tenant` *without* `clusterTenantRef` deploys into the install namespace (single-install legacy mode). *With* a ref, the operator resolves the parent's bound namespace and applies its isolation policy.
- `isolationTier` ∈ `shared` (bin-packed nodes) · `dedicatedNodes` (tainted node pool) · `dedicatedCluster` (own kube-apiserver via external provisioner). Enum: `ClusterTenantIsolationTier` in `libs/contracts/src/cluster-tenant.types.ts`.

**Five planes** (each detailed in [`app-specific.md`](./app-specific.md)):

| Plane | Role | Talks to |
|-------|------|----------|
| **control-plane** | API-first management surface (`/api/v1`), OIDC broker, source of truth for Tenants/AccessPolicies/Grants/MCP/Skills. Dual-writes CRDs + Postgres. | everything |
| **operator** | Reconciles Tenant/ClusterTenant/AccessPolicy CRs → namespaces, pods, NetworkPolicies, buckets. | Kubernetes API |
| **Obot MCP gateway** | Config-slaved runtime gateway; **polls** control-plane `GET /api/internal/obot-registry`. Tenant pods reach MCP servers *through* Obot. | control-plane (poll), tenant pods |
| **skill-registry** | Entitlement-gated skill-bundle delivery; validates pod identity via TokenReview, proxies to control-plane. Non-entitled → **404** (existence-hiding). | control-plane, tenant pods |
| **harvesting-agent** | Background ingestion worker (Slack connector → Postgres `OrgDocument`). Not API-first. | external sources, Postgres |

**Identity is multi-credential** — five non-interchangeable types: (1) OIDC session cookie (human operators), (2) OpenClaw bootstrap token (short-lived, one-device pairing), (3) OpenClaw device token (gateway-issued), (4) **projected SA token** (audience-bound: `aud=obot-gateway|skill-registry|control-plane`, ~600s rotated, in-cluster only, never handed to a browser), (5) static `OPENCRANE_API_TOKEN` (automation fallback, explicit migration target). One human OIDC login brokers the pod pairing — `POST /api/v1/auth/pod-token` resolves tenant **solely from the verified session email** (fail-closed `409 AMBIGUOUS_TENANT`), never from request input.

**Two facts that catch agents out:**

- **`___AuthMiddleware` does NOT enforce per-route roles today** (`apps/control-plane/src/infra/middleware/auth.middleware.ts`). It's a fallback chain: public paths → OIDC cookie → env token → DB access token → dev bypass. Role/capability claims are a *planned* target — do not assume RBAC at the route layer.
- **State is dual-written: CRD is source of truth, Postgres is a projection.** Every Tenant/AccessPolicy mutation hits both. Drift between them is expected and has explicit tooling (`GET /tenants/drift`, `POST /tenants/repair`, projection-drift metrics). Don't "fix" a divergence by writing only one side.

**Effective contract:** each tenant's entitlements compile into one SHA256-keyed JSON blob (`GET /:name/effective-contract`) covering awareness datasets + MCP servers + skill bundles. Tenant pods re-pull it on a ~30s loop; on `contractId` change the pod gets a SIGHUP + a re-rendered config. This is the runtime authorization mechanism — changing a grant is not effective until the contract recompiles and the pod re-pulls.

## IAM-First

OpenCrane is IAM-first.

- Prefer federated identity, Workload Identity, OIDC, and cloud IAM over static bearer tokens.
- Treat bearer tokens as temporary compatibility shims or break-glass paths, not the default architecture.
- Every platform service and every tenant workload should have an explicit workload identity.
- Every human operator should authenticate through centrally managed identity, not shared long-lived tokens.

## Central Identity Model

Identity and authorization must be described centrally.

- Cloud IAM is the source of truth for cloud resource access.
- Kubernetes RBAC is the source of truth for Kubernetes API access.
- Terraform should define cloud identities, trust bindings, and IAM role attachments.
- Helm should define Kubernetes service accounts, RBAC bindings, and workload identity annotations.
- Application code should consume identity provided by the platform rather than inventing parallel auth schemes.

## Token Policy

- Do not introduce new bearer-token control paths when IAM or OIDC can solve the problem.
- Existing bearer-token paths should be treated as migration targets.
- If a bearer token is unavoidable, document why IAM cannot be used, constrain its scope, and define a removal path.

## OpenCrane-Specific Direction

- Tenant workloads should use per-tenant Workload Identity for cloud storage and other tenant-scoped cloud resources.
- Operator and control-plane services should move toward explicit workload identities instead of implicit cluster-only trust.
- Network reachability does not imply authorization; authorization should come from IAM and RBAC, not location on the cluster network.
