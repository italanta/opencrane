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

- **Identity-routing gateway proxy: serve a whole org's users from one host, with auth and
  anti-CSWSH controls.** A new `gateway-proxy` service (off by default; enable with
  `gatewayProxy.enabled` once an org is cut over) lets every user in an org reach their own
  OpenClaw gateway through the org's **single host** instead of a per-user subdomain. On each
  gateway WebSocket upgrade the proxy (1) checks the browser `Origin` against an exact allowlist
  and refuses anything else — the only server-side defence against Cross-Site WebSocket Hijacking,
  which CORS does not cover, and it fails closed (empty allowlist refuses all); (2) asks the
  control plane *who* the socket belongs to and *where* it goes via the new
  `GET /api/v1/auth/gateway-resolve` endpoint, which resolves the target from the IdP-verified
  email with the same fail-closed rule as `/pod-token` (no/ambiguous tenant → 403); (3) rate-limits
  per identity; then (4) forwards to that user's pod. The proxy holds no session state or secrets —
  the control plane stays the sole auth authority. Combined with per-pod owner pinning (CONN.10),
  cross-tenant safety now has two independent layers (routing + pod), either of which is sufficient.

### Changed

- **Deleting an organisation now tears down its per-org domain.** When a ClusterTenant is deleted
  the operator deprovisions the org's wildcard TLS `Certificate` and external-dns `DNSEndpoint`, so
  external-dns reaps the org's DNS records instead of leaving them dangling on namespace
  garbage-collection ordering. Idempotent and fail-soft — a teardown error is logged, never wedges
  the operator, with namespace GC as the backstop.

- **Cluster-tenant provisioner registry slimmed to a pure tier-availability gate.** Now the operator
  owns all org provisioning, the control plane's dead provisioner lifecycle code (the
  `provision`/`getStatus`/`deprovision` paths of the shared and external-webhook provisioners) was
  removed. The management API still gates which isolation tiers it accepts — `dedicatedCluster`
  remains unavailable unless an external webhook backend is configured over HTTPS — with no change to
  externally observable behaviour.

- **Seed the first platform operator of a fresh cluster by email — no IdP group mapping
  required yet.** Set the per-cluster install parameter
  `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL` (the install wizard prompts for it; or
  `./platform/k8s-deploy.sh --platform-operator-seed-email …`, or the Helm value
  `controlPlane.oidc.platformOperatorSeedEmail`) and the person who signs in with that
  **verified** email is treated as a platform operator. This is additive to the existing
  group-based check (seed *or* group grants operator) and is meant as a bootstrap: once a
  group mapping exists in the IdP, remove the seed. It is fail-closed — an empty/unset
  seed grants operator to nobody, and an email the IdP marks unverified never matches.

- **Any signed-in user can create an organisation and instantly becomes its root admin.**
  A user first creates a billing account (`POST /api/v1/billing-accounts`), then creating a
  ClusterTenant (`POST /api/v1/cluster-tenants`) records them as the org's single `owner` in the
  same transaction — so an organisation always has exactly one root admin. `isOrgAdmin` and the
  caller's owned/administered orgs are now derived from real per-org `OrgMembership` (not a global
  flag) and surface on `/auth/me` as `ownedOrgs`. The cluster-tenants API is no longer unguarded:
  creating requires an authenticated session **with** a billing account (not pre-existing admin — a
  user becomes admin *by* creating); reading and destructive operations require a platform operator
  or an owner/admin member of that specific org. Anonymous callers are rejected (401) in any real
  deployment.

- **One fixed platform domain serves every org and user — no customer DNS delegation required.** The
  platform now owns a single wildcard base (`ingress.domain`, e.g. `weownai.eu`) and a fixed
  super-operator/control-plane host (`ingress.controlPlaneHost`, default `platform.<base>`). Each
  organisation is automatically reachable at `<org>.<base>` (e.g. `acme.weownai.eu`) and each user at
  `<user>.<org>.<base>` (e.g. `mike.acme.weownai.eu`) — derived names, created with zero per-name DNS
  work once the org's wildcard exists. A customer who wants their own brand adds a single `CNAME` from
  their domain onto `<org>.<base>` and sets the org's `vanityDomain` (`oc cluster-tenant update <org>
  --vanity-domain …`); OpenCrane adds it to the org's TLS so it is browser-trusted, while the canonical
  `<org>.<base>` keeps working.
- **TLS now covers the full two-level hierarchy.** The chart issues the platform wildcard certificate
  (`*.<base>` + apex + control-plane host) at install, and each org gets its own `*.<org>.<base>`
  certificate at provision time (cert-manager DNS-01) — because a single wildcard cannot reach the
  per-user `<user>.<org>.<base>` level. New users under an existing org get HTTPS automatically.
- **Per-org domain serving + TLS is now actually provisioned, not just specified.** OpenCrane carries a
  working `OrgDomainProvisioner` that, for a given org, applies the per-org wildcard `Certificate`
  (`*.<org>.<base>` + the org apex, plus any vanity domain) through cert-manager and declares the
  matching `*.<org>.<base>` / `<org>.<base>` A records (pointing at the cluster ingress IP) as a
  namespaced external-dns `DNSEndpoint` custom resource (`externaldns.k8s.io/v1alpha1`) in the org's
  bound namespace — so every user under the org both resolves and is browser-trusted with no per-user
  setup. The operator talks to no cloud DNS API and carries no cloud SDK: the cluster's external-dns
  controller reconciles the declared records into whatever DNS provider the platform runs (Cloud DNS,
  Route53, Cloudflare, RFC2136, …). It is idempotent and fail-closed: on a cluster without cert-manager
  it records the cert step as skipped with a clear reason and lets the org still reach ready — the
  namespace boundary, not the cert, gates attachment — instead of failing the reconcile; likewise an
  absent `DNSEndpoint` CRD (external-dns not installed) makes the DNS step report skipped rather than
  crash, and the A-record step runs only when an ingress IP target is set. This runs only from the
  operator's org reconciler — creating an org over the API never touches DNS or cert-manager directly.

### Changed

- **A ClusterTenant's `baseDomain` is replaced by `vanityDomain`.** Under the fixed-wildcard topology an
  org no longer brings its own base domain (its serving domain is derived as `<org>.<base>`); the field is
  repurposed as an OPTIONAL customer-vanity domain CNAMEd onto that apex. The API, `oc cluster-tenant`
  CLI (`--vanity-domain`), and the ClusterTenant CRD use the new name; existing values are carried over by
  the migration as vanity overlays.
- **Tenant gateways now refuse to trust an unconfigured proxy instead of trusting everything.** The
  trusted-proxy allowlist that decides which source the OpenClaw gateway will believe the
  `X-Forwarded-User` identity header from is now fail-closed: an operator with no
  `tenant.gateway.trustedProxies` configured renders a **trust-nothing** gateway — no connection
  authenticates — rather than an ambiguous empty list a runtime might read as trust-all. A typo'd
  CIDR/IP now crashes the operator at startup with the offending entry named, so a misconfiguration
  can never silently widen or narrow the trust boundary. The allowlist is Helm-values-driven
  (`tenant.gateway.trustedProxies`); the dev GKE overlay ships the cluster's ingress-nginx pod source
  range as its default so trusted-proxy auth works out of the box there.
- **Each tenant gateway is pinned to its owner (cross-tenant guard).** trusted-proxy auth trusts whatever
  identity the proxy injects, so the operator now renders `gateway.auth.trustedProxy.allowUsers` with the
  tenant owner's verified email — the gateway rejects any other `X-Forwarded-User`, so reaching another
  tenant's pod no longer grants access to its mounted secrets / MCP connections / model keys.

- **The control-plane Helm chart now wires human-login OIDC end to end.** A new
  `controlPlane.oidc.*` values block (issuer/client/redirect, client+session secret via an
  existing Kubernetes Secret or a dev inline fallback, group/role claim names, operator and
  org-admin groups, and the operator seed) is rendered into the control-plane container env.
  Previously the deployment injected no OIDC env, so OIDC and the operator/org-admin
  derivation were unreachable in-cluster. OIDC stays off (no env emitted) unless an issuer
  URL is set, and the operator seed is emitted only when non-empty — so a default install is
  unchanged and fail-closed.
- **Zitadel is documented as OpenCrane's single trusted OIDC issuer (Mode-2 broker), with no
  Microsoft Entra dependency.** `website/security/identity.md` now states this plainly and
  documents the expected `groups`/`roles` claim names (`OIDC_GROUPS_CLAIM`/`OIDC_ROLES_CLAIM`)
  and how the operator-group and seed-email parameters are configured at install.

## [0.4.0] — 2026-06-19

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

- **Every service now emits structured, trace-correlated logs — and a single Helm toggle
  wires the whole fleet to GCP Cloud Logging + Cloud Trace (or any OTLP backend).** All
  OpenCrane services share a single `@opencrane/observability` library that writes
  synchronous pino JSON directly to stdout on every deployment, with no configuration
  required: each log record carries a `requestId` (propagated through the full async
  call-tree via `AsyncLocalStorage` without threading it by hand), and known secret fields
  (`authorization`, `token`, `apiKey`, `masterKey`, `client_secret`, `DATABASE_URL`, and
  their nested equivalents) are redacted before the record is serialised. Any stray
  `console.*` calls — from first-party code or noisy third-party libraries — are
  transparently routed into the same structured pipeline. The CLI writes to stderr so
  stdout stays reserved for `--output json`. Distributed tracing is opt-in: set
  `observability.otel.enabled: true` in Helm and the chart deploys an in-cluster
  OpenTelemetry Collector (DaemonSet by default, single Deployment for GKE Autopilot) that
  receives OTLP traces from all services, scrapes pod stdout via the filelog receiver,
  promotes pino's `trace_id`/`span_id` fields to first-class log attributes so logs and
  traces correlate in Cloud Trace, and exports both to GCP Cloud Logging + Cloud Trace
  (`exporter.backend: googlecloud`) or to any downstream OTLP endpoint
  (`exporter.backend: otlp`). Tracing is a no-op on a laptop or in CI when no collector
  endpoint is configured — nothing times out or errors.

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
