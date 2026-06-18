# Changelog

What OpenCrane can **do** after each release — written in functional terms: the
capabilities, features, and behaviour changes an operator, tenant, or integrator gains,
not a restatement of commits. Versions map to git tags; dates are tag dates. Format
follows [Keep a Changelog](https://keepachangelog.com/); the project uses
[semantic versioning](https://semver.org/).

> **Maintenance:** when a phase or track completes (or a tag is cut), the **`changelog`
> agent** (see `.claude/agents/changelog.md`, runs on Sonnet) appends a section here in
> the same work cycle. Entries describe *new/changed capability*, never raw commit
> history. No release lands without a changelog entry — see `AGENTS.md` → Planning Discipline.

## [Unreleased]

### Added

- **Register any AI model from any provider and make it routable across the platform.** Operators
  register models (`oc model add|list|update|remove`) and bind provider credentials that store only
  a Kubernetes Secret reference — a raw API key is never written to the database or transmitted over
  the wire. Both models and credentials are scoped Global or per-ClusterTenant; the backing
  LiteLLM instance is updated automatically (`/api/v1/models`, `/api/v1/providers/credentials`).
- **Pin a model to a skill, or let the platform choose automatically.** Each skill can declare a
  pinned model or opt into `auto` mode (`oc skill-posture`). Scope-level defaults (global or
  per-ClusterTenant) are set with `oc model-default`. At runtime the control plane resolves a single
  effective model per skill following the precedence: explicit request override → skill-pinned →
  skill-`auto` → ClusterTenant default → Global default — and writes it into the tenant's
  effective-contract without a pod restart.
- **Confine each tenant to only the models they are allowed to call.** The LiteLLM virtual key's
  `models[]` allowlist is now populated from the registry at key-mint time and kept in sync by the
  operator's reconcile loop (`oc routing …`). A tenant cannot call a model that is not in their
  allowlist, closing the previous gap where any tenant could call any registered model.
- **Measure what smarter routing would save before committing to any change.** Operators record
  golden eval cases (`oc routing eval-case`) and trigger a shadow-mode measurement run
  (`oc routing measurement run`) that replays each case against a candidate model, scores it with a
  vendor-neutral judge, and computes bootstrap 95% confidence intervals. A `RoutingProposal` is
  emitted only when the CI excludes zero savings. The measurement runner and judge are live seams
  (requiring a deployed LiteLLM + provider keys + `ROUTING_JUDGE_MODEL`; ops recipe in
  `docs/operators/routing-measurement.md`) — the first live savings number is an operator step on
  a real cluster, not a synthetic estimate.
- **Approve or reject routing proposals with a full audit trail; nothing is ever auto-applied.**
  Each `RoutingProposal` surfaces via `oc routing proposal list|approve|reject`. Approving pins the
  skill to the proposed model (via the AIR.3 write path) and records the decision; rejecting leaves
  routing exactly as-is. A RouteLLM/bandit policy learner and staged canary traffic rollout are
  future additions — the proposal lifecycle is the gate, and that gate is human-only today.
- **Read AI cost and quality metrics from the console without the browser holding Langfuse
  credentials.** `GET /api/v1/model-routing/metrics` (`oc routing metrics`) proxies Langfuse's
  public metrics API with server-side authentication; non-operators receive an automatic
  tenant-dimension filter; the endpoint returns 503 when Langfuse is not configured and fails
  closed with 403 when a caller's ClusterTenant cannot be resolved.
- **Surface a ranked "save up to N%" feed that drives one-click human-gated improvement.**
  `GET /api/v1/model-routing/recommendations` (`oc routing recommendation list`) joins each
  skill's latest measurement with any open proposal, sorts by projected savings descending, and
  scopes results by ClusterTenant — operators see the full fleet; non-operators see only their own.
  This is the feed behind the console's savings-recommendation tile.

- **Model each customer as a first-class, API-managed isolation unit.** Operators create
  and manage customers with `oc cluster-tenant create|list|show|update|delete` (or
  `/api/v1/cluster-tenants`), choosing an `isolationTier` — `shared`, `dedicatedNodes`, or
  `dedicatedCluster` — per customer. The resource is cluster-scoped, carries its own status
  lifecycle (`pending → provisioning → ready`), and enforces a hard invariant: one customer
  = one `ClusterTenant` = one instance. Openclaws attach to a customer by setting
  `spec.clusterTenantRef`; single-install stays the zero-config default and is
  byte-for-byte unchanged — multi-tenancy is strictly opt-in.
- **Gate and dedicate compute per customer natively, without an admission webhook.** When a
  customer is opted in, the operator provisions a per-`ClusterTenant` namespace labelled
  with PSA `restricted`, derives a `ResourceQuota` and `LimitRange` from the customer's
  declared quota (`cpu`/`memory`/`pods`/`storage`/`gpu`), and stamps `nodeSelector` +
  `tolerations` from `spec.compute` onto each openclaw pod spec. The operator is the sole
  pod-creator so the enforcement is structural — one customer cannot starve or interfere
  with another's resources, and `dedicatedNodes` pins the customer to its own node pool
  without any additional admission machinery.
- **Plug in a `dedicatedCluster` backend without forking or touching the AGPL tree.** The
  control plane delegates to an out-of-process provisioner over an HTTPS webhook, posting a
  vendor-neutral `ClusterTenantProvisionRequest` (published in the MIT `libs/contracts`)
  and reading back a status plus a kubeconfig Secret reference — credential material never
  crosses the wire inline. A private vendor implements the contract in their own service;
  nothing vendor-specific lives in the AGPL core. Configure via Helm
  (`clusterTenant.provisionerWebhook.url`); `dedicatedCluster` is rejected `422
  TIER_UNAVAILABLE` until a backend advertises it (fail-closed).

### Changed

- **GKE secret encryption is on by default for all new cluster deployments.** The Terraform GKE
  module now provisions a dedicated KMS keyring and crypto key (90-day auto-rotation,
  `prevent_destroy`) and enables GKE application-layer `database_encryption` pointing at that key.
  Existing clusters are unaffected; enable via `enable_secrets_encryption=true` in Terraform.
- **LiteLLM is pinned to a stable image tag.** The Helm deployment now references
  `main-v1.81.0-stable` instead of `:main-latest`, so cluster upgrades are deliberate and
  reproducible.

- **Expose the control plane ingress at the root domain instead of the `admin` subdomain.** The control plane ingress host maps directly to the base `ingress.domain` configured in Helm (e.g. `opencrane.local`), rather than prepending `admin.`.

### Security

- **Credential and model mutation routes fail closed outside dev mode.** The
  `cluster-tenant-scope` middleware guards every POST/PUT/DELETE on model, credential, and
  skill-posture routes: platform operators may act at any scope; non-operators are restricted to
  their own ClusterTenant; Global mutations are operator-only; denials return `403
  FORBIDDEN_SCOPE`. Critically, when no session is present the guard now **fails closed** unless
  `_IsDevAuthMode()` is true — a sessionless request to a mutation route is denied on any real
  deployment. The open dev backend remains permissive; production is enforced.
- **Provider credentials never store a raw key.** The `/api/v1/providers/credentials` endpoint
  rejects any payload containing a raw key material field with a `400`; only a `secretRef` (a
  Kubernetes Secret name) is accepted and stored. This applies at both Global and
  per-ClusterTenant scope.

- **The provisioner webhook refuses a non-`https://` URL at startup**, so the bearer token
  used to authenticate to a vendor's dedicated-cluster backend is never sent in plaintext
  under any configuration.

## [0.3.0] — 2026-06-15

Multi-customer isolation, fleet-wide organizational awareness, and hardened connection security.

### Added
- **Run many isolated customers on one cluster.** Operators can stand up N fully-isolated
  OpenCrane instances in a single Kubernetes cluster (opt-in; single-install stays the
  default). Each customer gets its own namespace, scoped RBAC, cert issuer/secret store, and
  a cross-instance default-deny network boundary — one customer cannot see, reach, or
  reconcile another's resources, and tearing one down leaves the others untouched. CRDs are
  installed once cluster-wide so instances upgrade independently against a published
  version-compatibility matrix.
- **Every agent answers from one governed org-knowledge contract.** Tenants' OpenClaw agents
  retrieve org context directly from their Cognee with **mandatory citations** (uncitable
  results are dropped, never shown unattributed). Access-policy changes now propagate to
  retrieval grants automatically.
- **Ship awareness changes safely across the fleet.** The awareness contract is versioned and
  rolls out **canary-style** (personal → project → department → org) with **one-step
  rollback** and optional shadow mode; a **golden-query suite gates rollouts** on zero policy
  violations. Operators monitor fleet awareness SLOs (dashboards + alerts) and per-tenant
  participation, all drivable from `oc awareness …`.
- **Personalize agents per company without losing platform control.** Companies publish their
  own **immutable, versioned** voice/policy docs that reconcile into each tenant's agent via
  an **approve-before-apply 3-way merge**, applied **live without a pod restart**. Platform-
  owned behaviour is re-stamped every boot and can never be overridden by a tenant or company doc.
- **Distribute skills as signed OCI artifacts.** Skills are stored and delivered as OCI/Zot
  blobs (digest-pinned) instead of database rows, with an `oc` backfill path. The skill
  registry serves get-by-digest only, enforces per-read entitlement, and hides the existence
  of skills a tenant isn't entitled to.

### Security
- **No long-lived agent credential in the browser.** Operator→pod connections are brokered
  through the control plane with short-lived, re-brokered credentials, enforced `wss://`,
  HSTS, and production-forced `Secure` cookies — plus a **per-user kill-switch** that severs
  live sessions and blocks re-auth.
- **Proprietary frontends can integrate cleanly.** The contracts SDK is MIT-licensed (the core
  stays AGPL), so external/closed clients can consume the API at arm's length; `openapi.json`
  is published as a release asset.

## [0.2.0] — 2026-06-11

First tagged release — a working multi-tenant OpenClaw platform you can deploy and operate end-to-end.

### Added
- **Stand up a multi-tenant OpenClaw platform.** Deploy operator + control-plane + per-tenant
  OpenClaw pods via Helm, with end-to-end tenant reconciliation (validated on k3d and GCP) and
  OIDC login for human operators.
- **Control AI spend per tenant.** LiteLLM-based cost routing with per-tenant AI budget, spend,
  and key management under a single API, plus production guards against placeholder secrets.
- **Give agents org-aware retrieval.** Cognee-backed retrieval with enforced per-tenant
  datasets and an organization index schema carrying lineage, freshness, confidentiality, and
  jurisdiction metadata.
- **Govern identity, MCP servers, and skills.** Groups/grants with a 5-level scope compiler;
  MCP server and skill-catalog management; projected-token tenant identity; a security ingest
  scanning gate; and operator drift-repair of runtime-plane config.
- **Operate headlessly, API-first.** Everything runs through a versioned `/api/v1` with coded
  error envelopes + OpenAPI and the `oc` CLI — no UI dependency. Cloud-agnostic hosting via the
  GoF adapter (GCP + on-prem), replacing Crossplane.

## [0.1.0] — 2026-03-15 _(untagged)_

- Initial scaffold of the multi-tenant OpenClaw platform (operator, control-plane, Angular app,
  launch script). Folded into the 0.2.0 tag.

[Unreleased]: https://github.com/italanta/opencrane/compare/0.3.0...HEAD
[0.3.0]: https://github.com/italanta/opencrane/releases/tag/0.3.0
[0.2.0]: https://github.com/italanta/opencrane/releases/tag/0.2.0
