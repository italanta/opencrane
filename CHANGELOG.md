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

- **Expose the control plane ingress at the root domain instead of the `admin` subdomain.** The control plane ingress host maps directly to the base `ingress.domain` configured in Helm (e.g. `opencrane.local`), rather than prepending `admin.`.

### Security

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
