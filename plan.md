# OpenCrane — Active Plan

## Current State (2026-06-10)

- **Phases 1–3**: complete and validated.
- **Phase 5** (headless API + CLI + hosting adapter): complete. P5.2 (on-prem) and P5.3 (GCP) deploy-validation runs validated by user (2026-06-10).
- **Phase 4 Track A** (MCP & Skills runtime planes): complete. P4A.1–P4A.3 implemented, tested, and Helm/NetworkPolicy wired (2026-06-10).
- **Phase 4 Track B** (fleet organizational awareness): **decision-unblocked 2026-06-13** (P4B.0 closed — all Phase 4 Decisions resolved/defaulted). Build not yet started; greenfield, ~324h (P4B.1–P4B.6). See Phase 4 Decisions for the locked choices.
- **Track P4-C** (agent identity & personalisation via OpenClaw workspace files): scoped, design decisions locked. P4C.1–P4C.5 in Open Backlog; not yet started.
- **Track CONN** (OpenClaw connection auth & session security): pairing-broker endpoint implemented (2026-06-13); connection-security posture **decided = Option B** (short-lived re-brokered credentials + per-user kill-switch; control plane stays connection-stateless). Full trade-off in `docs/claw-security-considerations.md`. Transport hardening landed 2026-06-13 (CONN.2); `docs/auth.md` rewritten for the pairing broker (CONN.6); **CONN.8 wildcard TLS** first slice landed (operator Ingress `tls:` + cert-manager ClusterIssuer/Certificate Helm scaffold, dev selfSigned + prod ACME DNS-01) with onboarding-CLI/API + cross-namespace + dev-host + live-e2e as follow-ups. **Kill-switch chain landed 2026-06-13 (CONN.3 persistence+decode, CONN.4 device registry, CONN.5 cut + RBAC)** — testable spine complete; the gateway per-device revoke + CP-held operator device + in-pod mint exec are the remaining live-infra seams. Proxy (Option C) deferred as a contingent vision.
- **Track P4-D** (MCP & Skills platform completion — the two 🔶 gaps): scoped + decisions locked 2026-06-13. P4D.2 OCI/Zot **foundation slice landed** (`OciBundleStore` + gated Zot Helm; runtime cutover deferred to a live-Zot slice). P4D.1 Obot RFC-8693 creds queued. See Open Backlog → Track P4-D.
- **Review discipline** (2026-06-13): the `review` agent (`.claude/agents/review.md`) now has a mandatory **"verify every finding before reporting"** step — re-trace the cited code and construct a concrete repro before asserting; unconfirmed concerns go under *Open questions*, not *Findings*. Added after a review surfaced a finding that did not survive verification.
- **Branch**: `phase-4-5-fixes`, 6 commits ahead of `main`.

---

## Open Backlog (Execute Next)

> Authoritative, code-verified worklist as of 2026-06-10. Work top-to-bottom.
> Items marked **[BLOCKED]** need a decision before implementation — do not guess.

### Track P5 — Close Phase 5

- [x] **P5.1 Stale-Crossplane cleanup.** Removed unreachable `bucketclaims` RBAC rule +
  comment from `platform/helm/templates/operator-rbac.yaml`, removed stale Crossplane comments
  from `platform/terraform/cloud/gcp/main.tf` and `platform/deploy.sh`.
  Verified: `grep -ri crossplane platform/` returns nothing.
- [x] **P5.2 On-prem clean-cluster deploy validation.** Validated by user (2026-06-10).
  `platform/tests/k3d-e2e.sh` passed on fresh k3d cluster with `hosting.provider: onprem`
  and zero cloud env vars.
- [x] **P5.3 GCP adapter deploy validation.** Validated by user (2026-06-10).
  `terraform/cloud/gcp/` + `values/gcp.yaml` applied; operator provisioned a per-tenant GCS
  bucket via `GcpHostingAdapter` (no Crossplane). Acceptance criteria met.

### Track P4-A — Finish Phase 4 runtime-plane enforcement gaps

- [x] **P4A.1 Ingest scanning (scan → validate → register → entitle).** Added `SkillBundleScanStatus`
  enum + `scanStatus`/`scanFindings`/`scannedAt` fields (migration 0007). `POST /api/v1/skills/catalog/:id/scan`
  triggers Grype/Trivy scan (falls back `scanner-unavailable` gracefully). PUT gate rejects promotion
  to `published` when `scanStatus ≠ passed`. Internal delivery (`/api/internal/bundles`) only serves
  bundles with `scanStatus = passed`. 7 tests added; build + tests pass.
- [x] **P4A.2 Runtime-plane drift repair (operator config-slaving).** Added `RuntimePlaneDriftRepairer`
  (`apps/operator/src/runtime-planes/drift-repairer.ts`) — 60s interval compares Obot MCP gateway and
  skill-registry Deployment env vars against expected config, patches back in-place (preserving
  `valueFrom.secretKeyRef` refs). Wired into `operator/src/index.ts`. 3 tests added; build + tests pass.
- [x] **P4A.3 Tenant-side contract re-pull loop.** Added `/api/internal/contract/:name` endpoint with
  TokenReview identity enforcement (tenant can only pull its own contract). Operator injects
  `OPENCRANE_CONTROL_PLANE_URL` + `control-plane` projected SA token into tenant Deployments.
  `entrypoint.sh` background polling loop (30s) calls the endpoint, diffs SHA256, updates writable
  contract copy, sends SIGHUP to OpenClaw when contract changes. 6 tests added; build + tests pass.

### Track P4-B — Fleet Organizational Awareness (NOT STARTED — largest remaining effort)

> This entire track is greenfield. All items are **[BLOCKED]** on P4B.0 — resolve that first.

- [x] **P4B.0 Lock Phase 4 awareness decisions.** (2026-06-13) All "Phase 4 Decisions" below are
  now resolved (explicit) or defaulted — Track B is **decision-unblocked**. Key locks: single
  shared `libs/awareness` SDK · tenant-cohort canary rollout · citation = title+URI+timestamp ·
  Standard SLOs (p95<1s / 24h freshness / 0 policy violations) · hard ingest conformance gate ·
  most-specific-wins+deny-overrides scope precedence · participation over control-plane API +
  A2A Agent-Card advertisement · violation=page/drift=warn · per-scope-node owners approve
  promotions · bootstrap governed by P4-C layering. (Build is still greenfield, ~324h — see Key Tasks.)
- [ ] **P4B.1 Org Context / Awareness SDK.** New shared lib (`libs/awareness` or similar) that
  every OpenClaw consumes, pinned to a contract version. Acceptance: tenant pods retrieve org
  context through the SDK against Cognee with no control-plane retrieval mediation.
- [ ] **P4B.2 AccessPolicy → Cognee grant compiler.** Wire `Awareness` grants through the grant
  compiler and propagate AccessPolicy create/update/delete to Cognee grants within an SLO (today
  only dataset-membership sync exists). Anchor: `core/grants/grant-compiler.ts` (`Awareness` type),
  `routes/tenants.ts` Cognee sync. Acceptance: an AccessPolicy change reflects in Cognee grants
  within the defined SLO; covered by a test.
- [ ] **P4B.3 Awareness contract versioning + canary rollout.** Promote/rollback awareness
  contract versions across the fleet without tenant downtime. Acceptance: canary cohort + rollback
  path demonstrated.
- [ ] **P4B.4 Golden-query / eval harness.** Conformance suite for awareness correctness, policy
  safety, freshness, and citation quality. Acceptance: suite runs in CI and gates rollout.
- [ ] **P4B.5 Fleet skills-sharing protocol + participation monitoring.** Cross-tenant skill
  discovery/consumption protocol; control-plane monitors per-tenant participation, drifted
  versions, and policy-violating skill executions. (Catalog CRUD + registry delivery already
  exist; the fleet protocol layer does not.)
- [ ] **P4B.6 Fleet awareness dashboards + SLOs.** Prometheus metrics + Grafana dashboards +
  alert thresholds + runbook links for awareness SLOs (current `/prom` metrics have none).

### Track P4-C — Agent Identity & Personalisation (OpenClaw workspace files)

> New track scoped 2026-06-10. Lets tenants personalise their agents while platform
> core behaviour stays immutable. Decisions below are **LOCKED** (no P4B.0-style block).
> OpenClaw has no native file layering/precedence/includes (verified against docs.openclaw.ai),
> so OpenCrane implements the layering at the operator + entrypoint + control-plane layer.

**Locked design decisions (2026-06-10):**
- **Three ownership layers.**
  - *L0 Platform* — `AGENTS.md`, `TOOLS.md`. OpenCrane-owned, re-stamped every boot. Encodes
    system mechanics (managed mode, MCP routes via Obot gateway, per-entitlement skill pulls,
    contract semantics). Never editable by company or tenant.
  - *L1 Company* — company `SOUL.md` + curated policy/voice docs. Org-owned, editable via
    control-plane API, versioned v1…vN (immutable versions). Must carry **no** system mechanics.
  - *L2 Tenant* — effective workspace docs (`SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`,
    `HEARTBEAT.md`) under the persistent `/data/openclaw` workspace. Seeded from L1, then edited
    live in-pod; persists across restarts.
- **`TOOLS.md` is contract-derived** — rendered from the tenant's entitled MCP servers + skills.
- **Company→tenant reconciliation = agent-driven 3-way merge** (base = tenant's
  `lastReconciledVersion`, ours = new company version, theirs = tenant current). Conflict policy:
  company wins, tenant intent preserved where compatible. Idempotent/resumable like `migrate up`.
- **Propose-and-approve** — reconciler emits a proposed merge + diff; admin/tenant approves before
  it lands. No silent prompt changes.
- **Server-side execution, delivered via the P4A.3 re-pull loop** — control-plane reads the tenant's
  current doc through the internal token-authenticated endpoint, the merge agent (LiteLLM-backed)
  reconciles, and the result rides the existing contract delivery into the pod.
- **OpenClaw is made aware of doc changes** — on apply, the agent is notified and can view the
  change/diff (no silent identity swap-out).
- **Invariant guard:** the reconciliation agent is sandboxed to L1/L2 and can never edit L0. "Core
  behaviour cannot be changed" is guaranteed by L0 re-stamping + the IAM planes (Obot gateway +
  skill registry), NOT by prompt prose (OpenClaw has no precedence between files).

- [x] **P4C.1 Workspace bootstrap + layered seeding.** `_BuildConfigMap` emits L0 files
  (`AGENTS.md`, `TOOLS.md`) and L2 seed files (`SOUL.md.seed`, `IDENTITY.md.seed`, `USER.md.seed`)
  as ConfigMap keys; pins `agents.defaults.workspace = /data/openclaw/workspace` and
  `skipBootstrap: true` after the tenant-override merge (so they survive any `agents` override).
  `entrypoint.sh` re-stamps L0 files every boot and seeds L2 files once-if-absent.
  AGENTS.md contains the full platform brief (managed mode, gateway/registry URLs, ownership
  table, platform invariants). TOOLS.md lists live URLs (static for P4C.1).
  L2 seeds are personalised with tenant name and team. 2 tests added; 54/54 operator tests pass.
- [x] **P4C.2 Contract-derived `TOOLS.md`.** (2026-06-13) Pure `_RenderToolsMarkdown`
  (`core/contract/tools-markdown.ts`, sorted/deterministic so the in-pod content diff only
  fires on real change) renders TOOLS.md from the entitled MCP servers + skills. The internal
  contract endpoint (`routes/internal/tenant-contract.ts`) resolves display names/descriptions
  for the allow-decided ids and returns the rendered doc under `workspace["TOOLS.md"]`. The
  entrypoint poll loop (`apps/tenant/deploy/entrypoint.sh`) writes it to the workspace TOOLS.md
  on contract change via a `_apply_workspace_docs` node-extract, then SIGHUPs OpenClaw — so a
  grant/deny reflects within one poll interval with no pod restart. (The operator-mounted
  bootstrap contract has no workspace docs, so a cold start shows the static L0 TOOLS.md until
  the first poll refreshes it; the boot-time apply call is forward-compatible for the day the
  mounted contract embeds them.) Tests: `tools-markdown.test.ts` (3) + contract-route
  TOOLS.md assertion; control-plane 72/72, build clean; `bash -n` clean.
- [ ] **P4C.3 Company doc API + versioning (L1).** `companyDoc` / `companyDocVersion` Prisma models
  + migration; CRUD at `/api/v1/org/workspace-docs/:name` with immutable version history + audit;
  an allowlist guard rejecting company docs that carry L0 system-mechanic directives. Acceptance:
  publishing a new version stores it immutably and is retrievable by version; covered by tests.
- [ ] **P4C.4 Agent-driven reconciliation (propose).** LiteLLM-backed reconciler (follow
  `apps/harvesting-agent` shape) computes the 3-way merge, produces a per-tenant proposed merge +
  diff stored as a pending proposal, and tracks per-tenant `lastReconciledVersion`. Sandboxed to
  L1/L2. Acceptance: a company version bump generates a per-tenant proposal with a diff; the run is
  idempotent/resumable; the reconciler cannot alter L0; covered by a test.
- [ ] **P4C.5 Approval + delivery + agent awareness.** Approve/reject API; on approval the reconciled
  doc rides the re-pull loop into the workspace, bumps `lastReconciledVersion`, and audits; OpenClaw
  is notified and can view the change (e.g. a `BOOT.md`/`HEARTBEAT.md` note or system message + the
  diff). Acceptance: approving delivers the doc without a pod restart and the agent surfaces/can view
  the change; rejecting leaves the tenant doc untouched.

### Track CONN — OpenClaw connection auth & session security (Option B)

> Scoped 2026-06-13. How the SaaS-operator browser reaches a tenant's OpenClaw pod
> gateway, brokered by the control plane. **Posture decided = Option B** — full A/B/C
> trade-off, threat model (MITM/airport, two-clocks, K8s force-disconnect) and the
> accepted compromises are in `docs/claw-security-considerations.md`.

**Locked decision (2026-06-13):** Option B — short-lived, re-brokered credentials
(no long-lived token in the browser) + a **per-user** central kill-switch (OpenClaw
`device.token.revoke`/`pair.remove` + Kubernetes force-disconnect), plus transport
hardening. Control plane stays *connection*-stateless. Per-session cutting and a
standing per-frame audit choke point are **not** in scope → that is the proxy
(CONN.7), deferred.

- [x] **CONN.1 Pairing-broker endpoint.** `POST /auth/pod-token` returns the pod's
  pairing link `{ gatewayUrl, bootstrapToken, tenant, ingressHost }` instead of the
  old `aud=openclaw` K8s-SA mint. `_ResolveOpenClawPairing` (`infra/auth/openclaw-pairing.ts`)
  reads `configOverrides.openclaw.{gatewayUrl,bootstrapToken}`, derives `wss://<ingressHost>`
  as fallback, returns `bootstrapToken:null` once paired. Session required; email→tenant
  resolution fail-closed on ambiguity. Tests: `auth-pod-token.test.ts` (7) +
  `openclaw-pairing.test.ts` (5); `tsc --noEmit` clean, 57/57 control-plane tests pass.
- [x] **CONN.2 Transport hardening (do regardless).** (2026-06-13) Dependency-free
  `_TransportSecurity` middleware (`infra/middleware/transport-security.middleware.ts`,
  wired first in `index.ts`) emits HSTS `max-age=63072000; includeSubDomains; preload` on
  forwarded-HTTPS responses and offers an opt-in (`OPENCRANE_FORCE_HTTPS`) 308 HTTP→HTTPS
  redirect for safe methods — off by default so internal plain-HTTP health probes are not
  bounced (ingress normally enforces TLS). `cookieSecure` is now `_resolveCookieSecure`
  (`infra/auth/oidc.config.ts`): explicit `OIDC_COOKIE_SECURE` wins, else **forced `true`
  in production** regardless of redirect-URI scheme, else inferred for dev. Broker
  `_ResolveOpenClawPairing` (`infra/auth/openclaw-pairing.ts`) now rejects any non-`wss://`
  stored gateway URL and falls back to `wss://<ingressHost>` (or null). Tests:
  `transport-security.test.ts` (6) + `oidc-config.test.ts` (3) + 2 added wss-guard cases;
  build + `tsc --noEmit` clean, 68/68 control-plane tests pass. (`__Host-` cookie prefix not adopted — it
  requires path `/` + no Domain and is deferred to CONN.6 doc review.) (security doc §10–§11)
- [ ] **CONN.3 Pairing-link provisioning + short bootstrap.** Populate
  `configOverrides.openclaw.{gatewayUrl,bootstrapToken}` when the operator provisions a
  tenant pod, and mint/rotate **single-use, ~30–60s** bootstrap tokens. Anchor: operator pod
  provisioning + `routes/tenants.ts`.
  - **Research (2026-06-13, docs.openclaw.ai/channels/pairing):** the setup code IS exactly
    `base64({ url, bootstrapToken })` — matches our broker shape ✅. Setup codes are minted by a
    **pairing command** (`/pair`-style; bot replies with the setup code), **not** emitted at
    gateway startup — so provisioning must *run the pairing flow* against the pod (likely an
    `openclaw devices`-family CLI) and capture the code into `configOverrides`. **TTL is NOT
    documented as configurable** ("short-lived single-device", "treat like a password") — so the
    "~30–60s settable" assumption is unconfirmed; treat bootstrap as short-lived-but-fixed.
  - **Mint command RESOLVED (2026-06-13, openclaw CLI):** `openclaw qr --setup-code-only --json`
    (with `--remote`/`--url` for a remote gateway) emits the setup code carrying the opaque
    short-lived `bootstrapToken`. Provisioning runs this **in/against the tenant pod**, parses
    `{ url, bootstrapToken }`, stores it in `Tenant.configOverrides.openclaw`. Approve a paired
    device via `openclaw devices approve <requestId>`; gateway token via
    `openclaw doctor --generate-gateway-token`. **Caveat (issue #19352):** chicken-and-egg — the
    CLI may itself need a gateway token/pairing; mitigate by running in-pod with the gateway token
    in env. Now **buildable** (modulo that provisioning detail).
  - **Landed (2026-06-13):** the persistence + decode halves shipped. Control-plane
    `PUT /api/v1/tenants/:name/pairing` (`routes/tenants.ts`) stores/rotates
    `{ gatewayUrl?, bootstrapToken }` into `configOverrides.openclaw` (wss-only guard,
    merges existing overrides, audits `PairingRotated`, never echoes the token);
    `_ResolveOpenClawPairing` reads it back. Operator `_ParseOpenClawSetupCode`
    (`tenants/internal/openclaw-pairing-provision.ts`) decodes the
    base64(`{url,bootstrapToken}`) setup code (and tolerates the `--json` envelope).
    Tests: 6 parser cases (operator 62/62) + pairing-rotate covered via tenants route.
  - **Remaining (live seam):** the in-pod `openclaw qr --setup-code-only` **exec**
    (k8s pod-exec, real binary, the issue-#19352 chicken-and-egg gateway token) and
    wiring it into the operator reconcile to call the rotate endpoint — needs a live
    pod. The control-plane + decode plumbing is ready to receive it.
- [ ] **CONN.4 CP-held operator device + device registry.** OpenCrane holds one
  `operator.pairing`-scoped device per pod (paired server-side, key in a Secret), and a
  `BrokeredDevice` Prisma model + migration recording devices brokered per tenant.
  Acceptance: every broker call records the device; CP can authenticate to a pod gateway
  with `operator.pairing`. (Prereq for CONN.5; depends on CONN.3 / B1 signature scheme.)
  - **Research (2026-06-13):** scope model confirmed — the default pairing profile grants
    `node` + bounded `operator` (`operator.read/write/approvals`) and **explicitly NOT**
    `operator.admin`/`operator.pairing`. So a CP device with `operator.pairing` needs an
    explicit elevation/**approval** step (`openclaw devices approve`, which itself may need
    `operator.admin`). `device.token.revoke`/`rotate` require `operator.pairing` (confirms CONN.5's
    revoke half). **B1 device-signature RESOLVED (2026-06-13, openclaw source/issues):**
    algorithm = **Ed25519** (NOT ECDSA-P256 — the weownai `WebCryptoDeviceSigner` is WRONG and
    must switch to Ed25519, via WebCrypto Ed25519 or `@noble/ed25519`). **B1 fully VERIFIED against
    the shipped `openclaw@2026.6.6` source** (`dist/client-C2g2lFC5.js`, `dist/device-identity-CEPJolq9.js`):
    `deviceId = sha256(raw 32-byte pubkey).hex`; signed payload = pipe-joined
    `["v3", deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token, nonce, platform, deviceFamily]`
    (v2 = same minus the last two; nonce in both; platform/deviceFamily trimmed+lowercased; token→`""`);
    sign = `crypto.sign(null, utf8(payload), ed25519)` → **base64url**; `publicKey` = raw 32-byte key
    **base64url**. **No remaining unknowns** — B1 no longer blocks CONN.4; CONN.4 needs the device
    registry + CONN.3 flow. (Mint command CONN.3 verified: `openclaw qr --setup-code-only [--remote --url]`.)
  - **Landed (2026-06-13) — device registry half:** `BrokeredDevice` Prisma model +
    migration `0008_brokered_devices` (one row per (tenant, subject); `deviceId?`,
    `revokedAt?`; cascade on tenant delete). Every `/auth/pod-token` broker now upserts
    a row (`_RecordBrokeredDevice`, best-effort), so the kill-switch has an authoritative
    list of brokered connections. Tests: 1 registry case + the broker path.
  - **Remaining (live seam):** the **CP-held `operator.pairing` device** (paired
    server-side, key in a Secret) needs a live gateway to pair + the Ed25519 signer
    (B1, now byte-exact). Until then the gateway-revoke half of CONN.5 is the
    `_NoopGatewayAdmin` (see below).
- [ ] **CONN.5 "Cut tenant" kill-switch + RBAC.** Admin action + self-serve "sign out my
  other sessions": call `device.token.revoke` + `device.pair.remove`, then a **K8s
  force-disconnect** — pod-delete (CNI-independent) or a deny `NetworkPolicy` (only if the
  cluster CNI drops *established* flows — verify, else pod-delete). RBAC: add `networkpolicies`
  (create/delete) + `pods` (delete) in `platform/helm/templates/control-plane-rbac.yaml`.
  Acceptance: cutting a tenant severs live sockets **and** blocks re-auth; covered by a test
  (mocked k8s + gateway client). (security doc §4–§5)
  - **Landed (2026-06-13):** `_CutTenant` (`core/connections/cut-tenant.ts`) orchestrates
    gateway revoke (best-effort) → registry revoke (`BrokeredDevice.revokedAt`) → **K8s
    force-disconnect via pod `deletecollection`** by the `opencrane.io/tenant=<name>`
    label selector (CNI-independent — the authoritative cut). Admin route
    `POST /api/v1/tenants/:name/cut` (full-tenant, audits `Cut`) + self-serve
    `POST /api/v1/auth/pod-token/cut` (subject-scoped, **does not** delete the shared pod —
    relies on per-device gateway revoke). RBAC adds `pods get/list/delete/deletecollection`
    to the control-plane ClusterRole (helm-rendered). The gateway-revoke half is the
    `_NoopGatewayAdmin` (`core/connections/gateway-admin.ts`) until a CP operator device is
    paired (CONN.4 live seam) — pod-delete already severs live sockets, so this is safe; the
    no-op only defers the *re-auth-block* half. Tests: 4 `_CutTenant` cases (mocked k8s +
    gateway spy + no-op admin), control-plane 90/90. The deny-`NetworkPolicy` variant is
    **not** added — pod-delete supersedes it (only useful if a CNI fails to drop established
    flows; revisit if a future CNI needs it).
- [x] **CONN.6 Rewrite `docs/auth.md` for the pairing broker.** (2026-06-13) Replaced the
  stale `aud=openclaw` K8s-SA-token / RFC-8693 token-exchange description with the pairing-link
  broker + OpenClaw `connect` handshake (challenge → signed device assertion → `hello-ok`):
  rewrote the end-to-end flow, the credential-types table (bootstrap/device tokens vs projected
  SA token), the "Tenant pod access" section, added an Option B posture section + transport
  notes (CONN.2 fail-closed cookie/HSTS, CONN.8 wildcard TLS), and cross-linked
  `docs/claw-security-considerations.md`. Closes frontend `plan.md` B5. (Docs only.)
- [ ] **CONN.7 Proxy (Option C) — contingent vision.** Control-plane (or, preferred,
  **Envoy/mesh sidecar**) WebSocket proxy: per-session cut + standing per-frame audit/policy
  + zero browser credential. **[DEFERRED — revisit only if]** a hard requirement emerges for
  per-session cutting or per-frame auditing **and** the connection-stateful cost (LB affinity,
  reconnect storms on deploy, content transiting the CP, ~days build) is judged worth it.
  CONN.1–CONN.5 are prerequisites, so nothing is wasted. (security doc §6 / §8 / § Decision)
- [ ] **CONN.8 TLS issuance for tenant ingress (wildcard, k8s-native).** *First slice landed
  2026-06-13 — see Landed/Remaining at the end of this item.* *Prerequisite
  for CONN.2 to mean anything in production* — today the operator-built tenant Ingress
  (`apps/operator/src/tenants/deploy/5-ingress.ts`) has **no `tls:` block** and Helm has
  `ingress.tls.enabled: false` with an unwired `opencrane-wildcard-tls` secret slot
  (`platform/helm/values.yaml`). The browser connects `wss://<tenant>.<domain>`, so the
  ingress must present a browser-trusted cert. Kubernetes' own CA is cluster-internal and
  **not** browser-trusted, so certs come from a public CA via an in-cluster controller.
  **Decision (2026-06-13): use `cert-manager`, NOT Certbot.** cert-manager is the
  CNCF-standard k8s-native controller — declarative CRDs (`ClusterIssuer`/`Certificate`),
  runs in-cluster, stores certs in Secrets, auto-renews, integrates with Ingress, works on
  any cloud + on-prem. Certbot is host-centric/imperative and would mean rebuilding the
  reconcile/renew/secret plumbing by hand.
  - **Wildcard via ACME DNS-01.** One `*.<domain>` cert covers every tenant → new tenants
    need zero new issuance (no per-tenant latency, no Let's Encrypt rate limits). Wildcards
    require **DNS-01** (HTTP-01 can't issue wildcards). Issue into `opencrane-wildcard-tls`,
    flip `ingress.tls.enabled`, and add a `tls:` block (host + `secretName`) in `5-ingress.ts`.
  - **Domain & naming constraints (solve once, cleanly).** Tenants live exactly **one DNS
    label** under the base domain — e.g. base `ai.elewa.ke` → tenant `jente.ai.elewa.ke`,
    covered by a single `*.ai.elewa.ke` cert. A TLS wildcard matches *exactly one* label, so:
    (a) **tenant names must be a single label** under the base (no `app.jente.ai.elewa.ke`
    from one platform wildcard — that would need per-tenant wildcards / multi-level certs;
    revisit only if a tenant-owned-subdomain feature emerges); (b) the **apex is not covered**
    by `*.base` — issue one Certificate with both `dnsNames: [base, *.base]` so anything
    served at the bare base (or needed apex) works; (c) **DNS-01 lands on the base**, not the
    tenant — the challenge TXT is `_acme-challenge.<base>` (e.g. `_acme-challenge.ai.elewa.ke`),
    so the DNS token must own that zone — prefer a **delegated `ai.elewa.ke` subzone** (NS
    delegation) over handing out parent-zone (`elewa.ke`) credentials, to bound blast radius;
    (d) **cookie scoping is a security invariant** — because all tenants share `*.base`, the
    control-plane session cookie must stay **host-only** (no `Domain=.base`, which our
    express-session config already satisfies) or a tenant subdomain could read it; the
    deferred `__Host-` cookie prefix (CONN.2) would enforce this at the browser and is worth
    revisiting here.
  - **DNS-provider abstraction (cloud-agnostic + on-prem).** DNS-01 writes an
    `_acme-challenge.<domain>` TXT record, so cert-manager needs DNS-provider credentials.
    Support a small `{ provider, zone, credentialsRef }` config that renders the
    `ClusterIssuer` DNS-01 solver + credentials Secret. Solvers: built-in
    (route53/clouddns/azuredns/cloudflare/digitalocean), **RFC2136** (BIND/PowerDNS + TSIG —
    the on-prem/any-DNS escape hatch), or webhook solvers for the rest.
  - **Onboarding CLI + API.** New `oc platform dns set --provider … --zone … --token-file …`
    (mirroring the `_Register*` command pattern in `apps/cli/src/commands`) + equivalent
    control-plane API method, capturing the DNS-provider config above. New Helm template:
    `platform/helm/templates/cluster-issuer.yaml` (+ cert-manager as a dependency/prereq).
  - **Local/dev mode.** Keep the *same* cert-manager path, swap only the issuer: a
    `selfSigned`/`CA` `ClusterIssuer` (instant, no DNS challenge) + `sslip.io`/`nip.io`
    wildcard hostnames (`<tenant>.127.0.0.1.sslip.io` → localhost, no `/etc/hosts`, supports
    dynamic tenants) so the k3d substrate (`platform/tests/values-k3d-local.yaml`,
    currently `domain: opencrane.local`, TLS off) gets real TLS. The dev cert is still real
    TLS, so `wss://` + the CONN.2 wss-only/Secure/HSTS hardening are **not** bypassed — only
    the trust anchor differs. Optional `mkcert` root for warning-free browser trust; a
    plain-HTTP fallback stays gated behind `OIDC_COOKIE_SECURE=false` + a dev flag.
  - **Acceptance:** prod path issues a wildcard cert via DNS-01 and tenant Ingresses serve
    it (verified in a cluster/e2e); dev path serves self-signed TLS over an sslip.io
    wildcard host with no manual cert steps; onboarding CLI/API persists DNS-provider config.
    Pairs with CONN.3 (pod provisioning). Anchors: `5-ingress.ts`, `values.yaml`
    (`ingress.tls`), new `cluster-issuer.yaml`, `apps/cli/src/commands`, control-plane API,
    `platform/tests/values-k3d-local.yaml`. (security doc §11)
  - **Landed (2026-06-13):** operator now wires a config-gated `tls:` block into the tenant
    Ingress (`5-ingress.ts`, env `INGRESS_TLS_ENABLED`/`INGRESS_TLS_SECRET_NAME` via
    `config.ts`, default off → no behaviour change) referencing the shared wildcard Secret;
    Helm renders a `cluster-issuer.yaml` (ClusterIssuer `selfSigned` dev **or** `acme` DNS-01
    prod, with fail-guards on missing email/provider) + a wildcard `Certificate`
    (`*.<domain>` + apex), gated by `certManager.enabled`; operator-deployment env + `values.yaml`
    `certManager` block added. Tests: 2 ingress-TLS cases (operator 56/56); `helm template`
    validated for selfSigned, acme+cloudflare-DNS-01, the fail-guard, and operator env.
  - **Remaining (CONN.8 follow-ups):** (a) **onboarding CLI + API** (`oc platform dns set …` +
    control-plane method) to capture the DNS-provider `{ provider, zone, credentialsRef }` and
    render the solver/Secret — currently set via Helm values only; (b) **cross-namespace cert
    distribution** if tenants run outside the Certificate's namespace (cert-manager
    reflector / per-namespace Certificates) — current template assumes one shared namespace;
    (c) **dev wildcard hostnames** via `sslip.io`/`nip.io` wired into the k3d values
    (`platform/tests/values-k3d-local.yaml`) + optional `mkcert`; (d) **live ACME e2e**
    (needs a cluster + real DNS — cannot be unit-validated).

### Track P4-D — MCP & Skills platform completion (the two 🔶 gaps)

> Scoped 2026-06-13. Closes the two known runtime-plane gaps from `docs/obot.md` and
> `docs/skills-registry.md`. Custody/substrate decisions are **locked** (Phase 4
> Decisions: MCP creds = central broker in Obot ✅; skill substrate = OCI/ORAS + Cognee ✅).
>
> **NEXT EXECUTE CYCLE — scope locked 2026-06-13: P4-D only** (user-chosen). All four P4D
> design questions are resolved (see P4D.1/P4D.2). Tracks C (P4-B fleet awareness — needs its
> own 11-decision round) and D (CONN external OpenClaw-contract blockers) are explicitly NOT
> in this cycle.
>
> **Low-stakes infra defaults (apply unless overridden):** Obot topology = single replica
> (dev) / HA via values (prod); third-party source auto-sync = conservative interval,
> discover-only (install requires explicit admin); scheduler dispatch = job-scoped token,
> ~600s TTL, dedicated audience.

- [ ] **P4D.1 Obot downstream-credential brokering.** Today `OBOT_SERVER_ENCRYPTION_PROVIDER=none`
  and no downstream MCP credentials are brokered — the 🔶 in `docs/obot.md`. Custody is
  decided (Obot holds creds; the pod never receives them). Build: author downstream
  credentials in the control plane (`McpServerCredential` model + `routes/mcp-servers.ts`
  already exist), push them to Obot via the registry-sync/operator-reconcile path, enable
  Obot encryption-at-rest, and add a NetworkPolicy assertion that the pod cannot reach
  Obot's DB/token store. Acceptance: a tenant call to a credential-bearing MCP server
  succeeds with the secret injected **server-side in Obot**; the secret never appears in
  the pod env/filesystem (covered by a test); encryption-at-rest is on. **DECIDED (2026-06-13):**
  P4D-Q2 encryption-at-rest = **K8s-Secret-backed key** (intent: cloud-agnostic, on-prem-safe).
  ⚠️ The exact knob (`OBOT_SERVER_ENCRYPTION_PROVIDER=custom` + key-from-`opencrane-obot-enc`-Secret)
  is **ASSUMED, not verified** — Obot's valid encryption-provider values + key-mounting mechanism
  aren't in public docs; confirm against a live Obot before building.
  P4D-Q1 brokering mechanism = **per-user RFC 8693 token exchange** (preferred): Obot
  exchanges the caller identity for a short-lived, user-delegated downstream token per call,
  rather than injecting a static secret. **Caveat (must design for):** RFC 8693 requires the
  *upstream* to support OAuth token-exchange/OBO **and** a per-user (≈per-tenant, since
  tenant≈employee) identity/refresh-token store in Obot; MCP upstreams that don't support OBO
  cannot use it, so a **static per-tenant/per-server credential fallback** is still required
  for those. Also: the pod→Obot hop currently carries the *tenant* SA identity
  (`aud=obot-gateway`), so propagating the *human* identity far enough for a true per-user
  exchange is an added design step (else "per-user" collapses to per-tenant, which here is
  per-employee anyway). Build sequences RFC 8693 for OBO-capable upstreams + the static
  fallback path.
  Anchors: `mcp-servers.ts`, `obot-registry.ts`, operator drift-repairer, `obot-mcp-gateway-deployment.yaml`,
  `networkpolicy-planes.yaml`. (Phase 4 Decision: "MCP credential custody" ✅; Deliverable 8.)
  - **Research (2026-06-13, docs.obot.ai/concepts/mcp-gateway + obot.ai/blog):** Obot
    **natively performs RFC 8693 token exchange in its "MCP Server Shim"**, with client
    credentials / token-exchange secrets kept **in the shim, never exposed to the MCP server or
    the pod** — exactly our custody model ✅. The gateway "forwards the original bearer token
    unchanged" to the shim, which does the exchange; per-user is supported via **user-defined
    header pass-through**. So P4D.1 is largely *configuring an Obot-native capability*, not
    building token exchange ourselves — which resolves the earlier "who's the OBO actor"
    question (Obot is). **Still needs a live Obot:** the public docs do NOT specify the auth
    **config surface** (how an admin registers the OAuth client/token-endpoint/scopes) or the
    **encryption-at-rest/vault** mechanism — confirming this item stays parked until tested
    against a running Obot of the pinned version.
- [ ] **P4D.2 OCI/ORAS (Zot) digest-pinned bundle storage.** Today the Skill Registry serves
  bundle `content` from the control-plane DB — the 🔶 in `docs/skills-registry.md`. Substrate
  is decided (OCI/ORAS + Cognee). Build: deploy an in-cluster OCI registry (Helm), push each
  published `SkillBundle` as an OCI artifact (SKILL.md bundle, semver tag + immutable digest
  pin) via ORAS on publish, switch `routes/internal/skill-bundles.ts` + the skill-registry
  delivery app to fetch content **by digest from the registry**, and gate registry access by
  NetworkPolicy (pod has no path to the OCI store). The `digest` field already pins identity,
  so the delivery contract is unchanged. Acceptance: publishing a bundle stores an OCI
  artifact pinned by digest; delivery serves it from the registry; promotion/demotion stays a
  metadata-only grant move (artifact immutable); covered by tests. **DECIDED (2026-06-13):**
  P4D-Q3 registry = **Zot** (lightweight, OCI-native, in-cluster Deployment + PVC/object-store);
  P4D-Q4 delivery = **registry-only — drop `SkillBundle.content` from the DB** (the OCI store
  becomes the single source of truth, digest already pins identity); artifact naming
  `skills/<scope>/<name>:<semver>@<digest>`.
  Anchors: new Helm OCI-registry template, `skill-catalog.ts` (publish), `skill-bundles.ts`
  (delivery), `apps/skill-registry/src`, `networkpolicy-planes.yaml`. (Phase 4 Decisions:
  "Skill substrate" ✅, "Skill registry OCI store" + "OCI artifact naming"; Deliverables 7 & 9.)
  - **Landed (2026-06-13, foundation slice):** `OciBundleStore`
    (`apps/control-plane/src/core/oci/oci-bundle-store.ts` + `.types.ts`) — OCI Distribution v2
    push (blob upload + manifest so the blob isn't GC'd) and **digest-verified** pull-by-digest
    (rejects bytes that don't hash to the requested digest). Hardened per review: idempotent
    re-push (accepts 2xx / blob-already-exists, not strict 201), `sha256:<64hex>` digest
    validation before any URL use, same-origin-only upload `Location` (refuses redirects off the
    registry), and constructor validation of registryUrl/repository. Injectable transport, 8 unit
    tests (control-plane 80/80). Helm: gated Zot Deployment+Service(+PVC) `skill-oci-store.yaml` +
    `skillRegistry.ociStore` values block (default **off**); `helm template` validated (renders
    when enabled, nothing by default). `tsc --noEmit` clean. Non-destructive — no runtime path
    changed yet.
  - **Cutover landed (2026-06-13, dual-write):** (a) bundle **publish** now dual-writes to Zot
    (`skill-catalog.ts` PUT→published → `_PushPublishedBundle`, best-effort); (b) **delivery**
    (`skill-bundles.ts`) reads Zot-first via `_ResolveBundleContent` (digest-verified inside the
    store) with DB-`content` fallback on miss/error; (c) DI through `routes.ts` from
    `SKILL_OCI_REGISTRY_URL`/`SKILL_OCI_REPOSITORY` (`_BuildOciBundleStore`, null → DB-only, so
    existing installs are unchanged); (d) `networkpolicy-planes.yaml` gains a `skill-oci-ingress`
    policy admitting **only the control plane**; control-plane Deployment gets the OCI env when
    `ociStore.enabled`. Tests: `_ResolveBundleContent` (5) — Zot-hit / null-miss / throw-fallback /
    no-store / neither. control-plane 85/85, `tsc` clean, `helm template` validated (env + policy
    render when enabled, nothing by default). Safe: the DB `content` fallback means the
    entitlement-gated delivery path is unchanged until Zot is populated + verified.
  - **Parked — needs LIVE infrastructure (do not ship blind):** (e) backfill existing bundles
    into a running Zot, then the **destructive** Prisma migration dropping `SkillBundle.content`
    (the registry-only end state); (f) live round-trip e2e against a real Zot. **P4D.1** (Obot
    RFC-8693 token exchange) is likewise parked — it needs a live Obot/upstream to test OBO.

---

## Phase 4: Fleet Organizational Awareness + MCP & Skills Platform

### Architecture Checkpoint: Uniform Awareness Across All OpenClaws

1. **Awareness Control Model**
   - Retrieval stays direct from OpenClaw/Clawdbot to Cognee.
   - Control-plane remains the authority for dataset membership and permission grants only. This needs to be integrated with Cognee so Cognee can ensure Clawdbot access is secure.
   - No control-plane retrieval proxy is reintroduced.

2. **Uniform Awareness Contract**
    - Adopt a hybrid uniform-awareness contract model:
       - Declarative contract schema as source of truth (query rewrite policy, dataset scope selection, citation requirement, fallback behavior, freshness policy).
       - Shared OpenClaw SDK as the execution engine so behavior is consistent across all tenant runtimes.
       - Control-plane served effective-contract endpoint for per-scope delivery (org/department/project/personal), cached client-side by contract ID.
    - Use explicit SemVer for contract compatibility:
       - Major for breaking behavior/response changes.
       - Minor for additive capabilities.
       - Patch for non-breaking fixes.
    - Roll out with operational safeguards:
       - Tenant-cohort canary progression (personal -> project -> department -> org).
       - Optional shadow-mode diffing before cutover.
       - Contract-ID pinning and one-step rollback to the previous known-good contract.

3. **Org Knowledge Fabric Scope**
   - Build one normalized organization index model shared across all connectors.
   - Standardize document lineage metadata (source, owner, ACL origin, freshness markers, ingest cursor).
   - Keep source systems as SoR; Cognee remains orchestration/storage.

4. **Policy and Freshness Enforcement Plane**
   - Enforce policy at write-time (dataset assignment) and read-time (OpenClaw post-filter checks where needed).
   - Freshness/invalidation logic is centralized as reusable OpenClaw behavior, not bespoke prompt rules.
   - Define stale-data fallback UX and reason codes.

5. **MCP & Skills Platform (Config-Slaved Ingress Planes)**
   - Replace the policy-only MCP Server Plane and the shared-PVC skill mount with two config-slaved ingress service planes, both governed by the control-plane as sole authority.
   - **Obot MCP Gateway** — in-cluster MCP registry + gateway (runtime tool broker). Headless, admin disabled, config-slaved via operator reconcile.
   - **Skill Registry & Delivery** — org-aligned skill management over OCI/ORAS (Zot) with per-read entitlement enforcement.
   - Tenant→plane auth = projected ServiceAccount token, audience-bound (`aud=obot-gateway` / `aud=skill-registry`), ~600s TTL, kubelet-rotated. Delete the predictable `OPENCLAW_GATEWAY_TOKEN`.
   - MCP downstream secrets live only in Obot (central broker, confirmed); never reach a pod.
   - Skill substrate = build thin over OCI/ORAS + Cognee (confirmed); not a ClawHub fork.
   - Two clocks: revocation effective on next gateway call / next pull (fail-closed); new grants usable after next contract re-pull (eventually-consistent).
   - Remove legacy wiring — no duplicate failover paths, single clean architecture.
   - Full specification in `mcp-skills-platform-brief.md`.

6. **Skills Sharing and Participation Protocol**
   - Define a fleet-wide skills-sharing model with explicit hierarchy: org, department, project, personal.
   - Support controlled promotion and demotion between scopes (personal -> project -> department -> org and reverse) with policy checks and audit trail.
   - Every promoted or demoted skill remains versioned and immutable by digest; no in-place mutation.
   - Define a protocol every OpenClaw participates in: advertise capabilities, request shared skills, attest policy context, emit execution outcome events.
   - Control-plane monitors protocol participation health, policy compliance, and rollout version drift.
   - Prefer existing protocols first: OpenClaw skill folder format plus OCI Distribution for bundle transport/versioning.

7. **Control-Plane MCP & Skill Management Surfaces**
   - **MCP server management:** full lifecycle CRUD for MCP servers; `McpServer`, `McpServerGrant`, `McpServerCredential` data models; per-scope entitlement via the shared 5-level compiler; config + grants pushed to Obot MCP Gateway via operator reconcile.
   - **Skill catalog, sharing & promotion:** replace filesystem-only `skillsRouter` with registry-backed catalog; `SkillBundle` (immutable, OCI digest-pinned), `SkillEntitlement`, `SkillPromotion` models; Cognee-backed semantic search; promotion/demotion workflow with admin review.
   - **Third-party source installation:** `ThirdPartySource` and `ThirdPartySourceItem` models; support MCP Server Registry, Anthropic skills, ClawHub (future), custom Git repos, manual upload; security-critical ingest pipeline (fetch → scan → validate → register → entitle → audit); auto-sync via CronJob (discover only, install requires explicit admin action).

8. **Effective-Contract Integration (MCP + Skills)**
   - Extend `runtimeContract` with `gateway`, `mcp.servers` (compiled grant), `skills.entitled` (index with name, scope, version, digest), `contractVersion`.
   - `GET /api/tenants/:name/effective-contract` compiles MCP + skill grants by evaluating all entitlement records matching the tenant's org hierarchy position.
   - Pod re-pulls contract at agentic-loop boundaries; diffs entitled set; pulls new bodies, drops de-entitled; refreshes discovery index.
   - Entitlement-scoping is security-critical: registry is the boundary (not the contract); existence-hiding (404 not 403); no list/search verb on pod-facing delivery endpoint; audit every out-of-scope attempt.

**Action**: Deliver a single organizational-awareness layer that every OpenClaw instance consumes identically, with direct Cognee retrieval, centrally managed permissions, and two config-slaved ingress planes for MCP and skills.

---

### Deliverables

1. **Org Context SDK For OpenClaw Fleet**
   - Shared OpenClaw package that wraps retrieval, reranking, citation shaping, and freshness checks.
   - Required in every tenant runtime so awareness behavior is uniform by default.
   - Feature-flagged rollout controls per tenant cohort.

2. **Awareness Policy Compiler**
   - Compile AccessPolicy + dataset membership into Cognee grants and OpenClaw runtime hints.
   - Emit deterministic policy snapshots with version IDs for audit and rollback.

3. **Organization Index Schema v2**
   - Add canonical metadata fields for org semantics (department, project, confidentiality, jurisdiction, retention class).
   - Add connector conformance validation so all sources produce uniform metadata shape.

4. **Fleet Evaluation Harness**
   - Golden query suite for organizational awareness quality (correctness, policy safety, citation quality, freshness).
   - Regression gate in CI before awareness-contract changes can be promoted.

5. **Observability and SLOs**
   - Awareness SLOs: permission-violation rate, stale-answer rate, citation coverage, p95 retrieval latency.
   - Per-tenant and fleet-wide dashboards with alerting for policy or freshness regressions.

6. **Skills Sharing Mesh and Protocol Runtime**
   - Implement a shared-skills participation protocol for OpenClaws with versioned message contracts.
   - Add control-plane visibility endpoints for protocol heartbeats, skill bundle distribution status, and policy-compliant execution traces.
   - Add kill-switch and scoped rollout controls for protocol versions.

7. **Hierarchical Skill Registry (Protocol-First)**
   - Replace filesystem-only skill sharing with a registry-backed distribution model while preserving local cache for runtime startup during migration.
   - Skill content standard: OpenClaw SKILL.md bundle format with frontmatter metadata validation.
   - Distribution/versioning standard: OCI artifacts (semver tags + immutable digest pinning).
   - Promotion and demotion are metadata operations over immutable versions (scope grants move, artifact stays unchanged).
   - After protocol cutover criteria pass, remove legacy filesystem-only sharing paths and keep filesystem usage as pull-through cache only.

8. **Obot MCP Gateway (Config-Slaved Ingress)**
   - Deploy Obot headless with native admin disabled and IdP bound to central OIDC.
   - Operator reconciles config + MCP server registries; drift-detects/repairs.
   - Per-call scope check via projected JWT (`aud=obot-gateway`).
   - Downstream credential brokering via RFC 8693 shim; secrets never reach tenant pods.
   - NetworkPolicies restrict tenant pods to gateway ingress only (no path to Obot DB).

9. **Skill Registry & Delivery Service (Config-Slaved Ingress)**
   - New in-cluster ingress service over OCI/ORAS (Zot) for scoped skill content delivery.
   - Entitlement enforced per read; pod-facing endpoint supports only `get-by-entitled-digest` (no list/search).
   - Existence-hiding: non-entitled lookups return 404, not 403.
   - Ingest/scan pipeline: Trivy/Grype on every ingest; flagged items quarantined.
   - NetworkPolicies restrict tenant pods to delivery ingress only (no path to OCI store).

10. **Control-Plane MCP & Skill Management**
    - MCP server lifecycle CRUD with per-scope entitlement grants via 5-level compiler.
    - Skill catalog with registry-backed authoring, promotion/demotion workflow, and Cognee-backed search.
    - Third-party source management: upstream registry sync, security-critical ingest pipeline, explicit admin-only installation.
    - Config + grant push to both planes via operator reconcile path.

11. **Projected-Token Identity Migration**
    - Replace `OPENCLAW_GATEWAY_TOKEN` with audience-bound projected ServiceAccount tokens (~600s TTL, kubelet-rotated).
    - Set tenant SA audiences for both planes (`aud=obot-gateway`, `aud=skill-registry`).
    - Extend effective-contract with `mcp.servers`, `skills.entitled`, and `contractVersion`.

12. **Central Per-Tenant Scheduler**
    - Central scheduler owns schedule + governance; dispatches jobs as tenant identity via projected-token path.
    - Claws do not self-schedule; schedules survive pod suspension and restarts.
    - Wake/dispatch path guarded: job-scoped token, audited, no broad impersonation.

13. **Control-Plane Admin Surface (API + CLI)**
    - Every Obot/MCP/skill admin action reachable via the published API + `oc` CLI.
    - UI parity (if desired) is an external-consumer concern; `apps/control-plane-ui` was removed from this repo in Phase 5.

### Current Implementation Progress

> **Reconciled against code 2026-06-10.**

- [x] Org index schema v2 metadata fields: department/project scope, confidentiality, jurisdiction, retention class, ACL lineage, freshness markers, ingest cursor tracking.
- [x] Slack harvesting emits lineage/freshness metadata; ingestion rejects non-conformant org index records.
- [x] Projected-token migration: `aud=obot-gateway` and `aud=skill-registry` implemented in `apps/operator/src/tenants/deploy/3-deployment.ts`.
- [x] Real grant compilation: `apps/control-plane/src/core/grants/grant-compiler.ts` (scope precedence: priority → deny-over-allow → newest). `GET /tenants/:name/effective-contract` compiles Awareness/McpServer/SkillBundle grants. The `mcp.servers`/`skills.entitled` fields in `2-config-map.ts` are **intentionally advisory stubs** — authoritative grant is the effective-contract endpoint.
- [x] Control-plane MCP/Skills/third-party management surface: Prisma models + CRUD routes (`routes/mcp-servers.ts`, `routes/skill-catalog.ts`, `routes/third-party-sources.ts`) + `GET /tenants/:name/effective-contract` in OpenAPI spec.
- [⛔] ~~Control-plane UI Phase 4 slice~~ — removed by Phase 5; admin surfaces are API + `oc` CLI only.
- [ ] Connector rollout beyond Slack blocked on open Phase 4 connector-adoption and department-scope decisions.

### Phase 4 Reality Check (Current Gaps)

- [x] **Obot MCP Gateway deploy is real** (verified 2026-06-10). `obot-mcp-gateway-deployment.yaml` runs `ghcr.io/obot-platform/obot` with a PostgreSQL DSN and real `OBOT_SERVER_*` env, wired to poll `/api/internal/obot-registry`. `ObotHealthChecker` in `apps/operator/src/mcp-gateway/` monitors availability. **Remaining: `aud=obot-gateway` projected-token validation + RFC 8693 downstream-credential brokering not yet proven — fold into P4A.3.**
- [x] **Skill Registry & Delivery service is built** (verified 2026-06-10). `apps/skill-registry/`: `aud=skill-registry` projected-token validation via Kubernetes TokenReview, get-by-digest only, existence-hiding 404s, per-read entitlement via `/api/internal/bundles/:digest/content`. **Note:** content served from control-plane DB, not yet OCI/ORAS-over-Zot. **Trivy/Grype scanning not implemented — P4A.1.**
- [~] Operator drift repair: management/grant layer + Obot catalog sync are in place, but no path reverts manual edits to Obot or skill-registry config — detect-only, DB-projection-scoped. **P4A.2.**
- [x] Control-plane MCP/skills CRUD and third-party ingest routes implemented; entitlement enforced at registry boundary. Residual: ingest scanning (P4A.1).
- [⛔] ~~Control-plane frontend CRUD/install flows~~ — out of scope after Phase 5 UI removal.
- [x] Helm manifests/NetworkPolicies/CRDs for both ingress planes scaffolded under `platform/helm/`.
- [ ] Fleet-awareness track — not started.

### Key Tasks (Phase 4)

| Task | Owner | Effort | Dependency |
|------|-------|--------|-----------|
| Org Context SDK shared package | Backend | 20h | Phase 3 memory cutover |
| Awareness contract + versioned rollout controls | Backend | 14h | SDK baseline |
| AccessPolicy compiler to Cognee grants + runtime hints | Backend | 18h | Dataset membership APIs |
| Org index schema v2 + connector conformance checks | Backend | 20h | Harvesting foundation |
| Fleet evaluation harness (golden queries) | QA + Backend | 18h | SDK + schema v2 |
| Awareness SLO dashboards and alerts | DevOps + QA | 14h | Telemetry instrumentation |
| Skills sharing protocol runtime + schema | Backend | 16h | Org Context SDK + skill allowlist model |
| Control-plane protocol monitoring + dashboards | Backend + DevOps | 10h | Protocol runtime telemetry |
| Hierarchical scope promotion/demotion workflow + audit trail | Backend | 10h | Skills sharing protocol runtime |
| OCI-based skill registry sync (digest pinning + rollout policy) | Backend + DevOps | 6h | Hierarchical scope model |
| Projected-token identity migration (remove `OPENCLAW_GATEWAY_TOKEN`, SA audiences) | Backend | 10h | Phase 3 tenant SA baseline |
| Effective-contract extension (`mcp.servers`, `skills.entitled`, `contractVersion`) | Backend | 12h | Projected-token identity |
| MCP server management routes + data model (`McpServer`, `McpServerGrant`) | Backend | 14h | Effective-contract extension |
| Skill catalog routes + data model (`SkillBundle`, `SkillEntitlement`, `SkillPromotion`) | Backend | 16h | OCI-based skill registry |
| Third-party source management routes + ingest pipeline | Backend | 14h | MCP server + skill catalog routes |
| 5-level permission compiler (shared by MCP + skills + awareness) | Backend | 12h | AccessPolicy compiler baseline |
| Obot MCP Gateway deployment (headless, config-slaved, drift-repaired) | Backend + DevOps | 14h | MCP server management routes |
| Skill Registry & Delivery service (OCI/ORAS + entitlement enforcement) | Backend + DevOps | 16h | Skill catalog routes |
| Helm templates + NetworkPolicies for both ingress planes | DevOps | 10h | Gateway + registry deployment |
| CRDs: `MCPServer`, `ObotConfig`, `SkillBundle`, `SkillRegistry`, `Schedule` | Backend + DevOps | 8h | Phase 3 CRD baseline |
| Central per-tenant scheduler (dispatch as tenant identity) | Backend | 12h | Projected-token identity |
| Tenant-cohort canary rollout and rollback playbook | DevOps | 10h | Feature flags + evaluation harness |
| **Phase 4 Total** | | **324h** | |

### Success Criteria

- [ ] Every OpenClaw uses the same awareness SDK and contract version by default.
- [ ] Retrieval remains direct to Cognee with no control-plane retrieval mediation path.
- [ ] AccessPolicy updates propagate to Cognee grants within defined SLO.
- [ ] Golden query suite passes for correctness, policy safety, freshness, and citation quality.
- [ ] Fleet dashboards expose awareness SLOs with alert thresholds and runbook links.
- [ ] Canary rollout path can promote and rollback awareness contract versions without tenant downtime.
- [ ] Shared skills are discoverable and consumable across allowed scopes using a single fleet protocol.
- [ ] Control-plane can monitor per-tenant protocol participation, drifted versions, and policy-violating skill executions.
- [ ] Skills support org, department, project, and personal scopes with policy-controlled promotion and demotion flows.
- [ ] Every deployed skill is versioned and pinned by immutable artifact digest, with rollback to prior versions supported per scope.
- [ ] Legacy filesystem-only sharing paths are removed after protocol cutover; only registry-backed distribution with optional pull-through cache remains.
- [ ] Tenant pods authenticate to both planes via projected ServiceAccount tokens only; no static bearer tokens remain.
- [ ] A tenant cannot obtain or read another tenant's gateway/downstream token (no shared/guessable credential anywhere).
- [ ] Tenant pod filesystem/env contains no MCP downstream secret; secrets live only in Obot token store.
- [x] A tenant pod cannot enumerate or pull any skill outside its compiled entitlement. **Verified: skill-registry is get-by-digest-only, entitlement compiled per request, existence-hiding 404s, `aud=skill-registry` projected-token validation.**
- [~] Removing a grant denies the next MCP call / skill pull (audited) without a pod restart. **Grant compiler + effective-contract recompute exist; tenant-side re-pull loop unverified — P4A.3.**
- [~] Adding a grant becomes usable after the next contract re-pull, no restart. **Same — P4A.3.**
- [ ] Manual edits to either plane's config are reverted by operator drift reconcile. **Not met: detect-only — P4A.2.**
- [x] MCP servers are manageable via control-plane CRUD with per-scope entitlement grants.
- [~] Third-party MCP servers and skills installable via the ingest pipeline. **Register/entitle exists; scan step missing — P4A.1.**
- [ ] Skill catalog supports authoring, promotion/demotion with admin review, and Cognee-backed semantic search.
- [⛔] ~~Control-plane UI supports Obot config, MCP install, skill catalog/entitlements~~ — superseded by Phase 5. Re-scoped: every admin action reachable via API + `oc` CLI.
- [ ] Per-tenant schedules survive pod suspension and restarts; claws run no self-owned cron.
- [ ] All new code conforms to `AGENTS.md`.

> **Phase 4 status:** Track A complete (P4A.1–P4A.3). Track B greenfield and **decision-unblocked 2026-06-13** (P4B.0 closed; all Phase 4 Decisions resolved/defaulted) — build not yet started (~324h).

---

## Phase 4 Decisions (Lock Before Execution of Track B)

> All items below must be resolved before Track B implementation starts. Confirmed items are marked [x].
>
> **Triage (2026-06-13):** the MCP/skills-platform decisions are resolved (see P4-D + the [x]
> items below) and are in the next build cycle. The remaining `[ ]` items are all **Track B
> fleet-awareness** product decisions — deferred to a dedicated decision round (they are NOT in
> the P4-D cycle and are a separate ~324h track). Two further blockers are **external** (not
> resolvable here): CONN.3/B2 pairing-link + bootstrap-mint provisioning and B1 device-signature
> scheme — both need OpenClaw-contract facts.

- [x] Awareness SDK ownership model. **Single shared package `libs/awareness`, pinned to a contract version, consumed by every tenant runtime (2026-06-13).**
- [x] Contract version rollout strategy. **Tenant-cohort canary waves (personal→project→department→org) + optional shadow-mode + one-step contract-ID rollback (2026-06-13).**
- [x] Minimum required citation format. **Source title + URI/link to the system of record + freshness timestamp (2026-06-13).**
- [x] Fleet SLO thresholds. **"Standard": p95 retrieval < 1s; re-fetch when memory > 24h stale; policy-violation rate = 0 (hard gate + alert) (2026-06-13).**
- [x] Connector conformance bar for org index schema v2. **Hard gate at ingest — reject non-conformant records (missing lineage/ACL-origin/freshness/scope) (2026-06-13).**
- [x] Skills sharing scope rules + precedence. **Most-specific-wins (personal〉project〉dept〉org), deny-overrides-allow at a tie — matches the grant compiler (2026-06-13).**
- [x] Protocol transport + delivery guarantees for claw participation events. **Over the control-plane API, at-least-once + idempotency keys, `aud=control-plane` projected token (no new bus). Claws learn the protocol via the pinned `libs/awareness` SDK + versioned effective-contract (re-pull plumbing) and advertise capabilities via an A2A-style "Agent Card" manifest (researched 2026-06-13). (security: events carry no secrets.)**
- [x] Monitoring severity model. **Policy-violating skill execution = critical/page; non-participation or version drift = warning (dashboard/digest, no page) (2026-06-13).**
- [~] Department scope vs team scope. **Keep both as distinct levels in the model, but allow `team` and `department` to alias the same group initially and split later (no forced migration up front) (2026-06-13).**
- [x] Promotion/demotion authorization + approvers. **Each scope node (org/department/team/project) has one or more **owners**; a promotion/demotion request must be approved by the owner(s) of the relevant scope. Needs an `owners` (multi-owner) concept per scope node (2026-06-13).**
- [x] OCI artifact naming, tagging, and digest pinning policy for skill versions. **`skills/<scope>/<name>:<semver>@<digest>` (2026-06-13).**
- [x] MCP credential custody: central broker (Obot holds downstream creds; pod never receives them). **Confirmed.** Mechanism (2026-06-13): **per-user RFC 8693** token exchange + static per-tenant/per-server fallback for non-OBO upstreams; encryption-at-rest = K8s-Secret-backed key. (P4D.1)
- [x] Skill substrate: build thin over OCI/ORAS + Cognee (not a ClawHub fork). **Confirmed.**
- [~] Obot MCP Gateway version and deployment topology (single replica vs HA). **Default (2026-06-13): single replica dev / HA via values prod.**
- [x] Skill registry OCI store: Zot vs alternative OCI-compliant registry. **Zot (2026-06-13).** (P4D.2)
- [~] Third-party source auto-sync interval defaults and rate-limit policy. **Default (2026-06-13): conservative interval, discover-only (install requires explicit admin action).**
- [~] Scheduler dispatch identity model: job-scoped token TTL and audience. **Default (2026-06-13): job-scoped token, ~600s TTL, dedicated audience.**
- [x] ClawdBot bootstrap injection content review and sign-off. **Governed by the P4-C L0/L1/L2 doc layering + propose-and-approve (no separate process; no silent prompt changes) (2026-06-13).**

---

## Go-Live Checklist (Open Items)

| Item | Status | Done Criteria |
|------|--------|---------------|
| GCP installer smoke (`./platform/install.sh gcp`) | Not yet revalidated | Fresh GCP project deploys end-to-end; control-plane endpoint reachable; test tenant reconciles successfully. |
| DNS + ingress verification | Not started | Domain and TLS resolve correctly; control-plane and tenant subdomains accessible externally. |

All other checklist items (local baseline, k3d e2e, Helm chart, Docker CI publish, Prisma migrations, CI e2e gate, runbook) are complete. See `plan-done.md` for the full table.

---

## Cross-Phase Priorities

### Must Do Before Public Release

1. **Security Hardening**: Non-root pod, read-only root fs, drop Linux caps, resource limits, NetworkPolicy default-deny (done in AccessPolicy operator).
2. **Documentation**: Deployment guide, operator reference, example Tenant CRs, troubleshooting.
3. **RBAC**: Operator ClusterRole, control-plane Role, per-tenant ServiceAccount Workload Identity.
4. **Testing**: Operator integration tests (k3d), control-plane API tests, Helm chart validation.
5. **Observability**: Structured logging (pino), Cloud Logging ingestion, operator metrics.

### Nice to Have (Post-Phase 3)

1. Observability: OTel → ClickHouse for audit trail.
2. Advanced governance: policy approvals, audit webhook.
3. Advanced scheduling: tenant pod affinity, PDB for disruption budgets.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Operator watch/reconcile bugs break tenant pods | Early k3d integration tests, canary rollout strategy for operator updates |
| GCS Fuse CSI mount failures | Mount readiness check in pod init, fallback PVC if CSI unavailable |
| Control-plane DB scaling | Postgres connection pooling, read replicas for analytics |
| LiteLLM key generation during reconcile blocks tenant creation | Async key generation + retry loop, fallback to pre-generated key pool |
| Retrieval returns data outside tenant scope | Enforce AccessPolicy-filtered query path, deny-by-default checks, and conformance tests for allow/deny behavior |
| Harvesting agent ingestion drift or stale context | Cursor-based sync with checkpoints, lag/error SLO alerts, and replay-capable ingest jobs |
| Update rollback fails | Manual rollback instructions, `kubectl patch Tenant` to change version |
