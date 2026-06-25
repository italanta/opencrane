# OpenCrane — Active Plan

> **Execution sequence rebased 2026-06-25:** the forward roadmap is now the **S-series** in
> *Open Backlog* — the silo-multi-tenant program (`silo-multi-tenant-plan.md`) runs first as
> S1–S7, then the independent leftovers as S8–S12. The dated *Current State* + lettered tracks
> below are kept as reference/history.

## Current State (2026-06-10)

- **Phases 1–3**: complete and validated.
- **Phase 5** (headless API + CLI + hosting adapter): complete. P5.2 (on-prem) and P5.3 (GCP) deploy-validation runs validated by user (2026-06-10).
- **Phase 4 Track A** (MCP & Skills runtime planes): complete. P4A.1–P4A.3 implemented, tested, and Helm/NetworkPolicy wired (2026-06-10).
- **Phase 4 Track B** (fleet organizational awareness): **decision-unblocked 2026-06-13** (P4B.0 closed). **P4B.1 Awareness SDK landed**; greenfield remainder P4B.2–P4B.7 (incl. P4B.7 scope-aware retrieval plugin + CLI/API session→scope binding for anti-spill). See Phase 4 Decisions for the locked choices.
- **Track P4-C** (agent identity & personalisation via OpenClaw workspace files): **P4C.1–P4C.5 landed** (2026-06-13). Workspace bootstrap/seeding, contract-derived TOOLS.md, company-doc API + immutable versioning + L0 guard, agent-driven reconciliation (deterministic merger; LiteLLM agent merge is the seam) producing approve/reject proposals, and version-gated delivery into the pod via the re-pull loop. Whole track testable spine complete; live LiteLLM merge quality is the remaining upgrade.
- **Track CONN** (OpenClaw connection auth & session security): pairing-broker endpoint implemented (2026-06-13); connection-security posture **decided = Option B** (short-lived re-brokered credentials + per-user kill-switch; control plane stays connection-stateless). Full trade-off in `website/security/connection-security.md`. Transport hardening landed 2026-06-13 (CONN.2); `website/security/identity.md` rewritten for the pairing broker (CONN.6); **CONN.8 wildcard TLS** landed (operator Ingress `tls:` + cert-manager ClusterIssuer/Certificate Helm scaffold, dev selfSigned + prod ACME DNS-01; **onboarding CLI/API `oc platform dns set` + dev sslip.io hosts landed 2026-06-13**) with cross-namespace + live-ACME-e2e as the remaining (cluster-bound) follow-ups. **Kill-switch chain landed 2026-06-13 (CONN.3 persistence+decode, CONN.4 device registry, CONN.5 cut + RBAC)** — testable spine complete; the gateway per-device revoke + CP-held operator device + in-pod mint exec are the remaining live-infra seams. **Trusted-proxy connection model pinned fail-closed (CONN.9, 2026-06-22):** `GATEWAY_TRUSTED_PROXIES` empty ⇒ trust-nothing, malformed ⇒ crash, Helm-values-driven with the weownai-dev pod CIDR as the dev default. Proxy (Option C) deferred as a contingent vision.
- **Track P4-D** (MCP & Skills platform completion — the two 🔶 gaps): scoped + decisions locked 2026-06-13. P4D.2 OCI/Zot **foundation slice landed** (`OciBundleStore` + gated Zot Helm; runtime cutover deferred to a live-Zot slice). P4D.1 **brokering-model slice landed** (credential brokering-mode + custody validation + API/CLI + gated encryption-at-rest Helm; live OBO push/exchange parked). See Open Backlog → Track P4-D.
- **Track AIR** (AI model routing, selection & cost optimization): **scoped 2026-06-18** from the LiteLLM BYOK/BYOM + autonomous-router research (`litellm-byok-byom-research.md`, `litellm-router-autonomous-improvement-research.md`). Explicit / skill-pinned / opt-in-`auto` model selection, the BYOM model registry, and the shadow-mode measurement + nightly improvement loop that lowers token cost at equal quality. Locked: full AGPL (OpenRouter = inspiration only), no fee (meter only), no Enterprise license, BYOK at control-plane/ClusterTenant level (not per-openclaw-tenant), k8s-native secrets (GCP-SM + ESO + CMEK-by-default). GuardLLM verified **not** implemented (design-only). See Open Backlog → Track AIR.
- **Review discipline** (2026-06-13): the `review` agent (`.claude/agents/review.md`) now has a mandatory **"verify every finding before reporting"** step — re-trace the cited code and construct a concrete repro before asserting; unconfirmed concerns go under *Open questions*, not *Findings*. Added after a review surfaced a finding that did not survive verification.
- **Branch**: `phase-4-5-fixes`, 6 commits ahead of `main`.

---

## Open Backlog (Execute Next)

> **Canonical forward sequence = the S-series roadmap below (rebased 2026-06-25).** The
> silo-multi-tenant program runs FIRST (S1–S7, driven by `silo-multi-tenant-plan.md`); the
> independent leftovers follow (S8–S12). The lettered tracks further down (WOI/CONN/P4D/AIR/CT/…)
> are now **reference detail + landed history** — each open one is absorbed by an S-step, noted
> inline. Items marked **[BLOCKED]** need an external decision/dependency — do not guess.

### ▶ Forward roadmap (S-series — execute in order)

**Silo program (S1–S7) — full detail in `silo-multi-tenant-plan.md`.**
- **S1 — Demo-able shared tier + unblock login.** *(silo Phase 0)* trustedProxies auto-derive,
  preflight + `values.schema.json` guards, externalIp auto-derive + post-deploy verify,
  openclaw-schema CI test; **interim manual redirect-URI add so `elewa-be.dev.opencrane.ai/login`
  works**. Absorbs Go-Live → *DNS + ingress verification* (per-org-host path). No deps.
- **S2 — Enforcement floor: make isolation real.** *(silo Phase 1)* Enable Dataplane-V2/Cilium +
  default-deny baseline (cluster-lifecycle/Terraform, **not** Helm); per-silo egress NetworkPolicy.
  Absorbs Go-Live → *GCP installer smoke* (must now provision DV2 + Workload Identity, which also
  revives external-dns) and **CONN.8** remaining (cross-namespace wildcard-cert distribution + live
  ACME e2e — per-silo namespaces each need the cert). Dep: S1.
- **S3 — Zitadel as PDP system-of-record (control-plane controls Zitadel).** *(silo Phase 2a)*
  🟢 **IN REVIEW (PR #73 → strong-siloes):** schema (migration 0025), **live** `_HttpZitadelManagementClient`
  (jwt-bearer SA auth + create Org→project→roles→OIDC app→master-admin-grant + teardown, **validated
  against the live instance**), transactional CT create/delete wiring, no-op removed (Zitadel is a
  hard dependency; single-cluster mode unaffected), `infra/zitadel`. **PREREQ: SA needs instance
  `IAM_OWNER`.** 🔜 **remaining S3 slices:** `oidc.service` host→CT→client login refactor, member API
  + `oc cluster-tenant members`, reconcile/backfill, masters self-registration. Dep: S1.
- **S4 — Inheritance + scope-aware memory: the openclaw Tenant acts as its user.** *(silo Phase 2b)*
  Now broken into sub-slices:
  - **S4a [DONE — PR #77]** bind `Tenant.subject` + compile the contract over `{tenant, subject, groups}`
    (`compileForPrincipals`; Deny>Allow holds across principals).
  - **S4c.1 [DONE — PR #81]** sync the grant + dataset scope vocabularies (grants gain `team`, datasets
    gain `department`) so they map 1:1; migration 0029.
  - **S4c.2 [DONE — PR #82]** derive Cognee dataset memberships from the group expansion (**every tier
    IS a scope-typed `Group`**); diff-gated replace→Cognee sync on the contract poll; resource-group
    sharing (`/resource-shares` + `oc share resource`); added `DATASET_SCOPE_RETRIEVAL_PRECEDENCE`
    (Personal→Project→Team→Department→Org).
  - **S4d [DONE — PR #78]** inter-user tool/skill sharing API + `oc share` (least-privilege Grant).
  - **S4b [TODO]** mirror Zitadel groups → `Group.members` so groups are IdP-sourced, not hand-maintained.
    **BLOCKED on a decision:** Zitadel has no native group primitive — must decide the mapping (project
    roles vs user metadata vs org-level). The derivation works off manual groups until this lands.
  - **S4e [TODO] = P4B.7.2** the scope-aware Cognee retrieval plugin — the precedence cascade itself
    ("get here"); full Cognee design captured in **Track P4-B → P4B.7.2** below. Dep: S4c.2 (the
    derived memberships + precedence constant it consumes).
  **Absorbs P4B.7** (.1 session→scope binding LANDED; .2 retrieval plugin = S4e; .3 per-scope memory
  partitioning still its own sub-item). Dep: S3.
- **S5 — Identity loop + workload identity (SPIFFE/Cilium PEP).** *(silo Phase 2 identity loop)*
  SPIRE/Cilium identity wiring; operator provisions per-silo workload identities + identity
  policies; **super-admin identity issuance/rotation/audit (the crown jewel)**. **Absorbs CONN.4**
  (the CP-held operator device IS the super-admin cross-silo identity) and **CONN.5** remaining
  (adds identity-revocation + silo-level cut alongside the landed pod-delete). Deps: S2, S3.
- **S6 — Silo architecture: per-CT operator + per-CT planes + ADR.** *(silo Phase 3)* ADR
  `task_5164276f` (substrate; which planes move into the silo; per-CT operator; **per-CT API + DB**
  that retires the resolution-ambiguity class — PR #68 is the interim shim). Decides placement that
  gates S8/S9/S10. **Subsumes CONN.7** (a mesh substrate makes its per-session-cut/per-frame-audit
  vision a mesh feature). Deps: S2, S5.
- **S7 — Tiers & cost.** *(silo Phase 4)* Map `isolationTier` shared → dedicatedNodes →
  dedicatedCluster (vcluster/Kamaji); cost/footprint model per tier. Dep: S6.

**Independent leftovers (S8–S12) — re-sequenced after the silo program.**

- **S8 — Obot downstream-credential brokering.** *(P4D.1)* The silo work **unblocks the hard part**:
  S4 `Tenant.subject` makes per-user real, S5 SPIFFE→OIDC exchange propagates the human identity to
  Obot's shim, S6 moves Obot into the silo. Then build the parked push-to-Obot OBO config surface +
  enc-at-rest + live round-trip. Deps: S4, S5, S6.
- **S9 — Zot digest-pinned skill-bundle storage.** *(P4D.2)* Placement (shared vs per-silo) decided
  in the S6 ADR; the digest-pull egress must be an explicit allow in the default-deny silo policy.
  Build: deploy Zot, push bundles by digest, fetch-by-digest, drop `SkillBundle.content`. Dep: S6.
- **S10 — Provider-secret cutover. [BLOCKED]** *(AIR.0c)* Remove the `org-shared-secrets` `envFrom`
  broadcast (a cross-silo secret leak the silo model forbids) + retire orphaned `ProviderApiKey`.
  Silo strengthens the rationale and S6 per-CT LiteLLM makes keys silo-scoped, **but stays blocked**
  on the OpenClaw translator-backend image change + WeOwnAI off the legacy endpoint.
- **S11 — Fixed-model savings evaluator. (FUTURE)** *(AIR.8)* Advisory WeOwnAI view; in-repo enablers
  done; per-CT-scoped. Low silo impact (data source shifts only if LiteLLM/Langfuse go per-silo).
- **S12 — Safety / guardrail stream. (FUTURE)** *(AIR.9)* Adopt an OSS guardrail service when needed;
  placement (per-silo vs main-network egress) follows the S6 substrate. No such service exists today.

---

### Reference detail — open-item bodies + landed history (indexed by the S-series above)

### Track WOI — WeOwnAI control-plane integration (frontend cutover dependencies)

Raised 2026-06-15 by the WeOwnAI frontend (proprietary control-plane UI). Its mock→live cutover
(WeOwnAI `plan.md` → Track LIVE) is blocked on two control-plane **API** gaps; both are small,
additive, and generic (no vendor specifics — they don't touch the provisioner seam or the AGPL
isolation model).

- [x] **WOI.1 — Emit identity claims on `/api/v1/auth/me`. — LANDED 2026-06-16.** `/auth/me` now
  surfaces the caller's **groups**, a derived **`isPlatformOperator`** flag, and their **`clusterTenant`**,
  so a federated frontend authorizes without guessing. The API stays the enforcement point — these are
  introspection-only facts the SPA uses to *hide* UI, never to grant access. Two distinct trust paths:
  `groups`/`isPlatformOperator` come from the OIDC session (resolved at login by the pure, testable
  `_ResolveIdentityClaims`: operator iff the groups/roles claims intersect `OPENCRANE_PLATFORM_OPERATOR_GROUPS`,
  fail-closed when unset); `clusterTenant` is resolved **fresh server-side** from the IdP-verified
  email → tenant → `clusterTenantRef` (WOI.2), never from a self-asserted claim, and is null when
  unresolved/ambiguous. `isPlatformOperator` is a non-presumptuous stopgap until a first-class role model
  exists. **Landed:** prisma-injected async `getStatus` + `_resolveClusterTenant` + `_ResolveIdentityClaims`
  (`infra/auth/oidc.service.ts`), config loader fields (`oidc.config*.ts`), session type, `/auth/me` schema
  (also fixed the stale `mode` enum to `development|oidc|token`). Unit test `oidc-identity-claims.test.ts`.
  _Ties to WeOwnAI LIVE.4._
- [x] **WOI.2 — Expose `clusterTenantRef` on the Tenant API + a server-side filter. — LANDED 2026-06-16.**
  Projected the Tenant CRD's `spec.clusterTenantRef` (CT.4) into the SQL read model (migration 0016 +
  Prisma column), dual-write it on create/update (CRD spec + DB), surface it in the list/get responses,
  and added the `GET /tenants?clusterTenantRef=<name>` server-side filter — so WeOwnAI drops the
  `team` → ref client-side stopgap. **Landed:** `routes/tenants.ts`, `types.ts`, `openapi/spec.ts`,
  `prisma/schema.prisma` + `0016_tenant_cluster_tenant_ref`, regenerated `libs/contracts`. Tests in
  `tenants.test.ts`. _Ties to WeOwnAI LIVE.3._
- [x] **WOI.3 — Give the ClusterTenant update body a real schema. — LANDED 2026-06-16.** Replaced the
  open-object `PUT /api/v1/cluster-tenants/{name}` body with a `ClusterTenantUpdate` component
  (all-optional displayName/baseDomain/isolationTier/compute/resources, name from the path), so the
  generated client types the body properly instead of `Record<string, never>`. **Landed:**
  `openapi/spec.ts`, regenerated `libs/contracts`. _Ties to WeOwnAI LIVE.2._
- [x] **WOI.5 — Per-cluster platform-operator seed + Zitadel pinning. — LANDED 2026-06-21.**
  Closed the bootstrap gap left by WOI.1: a fresh cluster had no way to designate its first platform
  operator before an IdP group mapping existed (`OPENCRANE_PLATFORM_OPERATOR_GROUPS` empty ⇒ nobody,
  fail-closed). Added `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL` (empty default) — a caller whose
  **verified** email equals the seed (case-insensitive, trimmed) is a platform operator, **OR-ed**
  with the existing group check (seed OR group ⇒ operator). Empty seed grants operator to nobody; an
  unverified email never matches. The seed is a **per-cluster INSTALL parameter** — never hardcoded.
  **Landed:** loader + types (`oidc.config*.ts`), seed match in the pure `_ResolveIdentityClaims`
  (`infra/auth/oidc.service.ts`), verified-email passthrough in `_buildAuthUser`; Entra/Google comments
  re-pointed to **Zitadel as the single trusted issuer (Mode-2 broker, no upstream Entra)**. Helm:
  `controlPlane.oidc.*` values block + the previously-missing OIDC container env (gated on `issuerUrl`;
  seed rendered only when set). Install: wizard step + `k8s-deploy.sh`/`k3d-local.sh` passthrough
  (`--platform-operator-seed-email` / env, `--set` only when non-empty). Docs: `website/security/identity.md`
  (Zitadel/no-Entra + claim names + seed config). Tests: `oidc-identity-claims.test.ts` (empty/match/
  case+whitespace/non-match/unverified/additive), `oidc-config.test.ts` (empty default + normalisation).

**Track WOI complete (2026-06-21).** WeOwnAI can re-sync the spec (its LIVE.8) and drop the three stopgaps; a fresh cluster can now seed its first platform operator at install (WOI.5).

### Track ORG-ADMIN — Organisation creation, billing gate & membership-derived admin — LANDED 2026-06-21

Closed the org-creation authz + ownership gaps the WOI fact-check surfaced: `POST /cluster-tenants` was an
unguarded, persist-only shell with no owner and a flat global `isOrgAdmin`. Now a normal authenticated user
creates a billing account, then creates an org and becomes its root admin.
- **Schema (`migrations/0023_org_admin_billing`):** `BillingAccount` (keyed to the OIDC subject) + `OrgMembership`
  `{clusterTenant, subject, role: owner|admin|member}` with one-owner-per-org uniqueness.
- **Billing:** `POST /api/v1/billing-accounts` (idempotent per subject).
- **Create flow:** the caller is recorded as the org's single `owner` in the SAME `$transaction` as the
  ClusterTenant row — atomic root-admin assignment.
- **Guards:** create requires an authenticated session WITH a billing account (a user becomes admin BY creating,
  so create cannot require pre-existing org-admin — chicken-and-egg); read + destructive ops require
  platform-operator OR owner/admin membership of the named org. Anonymous ⇒ 401 in real deployments (fail-closed;
  the dev-mode bypass posture is unchanged).
- **Derivation:** `isOrgAdmin` + the caller's `ownedOrgs` are derived from `OrgMembership` (per-org) and surfaced
  on `/auth/me` (additive — existing `isOrgAdmin`/`clusterTenant` fields unchanged so WeOwnAI keeps working). The
  platform-operator seed path stays intact + fail-closed.
- **Cluster-tenants operator track — CLOSED by PR #50:** create persists `pending` and the DB→K8s bridge
  projects a `clustertenants` CR; the operator's ClusterTenant reconciler now drives `pending → ready` and
  calls the real per-org domain provisioner (see Track DOMAIN → PR #50).
- Tests: billing-account create, create-records-owner, the full guard matrix, membership-derived `isOrgAdmin`
  (+20; control-plane suite 407 green).

### Track INSTALL — Complete deploy (one-command install over a shared core) — LANDED 2026-06-22 (PR #52)

A guided, fail-fast install that brings a fresh cluster up end-to-end, with two thin profile
scripts over one shared core (`platform/k8s-deploy.sh`) so the profiles cannot diverge.
- **Bundled cluster singletons (default ON, auto-skip if present, `*.install` flag SEPARATE from the
  chart's `*.enabled`):** ingress-nginx, **external-dns** (acme mode; `--source=crd` → Cloud DNS, scoped
  to `--base-domain`), and Cognee (in-chart). cert-manager Step 2.5 has three modes — off / selfSigned /
  acme(DNS-01) — with a DNS-01 preflight that fails fast.
- **Shared zone-write identity:** external-dns + the cert-manager DNS-01 solver share ONE `roles/dns.admin`
  Workload-Identity GSA (or one `--dns01-credentials` SA key) — no second binding.
- **Terraform aligned to external-dns:** `modules/dns` provisions the zone + install-time platform records +
  the shared WI binding; per-org/per-host records are runtime (external-dns), never Terraform (the
  `org_wildcards` direct-record path removed). Static ingress IP stays in `app-deploy`.
- **`--preflight`:** read-only, fail-fast core check — default StorageClass, NetworkPolicy-enforcing CNI,
  first-party image pullability, registrar NS-delegation for `--base-domain`, and the DNS-write capability
  shared by external-dns + cert-manager. Exits before any cluster mutation.
- **Fixes:** the installer now CREATES the OIDC secret (client + auto-generated session secret) and wires
  `controlPlane.oidc.existingSecret` (previously assumed to exist → crash-loop); the missing
  `<fullname>-external-secrets` ServiceAccount the SecretStore's WI ref points at is rendered in-chart; the
  dead `sharedSkills.pvc.storageClass` Terraform set removed; a stale ClusterTenant-seed import path fixed.
- Validation: operator (155) + control-plane (411) suites green; `helm template` for both profiles clean;
  tsc/lint clean. `--dry-run=server` for both profiles prepared in the PR (shared cluster is READ-ONLY).

### Track DOMAIN — Fixed wildcard + CNAME domain topology — LANDED 2026-06-22

Replaced the "each customer brings their own domain + delegated DNS-01" model with a **fixed-wildcard
topology**: ONE platform org-wildcard base + a fixed super-operator/control-plane host; orgs are derived at
`<org>.<base>`, users at `<user>.<org>.<base>`; customers optionally CNAME a vanity domain onto `<org>.<base>`.
Stacked on `feat/org-admin-billing`.
- **Chart values:** `ingress.controlPlaneHost` (fixed super-operator host, defaults `platform.<base>`,
  distinct from the wildcard) + `ingress.domain` reframed as the platform org-wildcard base.
  `control-plane-ingress.yaml` serves the fixed host; the platform `Certificate` SANs are
  `*.<base>` + apex + control-plane host (operator/control-plane deployment templates untouched to keep merges trivial).
- **Host derivation:** `_BuildOrgDomain`/`_BuildUserHost`/`_BuildOrgWildcard` in `libs/contracts`
  (`domain-topology.types.ts`); operator `_ResolveOrgServingDomain` derives `<user>.<org>.<base>` with the
  vanity domain as an overlay (ref-less openclaws unchanged at `<user>.<base>`).
- **Schema:** ClusterTenant `base_domain` → `vanity_domain` (`migrations/0024`), repurposed as the optional
  CNAME overlay; mirrored through contracts, openapi, CLI (`--vanity-domain`), and the CRD.
- **Multi-level wildcard TLS (decided):** `*.<base>` covers org apexes but NOT `<user>.<org>.<base>` (a
  wildcard matches one label) → a **per-org** `*.<org>.<base>` `Certificate` issued at org-provision via
  cert-manager DNS-01 (reference manifest `platform/helm/examples/per-org-wildcard-cert.yaml`).
- **DNS automation (aligned to external-dns):** `modules/dns` provisions the zone + the install-time
  platform records (apex, `*.<base>`, control-plane host) + the shared `roles/dns.admin` Workload-Identity
  binding that external-dns and the cert-manager DNS-01 solver impersonate. **Per-org/per-host records are
  NOT written by Terraform** — external-dns reconciles them at runtime from the operator's `DNSEndpoint` CRs
  (the old `var.org_wildcards` direct-record path is removed). The install scripts bundle external-dns as a
  value-gated cluster singleton (`externalDns.install`, default ON in acme mode, `--no-external-dns` to BYO).
- **Per-org provisioning — IMPLEMENTED (operator-owned, PR #50):** `DefaultOrgDomainProvisioner`
  (`apps/operator/src/cluster-tenants/internal/org-domain.provisioner.ts`) behind the `OrgDomainProvisioner`
  interface. It applies the per-org wildcard `Certificate` (`*.<org>.<base>` + apex/vanity SANs) via
  cert-manager DNS-01 (`CertManagerClient` over the custom-objects API) and declares the
  `*.<org>.<base>`/`<org>.<base>` A records as a namespaced external-dns `DNSEndpoint` CR
  (`externaldns.k8s.io/v1alpha1`, `DnsEndpointClient` over the custom-objects API), which the external-dns
  controller reconciles into the platform's DNS provider — no cloud SDK (see DOMAIN.T1). Both side effects
  idempotent. **Fail-closed + runtime-gated by real capability detection:** an absent cert-manager/DNSEndpoint
  CRD short-circuits fail-closed and reports a skip — never crashes — while the resource-authoring path stays
  real (the manifests are genuinely built and applied, not no-op stubs). Wired by `_BuildOrgDomainProvisioner`
  from operator config; the create path never mutates DNS/cert-manager — only the reconciler (in the operator)
  does (fail-closed, API-first).
- **Docs:** `docs/agents/cluster-architecture.md` + `website/operators/dns-config.md` rewritten to the new
  topology with the exact customer CNAME instruction.
- **PR #50 (org-provision-wiring) — LANDED:** the ClusterTenant reconciler (`apps/operator/src/cluster-tenants/operator.ts`)
  now CALLS the real `provisionOrgDomain(...)` on every reconcile. The dead control-plane copies of the
  provisioner/cert/DNS clients (never invoked there) and the hardcoded always-skip `GatedOrgDomainProvisioner`
  stub were deleted; the one real provisioner is owned by the operator (the reconciler/executor). Helm wires
  `INGRESS_IP`/`CERT_MANAGER_ISSUER_*` + RBAC: `certManager.enabled` gates the operator's `certificates` RBAC
  and `externalDns.enabled` gates its `dnsendpoints` RBAC (see DOMAIN.T1). Live cert/DNS apply remains the
  batched human-authorised step (cert-manager is not installed on the shared dev cluster) — prepared, not
  executed.
- Validation: `helm template` (operator + RBAC) green; operator (155; +provisioner/cert/DNS/gating unit
  tests), control-plane (407) suites green; touched-package build + lint clean.

#### Follow-ups
- **DOMAIN.T1 — k8s-native DNS instead of the direct GCP binding — DONE.** Replaced the imperative
  `CloudDnsClient` (`@google-cloud/dns`) with a declarative `DnsEndpointClient`: the operator's ClusterTenant
  reconciler now declares the per-org `*.<org>.<base>` + apex A records as an external-dns `DNSEndpoint` CR
  (`externaldns.k8s.io/v1alpha1`) in the org's bound namespace, and the external-dns controller reconciles them
  into whatever provider the platform runs. The operator carries NO cloud SDK (the `@google-cloud/dns` optional
  dep is removed). Same fail-closed posture as cert-manager: an absent DNSEndpoint CRD → `applied:false` skip,
  never a crash. Helm: `externalDns.enabled` gates the operator's `dnsendpoints` RBAC; `DNS_MANAGED_ZONE` env +
  `ingress.dnsManagedZone` value removed. external-dns is a prerequisite (install with `--source=crd`), like
  cert-manager. The k8s-error classification (`_IsCrdAbsent`/`_IsConflict`/`_IsNotFound`) was extracted to a
  shared `k8s-api-errors.ts` used by both the cert-manager and DNSEndpoint clients.
- **DOMAIN.T2 — wire org-domain teardown on ClusterTenant delete — DONE.** The reconciler's `Deleted` case now
  invokes `OrgDomainProvisioner.deprovisionOrgDomain(...)` (deletes the per-org `Certificate` + external-dns
  `DNSEndpoint` so external-dns reaps the records it owns). The bound namespace is re-derived deterministically
  (`opencrane-<name>`) so delete never depends on `status` being present; the call is idempotent and fail-soft
  (errors logged, not re-thrown — namespace GC is the backstop). +3 operator tests (suite 158).
- **DOMAIN.T3 — collapse the now-vestigial control-plane provisioner runtime paths — DONE.** The operator owns
  provisioning, so the control-plane `ClusterTenantProvisioner` interface + its `SharedClusterProvisioner` /
  `ExternalWebhookProvisioner` implementations (all `provision()`/`getStatus()`/`deprovision()` dead at runtime)
  and the unused `provisionerFor` registry method were deleted. The registry is now a pure tier-availability gate
  carrying `{ id, tiers }` entries — `isTierAvailable` + `capabilities` only (the live callers). `dedicatedCluster`
  gating + the HTTPS-only webhook-config validation are preserved (`_ReadExternalWebhookConfig`). Contracts lib
  unchanged (its `ClusterTenantProvisionerRegistry` was already minimal). `provisioner.test.ts` → `registry.test.ts`.
- **DOMAIN.T4 — collapse per-user subdomains to a single per-org host with an identity-routing proxy —
  PARTIALLY LANDED (service + endpoint built & gated; ingress cutover remains).** Landed this slice: the new
  `@opencrane/gateway-proxy` app (thin, logic-free WS reverse proxy: Origin/CSWSH allowlist → delegated auth →
  per-identity rate limit → forward to `openclaw-<user>.<ns>.svc`), the control-plane
  `GET /api/v1/auth/gateway-resolve` routing authority (fail-closed email→tenant; 403 on no/ambiguous), Helm
  deployment+service gated behind `gatewayProxy.enabled` (off; `automountServiceAccountToken:false`, no RBAC —
  it never touches the k8s API), the CI image build, and §0.1 of connection-security.md. 19 proxy tests + 7
  gateway-resolve tests. **STILL TO DO (the cutover, its own slice):** one per-org Ingress that path-routes
  `/api`/UI/gateway-WS; retire the operator's per-user Ingress + per-user DNS/cert minting; confirm the OIDC
  redirect-URI allowlist accepts per-org hosts; flip `gatewayProxy.enabled` per install. Until then routing
  stays per-user-subdomain and the proxy is dormant.
  **Decisions LOCKED (2026-06):** (a) **per-org host** `company.opencrane.ai` (preserves cross-org origin
  isolation + vanity CNAMEs; one DNS record + one **HTTP-01** cert per org → no wildcard, no DNS-01, no
  cert-manager zone access — supersedes the wildcard parts of T1); (b) **same-origin** — the app UI, `/api/*`,
  and the gateway WS are ALL served under that one host, so the browser is same-origin (no CORS) and the OIDC
  session cookie is **host-scoped** to it (no parent-domain cross-org leak). The only external CNAME a customer
  needs is `company.opencrane.ai` (or vanity → it).
  - **Prerequisite (DONE):** CONN.10 per-pod owner pinning (`allowUsers`), so the pod self-enforces its owner
    regardless of routing — without it, identity-routing would be the *only* cross-tenant guard.
  - **New component — identity-routing WS proxy (DONE)** on the per-org host. On a gateway WS upgrade it calls a new
    control-plane endpoint `GET /auth/gateway-resolve` (verify session → return `{ user, tenant, podService }`,
    reusing the existing fail-closed email→tenant resolution; **403** if no/ambiguous tenant), validates the
    `Origin` header against the same-origin host (CSWSH guard — CORS does NOT cover WS), then reverse-proxies
    to `openclaw-<user>.<ns>.svc`. The proxy holds NO session logic — the control-plane stays the auth
    authority (delegate-auth pattern, like today's nginx `auth_request`). This avoids sharing the express
    session store across services.
  - **Ingress (REMAINS):** one per-org Ingress for `company.opencrane.ai` — path-route `/api/*`→control-plane, UI→
    frontend, gateway WS→the proxy. The operator STOPS minting per-user Ingresses + per-user DNS/cert.
  - **OIDC (REMAINS):** login/callback/session now happen on the per-org host (host-scoped cookie). Confirm the OIDC
    redirect-URI handling supports per-org hosts (multi-host redirect allowlist) before cutover.
  - **Security controls (DONE):** Origin allowlist on the WS upgrade (CSWSH, fail-closed); proxy is a thin,
    logic-free, heavily-logged choke point; per-identity rate limits live in the proxy. Cross-tenant safety rests
    on CONN.10 (pod-level) + the proxy's `gateway-resolve` (routing-level) — defence in depth. (Host-scoped cookie
    lands with the ingress/OIDC cutover above.)
  - **Docs (DONE):** `website/security/connection-security.md` §0.1 documents the proxy + Origin controls +
    delegated-auth flow + cutover status.

### Track P5 — Close Phase 5 — ✅ COMPLETE · full history: plan-done.md § Completed Tracks (archived 2026-06-15)

### Track P4-A — Finish Phase 4 runtime-plane enforcement gaps — ✅ COMPLETE · full history: plan-done.md § Completed Tracks (archived 2026-06-15)

### Track P4-B — Fleet Organizational Awareness (STARTED — only P4B.7 remains)

> Decision-unblocked (P4B.0 locked). **P4B.1–P4B.6 landed 2026-06-13/14** (collapsed below; full
> per-item detail in **plan-done.md § Active-track landed detail**). **P4B.7** (anti-spill scope
> binding) is the last item — component 1 (CP session→scope binding API + CLI) landed; components
> 2 (plugin) & 3 (memory partitioning) remain, blocked on the two live seams in the item.

- [x] **P4B.0–P4B.6 landed** (2026-06-13/14) — awareness decisions locked; `@opencrane/awareness`
  SDK (direct-Cognee retrieval, mandatory citations, pinned contract version); AccessPolicy→Cognee
  grant compiler (best-effort, Postgres = source of truth); contract versioning + canary rollout
  across `personal→project→department→org` with one-step rollback (API + `oc`); golden-query eval
  harness + rollout gate (zero policy-violations = hard gate); fleet participation protocol +
  monitoring (API + `oc`); awareness SLO metrics + Grafana dashboard + PrometheusRule alerts.
  **Shared live seam:** wiring the SDK into the live OpenClaw pod runtime + Cognee `/v1/search`.
  Full per-item detail: **plan-done.md → "Active-track landed detail (archived 2026-06-15)"**.

- [ ] **P4B.7 Scope-aware retrieval plugin + session→scope binding (anti-spill).** Stop project
  context from spilling across chat windows. A chat window is an OpenClaw `sessionKey` multiplexed
  over one wss connection / one device identity / one pod principal — so nothing in the transport or
  identity layer distinguishes windows (see [[reference_openclaw_gateway_protocol]]). Bind scope at
  the `sessionKey` level instead, governed by the control-plane **API** (CLI-first: `oc` and the
  WeOwnAI frontend are both clients of the same endpoint — the API is the source of truth, never a
  frontend-only path). Components:
  1. **[x] CP session→scope binding (API + CLI). — LANDED 2026-06-14.** New `SessionScope` registry +
     endpoint (`PUT/GET/DELETE /api/v1/sessions/:sessionKey/scope`, OpenAPI-spec'd so contracts/CLI
     types regenerate) + `oc sessions scope set|show|clear` command. The CP **intersects the requested
     scope with the caller's compiled entitlements** (P4B.2) so a client can never over-scope beyond
     what grants allow — the frontend/CLI *propose*, the CP *authorises*.
     **Landed:** pure `_IntersectSessionScope` (allow-set from compiled awareness decisions;
     deny/absent → rejected; granted selector adopts the *authoritative* grant scope, never the
     client-claimed one → no scope-spoofing) + `_NormalizeScopeSelectors`
     (`core/sessions/session-scope.ts`); `_BindSessionScope`/`_GetSessionScope`/`_ClearSessionScope`
     store (`session-scope-store.ts`); `SessionScope` Prisma model + migration `0012_session_scope`
     (no Tenant FK — principal may be a user); router (`routes/sessions.ts`, mounted
     `/api/v1/sessions`) — PUT stores the granted subset + reports `rejected`, **403 OVER_SCOPE** when
     nothing is entitled, GET 404s when unbound, DELETE idempotent; OpenAPI `SessionScope` +
     `ScopeSelector` schemas; `oc sessions scope set|show|clear` (`--scope level:payloadId`,
     repeatable). Tests: 4 pure intersection + 4 route = 8 (170 total green).
     **Seam:** binding identity (`principal`) is supplied in the body on this admin/frontend control
     surface (consistent with the rest of `/api/v1`); the *runtime* tenant-identity binding is the
     plugin's job (component 2), which reads the live `sessionKey`.
  2. **[ ] Scope-aware OpenClaw retrieval plugin (= S4e).** Replace the stock single-dataset Cognee plugin
     (which is `datasetName`-singular, dataset-wide, no scope filtering — confirmed via
     docs.cognee.ai/integrations/openclaw-integration) with a plugin wrapping `@opencrane/awareness`:
     per turn it resolves the active `sessionKey`→scope binding (cached; via CP API or contract
     re-pull) and restricts the Cognee query to those datasets, so other-project context is **never
     retrieved or auto-injected**. Requires extending the P4B.1 SDK with a `ScopeContext` +
     most-specific-wins/deny-overrides merge across the active levels.
     **Cognee retrieval design (researched 2026-06-25 — docs.cognee.ai):** scope precedence is **NOT a
     Cognee setting**. Cognee exposes `datasets`/`dataset_ids`, `node_set`/`node_name` (graph tags),
     `top_k`, and the search types — but **no per-scope weighting and no exposed similarity score** for
     the GRAPH_COMPLETION family. **Do NOT bake scope into the embedding** (keep vectors pure semantic);
     scope is a partition/filter/re-rank dimension applied *around* the vector search. Realise precedence
     in OUR layer over `DATASET_SCOPE_RETRIEVAL_PRECEDENCE` (Personal=self/session → Project → Team →
     Department → Org; most→least relevant):
       - **Pattern A — cascade (start here):** query the most-specific scope first, widen to broader
         scopes only to fill remaining `top_k`. Deterministic; needs no score; broad-scope context strictly
         trails. Encodes the precedence by construction.
       - **Pattern B — parallel + weighted re-rank (upgrade):** fetch candidates with `only_context=true`/
         `CHUNKS`, tag each by source scope, re-rank by `similarity × scope_weight` (Personal 1.0 → Org 0.2),
         then synthesise. Interleaves broad context by relevance instead of trailing it.
     - **Ingestion change (small, in harvesting-agent `_PushDocumentToCognee`):** also pass
       `node_set=[scope, \`${scope}:${subject}\`]` so scope is a first-class, filterable graph tag (today
       only `metadata.scope` + the `<scope>/<subject>` dataset name are set).
     - **Isolation stays on the `/v1/permissions` ACL we sync, NOT the `datasets=` param** — the param
       leaks across datasets (topoteretes/cognee#1023); datasets/node_set are the relevance/partition layer.
  3. **[ ] (Separate vector) per-scope memory partitioning.** Scoped retrieval stops *knowledge-base*
     spill; the pod-global L2 `MEMORY.md` + any cross-session summarisation are a second vector
     (window A's written notes readable by window B). Partition written memory per scope — track as
     its own sub-item.
  - **Guarantee level:** advisory/hygiene by default (other context isn't *retrieved*; the agent is
    still *entitled* to it). A **hard** boundary (Cognee refuses out-of-scope datasets for the
    session) is an optional upgrade via a CP-minted **per-`sessionKey` scoped Cognee credential** —
    build only if need-to-know/compliance/delegation demands it.
  - **Prerequisites / verifications:** P4B.2 (grants bound the allowed scope set) · the **OpenClaw
    plugin API** can read the live `sessionKey` + (ideally) client-set session metadata — verify
    against the OpenClaw plugin SDK; if metadata pass-through exists, the frontend can stamp scope at
    session-create and skip the per-window CP call · **Cognee per-token scope-subsetting** — only
    needed for the hard-boundary upgrade; verify against the live Cognee version.
  - **Acceptance:** a window bound to project X retrieves/injects only X-entitled scopes (org/dept/X/
    personal), never another project's; the binding is settable + inspectable via `oc` and the API;
    over-scoping beyond entitlements is rejected by the CP; covered by tests (binding intersect +
    plugin dataset-scoping). Anchors: control-plane `routes/`, `openapi/spec.ts`, `apps/cli`,
    `libs/awareness`, the OpenClaw plugin package. Depends on P4B.1 (done) + P4B.2.

### Track P4-C — Agent Identity & Personalisation — ✅ COMPLETE · full history: plan-done.md § Completed Tracks (archived 2026-06-15)

### Track CONN — OpenClaw connection auth & session security (Option B)

> Scoped 2026-06-13. How the SaaS-operator browser reaches a tenant's OpenClaw pod gateway,
> brokered by the control plane. **Posture = Option B** — short-lived re-brokered credentials (no
> long-lived browser token) + a per-user central kill-switch + transport hardening; the control
> plane stays *connection*-stateless. Full threat model + trade-offs in
> `website/security/connection-security.md`. Full landed-item detail: **plan-done.md → "Active-track
> landed detail (archived 2026-06-15)"**.

- [x] **CONN.1 Pairing-broker endpoint** — `POST /auth/pod-token` returns the pod pairing link
  (`gatewayUrl`/`bootstrapToken`/`tenant`/`ingressHost`); fail-closed email→tenant resolution. Landed.
- [x] **CONN.2 Transport hardening** — HSTS, prod-forced `Secure` cookies, `wss://`-only broker guard,
  opt-in HTTP→HTTPS redirect. Landed. (`__Host-` cookie prefix deferred to CONN.6 doc review.)
- [~] **CONN.3 Pairing-link provisioning + short bootstrap.** **Superseded by trusted-proxy (CONN.9 / #48).**
  The bootstrap-token pairing model is no longer the connection method; the gateway authenticates via
  the ingress `auth_request` trusted-proxy header, so no per-pod `bootstrapToken` is minted or stored.
  The operator-side decode half (`_ParseOpenClawSetupCode` + `openclaw-pairing-provision.*`) and the
  control-plane `bootstrapToken` machinery (the `routes/tenants.ts` strip-guard + the legacy-token test
  scaffolding) have all been **removed** — no live cluster holds a stored token, so the defensive strip
  is unnecessary. `PUT /:name/pairing` now stores only the `wss://` gateway URL; `_ResolveOpenClawPairing`
  and the `/auth/pod-token` broker resolve the connection coordinate (URL only), never a token.
- [ ] **CONN.4 CP-held operator device + device registry.** *Device-registry half landed*
  (`BrokeredDevice` model + `0008` migration; every `/auth/pod-token` broker upserts a row). **B1
  device-signature fully resolved** — Ed25519 (NOT ECDSA-P256), byte-exact against `openclaw@2026.6.6`
  (`deviceId=sha256(pubkey)`, pipe-joined v3 payload, base64url). **Remaining (live seam):** the
  CP-held `operator.pairing` device (paired server-side, key in a Secret) + the Ed25519 signer —
  needs a live gateway. Prereq for CONN.5's re-auth-block half.
- [ ] **CONN.5 "Cut tenant" kill-switch + RBAC.** *Landed:* `_CutTenant` (gateway revoke best-effort →
  registry revoke → **K8s pod `deletecollection` by `opencrane.io/tenant` label**, CNI-independent);
  admin `POST /api/v1/tenants/:name/cut` + self-serve `…/auth/pod-token/cut`; control-plane pods RBAC.
  **Remaining:** the gateway-revoke half is `_NoopGatewayAdmin` until a CP operator device is paired
  (CONN.4 live seam) — pod-delete already severs live sockets, so only the *re-auth-block* defers.
- [x] **CONN.6 Rewrite `website/security/identity.md` for the pairing broker** — replaced the stale `aud=openclaw`
  SA-token/RFC-8693 description with the pairing-link broker + `connect` handshake. Landed (docs only).
- [ ] **CONN.7 Proxy (Option C) — contingent vision.** **[DEFERRED]** Envoy/mesh WebSocket proxy for
  per-session cut + per-frame audit + zero browser credential. Revisit only if a hard per-session /
  per-frame requirement emerges **and** the connection-stateful cost (LB affinity, reconnect storms,
  content transiting the CP) is judged worth it. CONN.1–CONN.5 are prerequisites, so nothing is wasted.
- [ ] **CONN.8 TLS issuance for tenant ingress (wildcard, k8s-native).** Use **cert-manager + ACME
  DNS-01** for one `*.<domain>` (+apex) cert so new tenants need zero new issuance. *Landed:* operator
  config-gated `tls:` block (`5-ingress.ts`); Helm `cluster-issuer.yaml` (selfSigned dev / acme DNS-01
  prod) + wildcard `Certificate`; onboarding `PUT/GET /api/v1/platform/dns` + `oc platform dns set|show`
  (least-priv RBAC: cluster `clusterissuers` + namespaced cert-manager secret Role; token never on
  argv/echoed); dev `sslip.io` self-signed wildcard for k3d. **Remaining:** (b) cross-namespace cert
  distribution if tenants run outside the Certificate's namespace; (d) **live ACME e2e** (needs a
  cluster + real DNS — the unverified seam). Single-label-tenant-name / host-only-cookie /
  delegated-subzone constraints: see plan-done.md. Anchors: `5-ingress.ts`, `values.yaml`,
  `cluster-issuer.yaml`, `core/platform-dns/`, `apps/cli/src/commands/platform.ts`.
- [x] **CONN.10 Per-pod owner pinning (cross-tenant gateway guard).** trusted-proxy mode (CONN.9)
  trusts whatever identity the proxy injects, and `gateway-verify` only checks that *a* session exists
  — it does NOT bind the session to the host's tenant, and the pod had no owner allowlist. So any
  authenticated user who reached another tenant's pod (guessable `<user>.<org>.<base>` host) was
  accepted as themselves, with access to that pod's mounted secrets / MCP connections / model keys.
  *Fixed:* the operator renders `gateway.auth.trustedProxy.allowUsers: [<owner email>]` into each
  tenant's `openclaw.json` (`2-config-map.ts`), normalised `trim().toLowerCase()` to match the email
  `gateway-verify` injects, so the gateway rejects any non-owner `X-Forwarded-User`. Ownership is now
  enforced **server-side at the pod**, independent of routing — the prerequisite that makes collapsing
  per-user subdomains safe (see Track DOMAIN). Docs: `website/security/connection-security.md` §0.
  **Verify:** confirm `trustedProxy.allowUsers` is honoured by the pinned OpenClaw image (v0.23.1); if
  not, bump the pin or fall back to a host→tenant check in `gateway-verify`.

- [x] **CONN.9 Trusted-proxy connection model pinned (fail-closed).** Product accepted trusted-proxy;
  single-use tokens are **not** re-introduced. The operator now parses `GATEWAY_TRUSTED_PROXIES`
  fail-closed (`apps/operator/src/trusted-proxies.ts`): **empty ⇒ trust nothing** (never the ambiguous
  trust-all) surfaced as `config.gatewayTrustNothing`, a CIDR/IP allowlist when configured, and a
  **malformed entry crashes config load** rather than silently shifting the trust boundary. The tenant
  ConfigMap renders both the empty allowlist *and* an explicit `gateway.auth.trustedProxy.trustNothing`
  marker so the runtime can't read `[]` as trust-all. Helm-values-driven (`tenant.gateway.trustedProxies`,
  empty default in `values.yaml`); dev default set to the weownai-dev cluster pod CIDR `10.55.128.0/17`
  (discovered read-only: GKE `clusterIpv4Cidr` + ingress-nginx pod `10.55.128.156`) in
  `values/gke-dev.yaml`. **Confirmed read-only on weownai-dev:** suspended UserTenant `alex` renders
  `auth.mode=trusted-proxy` + `userHeader=X-Forwarded-User`, its gateway NetworkPolicy locks port 18789
  to the `ingress-nginx` namespace, and its Ingress carries `auth-url → /api/v1/auth/gateway-verify` +
  `auth-response-headers: X-Forwarded-User`. **Remaining (live seam):** the end-to-end auth_request →
  204 + header → pod-accepts-identity handshake needs one additive test pod (prepared, authorization-gated,
  in the PR). Anchors: `apps/operator/src/{trusted-proxies.ts,config.ts}`, `tenants/deploy/2-config-map.ts`,
  `platform/helm/{values.yaml,values/gke-dev.yaml,templates/operator-deployment.yaml}`.


### Track P4-D — MCP & Skills platform completion (the two 🔶 gaps)

> Scoped 2026-06-13. Closes the two known runtime-plane gaps from `website/integrators/mcp-gateway.md` and
> `website/integrators/skill-registry.md`. Custody/substrate decisions are **locked** (Phase 4
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
  and no downstream MCP credentials are brokered — the 🔶 in `website/integrators/mcp-gateway.md`. Custody is
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
  - **Landed (2026-06-14, headless brokering-model slice):** the control-plane half of the
    custody model, built with the live-Obot seam gated/flagged.
    (a) **Brokering mode** added to the credential model — additive Prisma migration `0013`:
    `McpCredentialBrokeringMode` enum (`StaticFallback` / `PerUserObo`) + `brokering_mode`
    column (default `static_fallback`); `secret_ref` relaxed to nullable (OBO authors no static
    secret). Contract `McpCredentialBrokeringMode` + `McpServerCredential.brokeringMode`
    (`@opencrane/contracts`).
    (b) **Custody validation** — `_NormalizeCredentialInput` enforces: `static` requires a
    non-empty `secretRef` (per-tenant/per-server fallback for non-OBO upstreams); `obo` must
    NOT carry one (Obot brokers a per-user RFC 8693 token). Violations → 400 on POST/PUT.
    (c) **API + CLI-first** — additive credential sub-routes `GET/POST /mcp-servers/:id/credentials`
    and `DELETE /mcp-servers/:id/credentials/:credentialId` (do not disturb grants, unlike the
    full PUT); openapi spec + regenerated client; `oc mcp cred list|add|rm` CLI.
    (d) **Custody regression test** — `_BuildObotRegistryItem` extracted + asserted to emit NO
    credential/secret material on the Obot registry-sync wire format (secrets stay server-side).
    (e) **Encryption-at-rest** wired in Helm behind `mcpGateway.encryptionAtRest.enabled`
    (**default OFF**): when on, sets `OBOT_SERVER_ENCRYPTION_PROVIDER=custom` + mounts a key
    from the `opencrane-obot-enc` Secret. ⚠️ **ASSUMED knob, NOT verified** — flagged in values,
    template, and JSDoc; gated off so it never ships blind. Tests: control-plane 187/187 (8 new),
    contracts + control-plane + CLI `tsc` clean, `helm template` validated both ways.
  - **Parked — needs LIVE Obot (do not ship blind):** (f) the **push-to-Obot auth-config surface**
    — how an admin registers the OAuth client / token-endpoint / scopes for an OBO upstream so
    Obot performs the exchange — is undocumented; the brokering *model* is authored centrally but
    the reconcile/push of OBO config into Obot is not built. (g) **confirming the encryption-at-rest
    knob** (provider value + exact key env var) against the pinned Obot version before enabling.
    (h) the **end-to-end OBO round-trip** (tenant call → Obot exchange → downstream) needs a live
    Obot + an OBO-capable upstream. The static-fallback authoring path is fully built and testable
    headlessly; only the live exchange/push remains.
- [ ] **P4D.2 OCI/ORAS (Zot) digest-pinned bundle storage.** Today the Skill Registry serves
  bundle `content` from the control-plane DB — the 🔶 in `website/integrators/skill-registry.md`. Substrate
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
  - **Backfill tooling landed (2026-06-14):** idempotent backfill that pushes every **published**
    bundle's DB `content` into the OCI store via the existing `OciBundleStore.pushBundle`.
    Core `_BackfillBundlesToOci` (`core/oci/oci-backfill.ts` + `.types.ts`) iterates published
    bundles, pushes each, and reports per-bundle **pushed / skipped (no content) / failed**, with a
    **digest-mismatch guard** (content that hashes to ≠ the recorded `digest` is reported failed,
    never silently orphaned, because delivery looks up the recorded digest). API-first per house
    rule: `POST /skills/catalog/backfill` (`skill-catalog.ts`, returns the summary + writes an
    `OciBackfill` audit entry, **409 `OCI_STORE_NOT_CONFIGURED`** when `SKILL_OCI_REGISTRY_URL`
    unset) + `oc skills backfill` CLI. Tests: 5 core (push / skip / mismatch-fail / error-isolation /
    empty) + 2 route (409-unconfigured / push+summary+audit). control-plane 179/179, `tsc` clean,
    OpenAPI + `@opencrane/contracts` regenerated, CLI builds. Non-destructive: reads DB content,
    only writes to the registry. This is the prerequisite tooling for the parked live backfill (e).
  - **Parked — needs LIVE infrastructure (do not ship blind):** (e) **running** the backfill against
    a live Zot (tooling above is ready; the *run* needs real infra), then the **destructive** Prisma
    migration dropping `SkillBundle.content` (the registry-only end state — no migration SQL authored,
    stays parked pending a verified live backfill); (f) live round-trip e2e against a real Zot.
    **P4D.1** (Obot RFC-8693 token exchange) is likewise parked — it needs a live Obot/upstream to
    test OBO.

### Track MI — Native multi-instance (single-cluster) support — ✅ COMPLETE · full history: plan-done.md § Completed Tracks (archived 2026-06-15)

### Track CT — Native ClusterTenant resource + management API (customer-scope isolation)

> Scoped 2026-06-15 from the multi-tenancy isolation review (this session; see
> `docs/enterprise-needs.md`). Goal: promote the **customer / isolation unit to a first-class
> `ClusterTenant` resource** with an API-first management surface (`oc cluster-tenant`), reparent the
> `Tenant`/**openclaw** CRD under it, and harden the opt-in multi-instance mode into a *modeled,
> enforced* per-customer boundary (per-tenant namespace + ResourceQuota/LimitRange + node pinning).
> Adds a **generic provisioner-delegation seam** so private vendors (e.g. Kamaji) can supply a
> `dedicatedCluster` backend **out-of-process, without touching the AGPL tree** (CT.6).
>
> **Decisions (locked 2026-06-15):**
> - **Terminology:** the CRD named `Tenant` is the **openclaw** (a workload); the customer/isolation
>   unit is the new **`ClusterTenant`** (cluster-scoped). openclaws are reparented under it.
> - **Default stays single-install / no multi-tenancy.** ClusterTenant machinery is **opt-in**
>   (extends the existing `multiInstance.enabled` gate). With it off, behaviour is unchanged: a single
>   implicit "default" ClusterTenant binds the install namespace and existing openclaws attach to it
>   with zero spec changes.
> - **`isolationTier` enum:** `shared` (namespace, bin-packed nodes) · `dedicatedNodes` (namespace +
>   tainted GKE node pool via ComputeClass) · `dedicatedCluster` (own kube-apiserver — **pending**,
>   external provisioner only). First two ship here; the third validates but is rejected unless a
>   provisioner is registered for it.
> - **Compute/quota are native** (the operator is the *sole* pod-creator, so no admission webhook is
>   needed): per-ClusterTenant namespace + ResourceQuota + LimitRange + nodeSelector/tolerations.
>   **Machine provisioning stays out of OpenCrane** (GKE NAP/ComputeClass; not Crossplane).
> - **Vendor hook is AGPL-clean by construction:** a generic `ClusterTenantProvisioner` interface with
>   a built-in `SharedClusterProvisioner`; external backends are invoked **over an HTTP/RPC webhook**
>   (contract published in the MIT `libs/contracts`), never linked in-process. See CT.6.

#### Execution chain (parallelised)

Dependencies are driven by **compile-time type coupling** and **file/package contention**, not
logical affinity — items in the same wave touch disjoint packages and can run concurrently.

```
            ┌─> CT.2 (control-plane API) ─────> CT.3 (oc CLI) ─┐
CT.1 ───────┼─> CT.6 (provisioner seam) ───────────────────────┼─> CT.7 (gating+docs+conformance)
(keystone)  └─> CT.4 (operator reparent) ─> CT.5 (enforcement) ┘
```

- **Wave 0 — keystone (serial):** **CT.1**. The `ClusterTenant` type + CRD + Prisma model. Nothing
  else compiles without it. CT.1 must also land the **provisioner webhook DTOs + registry interface
  signature** in `libs/contracts` (the `isTierAvailable(tier)` shape CT.2 calls and CT.6 implements)
  so Wave 1 lanes don't block on each other.
- **Wave 1 — 3 parallel lanes (all depend only on CT.1):**
  - **Lane A · control-plane API — CT.2.** `routes/cluster-tenants.ts(+.types.ts)`, `openapi/spec.ts`.
  - **Lane B · provisioner — CT.6.** `core/cluster-tenants/provisioner.ts(+.types.ts)`, MIT DTOs.
    CT.2↔CT.6 share only the registry interface fixed in CT.1 → *coordinate, don't serialise*.
  - **Lane C · operator — CT.4.** `apps/operator/src/tenants/operator.ts`, Tenant CRD. Separate
    package from A/B → zero contention.
- **Wave 2 — 2 parallel lanes:**
  - **Lane A · CT.3** (`oc cluster-tenant` CLI) — needs CT.2's regenerated `libs/contracts` client.
  - **Lane C · CT.5** (namespace + ResourceQuota/LimitRange + scheduling) — needs CT.4's parent
    resolution; `apps/operator/.../deploy/3-deployment.ts` + quota builders.
- **Wave 3 — integration (serial):** **CT.7**. Opt-in gating, docs, conformance — depends on all.

**Critical path:** CT.1 → {CT.2→CT.3 ∥ CT.4→CT.5} → CT.7 (depth 4). Max width 3 (Wave 1).
With one agent per lane, wall-clock ≈ 4 sequential slices instead of 7.

- [x] **CT.1 `ClusterTenant` resource — contract + CRD + storage.** _(Wave 0 · keystone — ✅ landed 2026-06-15)_ Define `ClusterTenant` in
  `libs/contracts` (`cluster-tenant.types.ts`): `name`/`displayName`, `isolationTier`
  (`shared`|`dedicatedNodes`|`dedicatedCluster`), `compute` (`mode: shared|dedicated`, `nodePool?`),
  `resources.quota` (`cpu`/`memory`/`pods`/`storage`/`gpu?`), `status` (`phase:
  pending|provisioning|ready|failed`, `message`, `boundNamespace`, `provisioner`). New **cluster-scoped**
  CRD `clustertenants.opencrane.io` in `platform/helm/crds/`. Prisma model + migration (dual-write
  alongside the CRD, mirroring how Tenant/AccessPolicy persist). **Acceptance:** type exported; CRD
  validates (`helm template` + `kubectl --dry-run`); migration applies; `tsc` green. **Anchors:**
  `libs/contracts/src/cluster-tenant.types.ts`, `platform/helm/crds/`, `apps/control-plane/prisma/`.
  **Headless-buildable.** ✅ Landed: contract types + provisioner webhook DTOs + registry signature
  (`ClusterTenantProvisionerRegistry.isTierAvailable`) exported; cluster-scoped CRD
  `opencrane.io_clustertenants.yaml`; Prisma `ClusterTenant` model + enums + migration `0014`.
  Build green (contracts/control-plane `tsc`, `prisma generate`, `helm template`).

- [x] **CT.2 Management API — `/api/v1/cluster-tenants` (API-first).** _(Wave 1 · Lane A — ✅ landed 2026-06-15)_ CRUD + status read in the
  control-plane, dual-writing the CRD + Postgres. `isolationTier`/`compute`/`resources.quota`
  validated; `dedicatedCluster` rejected `422 TIER_UNAVAILABLE` unless an external provisioner is
  registered for it (CT.6). Update `openapi/spec.ts` → regenerate `openapi.json` + the `libs/contracts`
  client. **Acceptance:** endpoints in `openapi.json`; CRUD works; over-tier rejected with a typed
  error; control-plane tests. **Anchors:** `apps/control-plane/src/routes/cluster-tenants.ts(+.types.ts)`,
  `apps/control-plane/src/openapi/spec.ts`, `libs/contracts/src/generated/api.ts`. **Headless-buildable.**

- [x] **CT.3 `oc cluster-tenant` CLI.** _(Wave 2 · Lane A — ✅ landed 2026-06-15)_ `create|list|show|update|delete` with
  `--tier`/`--compute`/`--node-pool`/`--quota-*` flags, consuming the generated client (just another
  client, no privileged path). **Acceptance:** commands round-trip against the control-plane; `--help`
  documented; a CLI e2e. **Anchors:** `apps/cli/src/commands/cluster-tenants.ts`, `apps/cli/src/index.ts`.
  **Headless-buildable.**

- [x] **CT.4 Reparent openclaw (`Tenant`) under ClusterTenant + back-compat default.** _(Wave 1 · Lane C — ✅ landed 2026-06-15)_ Add optional
  `spec.clusterTenantRef` to the `Tenant`/openclaw CRD; the operator resolves the parent to get the
  target namespace + compute/quota policy. **Single-install default:** with multi-tenancy off, a
  synthetic "default" ClusterTenant binds the install namespace and ref-less openclaws attach to it —
  existing installs deploy byte-for-byte unchanged. **Acceptance:** default-mode openclaws unchanged
  (operator test); a ref'd openclaw lands in the parent's namespace. **Anchors:** `libs/contracts`
  Tenant type + CRD, `apps/operator/src/tenants/operator.ts`. **Headless-buildable.**

- [x] **CT.5 Native isolation enforcement — namespace-per-ClusterTenant + quota + scheduling
  (the hardening).** _(Wave 2 · Lane C — ✅ landed 2026-06-15)_ When opt-in, provision a per-ClusterTenant namespace labelled
  `pod-security.kubernetes.io/enforce: restricted`, with a `ResourceQuota` + `LimitRange` derived from
  `resources.quota`, and stamp `nodeSelector` + `tolerations` from `compute` onto the openclaw pod
  spec. Off by default (single-install unchanged). **Acceptance:** rendered/operator test shows
  quota + limitrange + PSA label + scheduling constraints applied per ClusterTenant; the conformance
  script gains per-ClusterTenant assertions. **Anchors:**
  `apps/operator/src/tenants/deploy/3-deployment.ts`, new quota/limitrange builders, the namespace
  provisioning path, `platform/tests/multi-instance-conformance.sh`. **Headless-buildable** (live
  quota/PSA enforcement is the cluster seam).

- [x] **CT.6 `ClusterTenantProvisioner` seam + built-in shared provisioner + AGPL-clean external
  delegation.** _(Wave 1 · Lane B — ✅ landed 2026-06-15)_ Define a generic `ClusterTenantProvisioner` interface (`provision`/`deprovision`/
  `getStatus`/`getKubeconfigRef`) in the control-plane, with a built-in `SharedClusterProvisioner`
  serving `shared`/`dedicatedNodes` (maps a ClusterTenant to a `multiInstance`-profile namespace).
  External backends are reached by an **`ExternalWebhookProvisioner`** that POSTs a generic
  `ProvisionRequest` to a **configured HTTPS endpoint** (URL+token via env/secret) and reads back a
  status + a kubeconfig **reference** (a Secret name) — **out-of-process, arm's-length, with no vendor
  code or vendor names in the AGPL tree**. Publish the webhook DTOs in the **MIT** `libs/contracts` so
  a vendor implements them in their own (proprietary) service. Tier→provisioner routing is by
  registered capability (the webhook advertises supported tiers). **Acceptance:** the built-in path
  provisions `shared`; a test stub external provisioner is invoked over HTTP for a registered tier; a
  grep gate confirms no vendor string under AGPL paths. **Anchors:**
  `apps/control-plane/src/core/cluster-tenants/provisioner.ts(+.types.ts)`, MIT `libs/contracts`
  webhook DTOs, `docs/enterprise-needs.md`. **Headless-buildable.**

- [x] **CT.7 Opt-in gating + docs + conformance.** _(Wave 3 · integration — ✅ landed 2026-06-15)_ Gate all ClusterTenant machinery behind the
  existing opt-in (single-install remains the zero-config default and renders none of it). Document
  the ClusterTenant model + the provisioner webhook contract (extend `website/operators/multi-instance.md`,
  cross-link `docs/enterprise-needs.md`); document the "one customer = one ClusterTenant = one
  instance" invariant the resource now makes enforceable. **Acceptance:** `helm template` with no flags
  is unchanged; opt-in renders the ClusterTenant path; conformance + build green. **Anchors:**
  `platform/helm/values.yaml`, `website/operators/multi-instance.md`, `docs/enterprise-needs.md`,
  `platform/tests/multi-instance-conformance.sh`. **Headless-buildable.**

### Track AIR — AI model routing, selection & cost optimization

> Scoped 2026-06-18 from the LiteLLM BYOK/BYOM + autonomous-router research (this session). Two
> reports at repo root: `litellm-byok-byom-research.md`, `litellm-router-autonomous-improvement-research.md`.
> Goal: give every caller **explicit model choice**, let **skills pin (or `auto`) their own model**,
> add an **opt-in "auto" routing mode**, and stand up the **shadow-mode measurement + nightly
> improvement loop** that lowers token cost at equal quality — all OSS/AGPL, API-first, IAM-gated.
>
> **Decisions (locked 2026-06-18):**
> - **Full AGPL forever.** OpenRouter is UI/CLI *inspiration only* — no wire/client-slug compat;
>   triangulate the surface with WeOwnAI.
> - **No fee — meter + manage only** (no 5% / prepaid wallet).
> - **No LiteLLM Enterprise license** (proprietary; can't ship in an AGPL artifact). OSS workarounds
>   are permanent architecture.
> - **BYOK is control-plane / ClusterTenant level — never per-openclaw-tenant.** Two key types:
>   *upstream provider key* = central or per-ClusterTenant (held by LiteLLM); *LiteLLM virtual key* =
>   per-openclaw (budget + `models[]` + metering, already minted).
> - **Secrets are k8s-native:** GCP Secret Manager → External Secrets Operator → k8s Secret → LiteLLM
>   env (`os.environ/<KEY>`); the `/credentials` DB store is only for the optional dynamic case.
>   **CMEK on by default** (Terraform gap today).
> - **Selection precedence: explicit request model > skill-pinned model > "auto" (only if selected) >
>   global default**, bounded by the virtual key's `models[]`. **Auto runs only when "auto" is
>   explicitly chosen** — otherwise the chosen/pinned model is used verbatim.
> - **`STORE_MODEL_IN_DB` is the BYOM unlock.** LiteLLM does not learn — the improvement loop is
>   external (RouteLLM Apache-2.0 + Langfuse MIT), writing back via the control plane only.
>
> **Verified:** no GuardLLM / guardrail / safety service exists anywhere in `opencrane-2` (code, Helm,
> briefs, plans) — design-only, never built. A safety stream is future work (AIR.9); its logs would be
> an auxiliary signal (hard filter + score term), **not** the routing quality judge.
>
> **Security prerequisite:** dev auth is OPEN and there is no per-route RBAC
> (`auth.middleware.ts:117`, `docs/agents/architecture.md:35`). The credential/model/skill-model
> mutation routes handle live secrets + cost policy and **must get ClusterTenant-scoped route authz
> before they ship** (AIR.0b).

- [x] **AIR.0 Platform hardening prereqs (Helm/Terraform — no behaviour change). — LANDED 2026-06-18.**
  CMEK default-on in the GKE module (KMS keyring/key with `prevent_destroy` + 90d rotation, robot IAM,
  `database_encryption`, gated by `enable_secrets_encryption=true`); `STORE_MODEL_IN_DB` + `LITELLM_SALT_KEY`
  + Redis are **values-gated** (`litellm.storeModelInDb/redis.*`, salt auto-gen in `litellm-secret.yaml`),
  **on for `values/gcp.yaml` (has Postgres), off for DB-less k3d** — i.e. DB-backing is wired everywhere but
  only enabled where a DB exists, not force-on for all profiles; image pinned to `main-v1.81.0-stable`.
  Validated: `helm template` (base + gcp) renders, multi-instance conformance passes; terraform not installed
  (manual HCL pass). Original scope — (a) **CMEK by
  default** in `platform/terraform/modules/gke/main.tf`: KMS keyring + crypto key (`prevent_destroy`)
  + GKE robot `roles/cloudkms.cryptoKeyEncrypterDecrypter` IAM + `database_encryption { state=ENCRYPTED;
  key_name=… }`. (b) **DB-backed LiteLLM for all profiles**: `DATABASE_URL` + `STORE_MODEL_IN_DB=True`
  (+ `LITELLM_SALT_KEY` if `/credentials` used) into `litellm-deployment.yaml` + every values profile
  (today only `gcp.yaml`). (c) **Redis** for cross-replica budgets/limits. (d) **Pin the LiteLLM image**
  off `:main-latest`. **Acceptance:** existing per-tenant virtual keys still mint + persist across
  restart; `helm template` clean. **Anchors:** `platform/terraform/modules/gke/main.tf`,
  `platform/helm/templates/litellm-deployment.yaml`, `platform/helm/values*.yaml`.
- [x] **AIR.0b Route authz for credential/model/skill-model mutations. — LANDED 2026-06-18.**
  `infra/middleware/cluster-tenant-scope.ts` guard on all POST/PUT/DELETE of the new routers: platform
  operators allowed at any scope; non-operators only on a `clusterTenant`-scoped resource whose owner equals
  their freshly-resolved `clusterTenant`; Global mutations operator-only; denials → 403 `FORBIDDEN_SCOPE`.
  **Prod hardening LANDED 2026-06-18 (security cutover):** the no-session fallthrough now **fails closed
  unless dev-mode** — `infra/auth/auth-mode.ts._IsDevAuthMode()` (mirrors `auth.middleware`: dev = no OIDC
  + no `OPENCRANE_API_TOKEN`) gates the guard + both read-scope resolvers (metrics → 403, recommendations →
  empty). Dev / the OPEN dev backend stay permissive; any real auth deployment denies a sessionless mutation.
  The `_ResolveCallerClusterTenant` resolver is single-sourced in `infra/auth/`. 324 tests green (+1 fail-closed test).
  **Anchors:** `infra/auth/auth-mode.ts`, `infra/middleware/cluster-tenant-scope.ts`, `routes/model-routing-{metrics,recommendations}.ts`.
- [x] **AIR.0c-data-path Operator→models data-path + per-key allowlist + config-map population. — LANDED 2026-06-18.**
  New NetworkPolicy-gated internal endpoint `GET /api/internal/tenant-models/:tenant` → `{ models, defaultModel }`
  (Global + the tenant's ClusterTenant `ModelDefinition`s; default via `ModelRoutingDefault` precedence). The
  operator fetches it **best-effort/non-fatal** at reconcile (`tenants/internal/tenant-models.ts`, 2s timeout,
  null on any error) and applies it: the LiteLLM virtual key's `models[]` allowlist is now set on `/key/generate`
  + `/key/update` **when non-empty** (the real model-access gate; **omitted when empty** to avoid LiteLLM's
  "empty = ALL" footgun — non-breaking), and the config-map `litellm-proxy.models[]` is populated likewise.
  Closes the "any tenant can call any registered model" gap (also completes the deferred AIR.2-operator config-map
  population). 332 control-plane + 101 operator tests green.
- [ ] **AIR.0c-cutover (STILL BLOCKED) — remove the broadcast + retire `ProviderApiKey`.** **(B)** removing the
  `org-shared-secrets` `envFrom` broadcast (`3-deployment.ts:189-191`) is **blocked on OpenClaw**, not the
  operator: `OPENAI_API_KEY` feeds OpenClaw's *internal OpenAI translator fallback* (hardcoded, no config flag
  per `3-deployment.ts:81`) — needs an **OpenClaw image change** (configurable translator backend) to point it
  at LiteLLM. **(C)** deleting the orphaned `ProviderApiKey` table + `/providers/keys` route needs WeOwnAI
  confirmed off the legacy endpoint first. Both deferred to a coordinated cutover.
- [x] **AIR.1 Model registry (BYOM) — control-plane + LiteLLM. — LANDED 2026-06-18.** Prisma
  `ModelDefinition` + `ProviderCredential` (scope `global|clusterTenant`, **stores `secretRef` — never a raw
  key**) + enum `ModelRoutingScope` + migration `0017_model_routing`; contract types in `libs/contracts`;
  `GET/POST/PUT/DELETE /api/v1/models` + `/api/v1/providers/credentials` (raw-key fields rejected 400;
  cross-tenant credential binding rejected); `oc model …` + `oc credential …` CLI; LiteLLM `POST /model/new`
  is a **best-effort GLOBAL seam** (guarded by `LITELLM_ENDPOINT`+master key, deterministic placeholder id in
  dev). Build green; control-plane 242 tests pass (+18). **Deviations:** the orphaned `ProviderApiKey` table +
  `/providers/keys` route are **kept for now** (retirement deferred to a cutover slice to avoid breaking
  WeOwnAI); the CLI uses `--secret-ref` (not `--token-file`) — uploading a raw key to GCP-SM is a deliberate
  future enhancement. _(Original scope:)_ `ModelDefinition` (scope
  `global|clusterTenant`) + `ProviderCredential` (scope `global|clusterTenant`, references the
  ESO-synced k8s Secret — **no raw key**) Prisma tables; `GET /models` + `POST/PATCH/DELETE /models`
  (global) + `/cluster-tenants/{id}/models`; `oc model add/list/update/remove [--cluster-tenant]` +
  `oc provider add/list/remove [--cluster-tenant] --token-file`. Backed by LiteLLM `/model/new` (GLOBAL,
  `api_key: os.environ/<KEY>`). Retire the orphaned `ProviderApiKey` table + hardcoded `["openai","claude"]`.
  **Anchors:** `openapi/spec.ts`, `routes/provider-keys.ts`→registry routes, `prisma/schema.prisma`,
  regenerated `libs/contracts`, `apps/cli/src/commands/`.
- [x] **AIR.2 Model selection precedence + the "auto" gate. — LANDED 2026-06-18 (contract side).** The
  effective-contract now emits a resolved per-skill model via the pure `resolve-skill-model` helper
  (precedence skill-pinned > skill-auto > ClusterTenant default > Global default). **Deferred:** operator
  config-map pod-side default population (needs an operator→models data path) + the request-level explicit
  override at the gateway. _(Original:)_ Resolve per request/skill:
  **explicit > skill-pinned > auto (opt-in) > global default**, bounded by the key's `models[]`.
  **Auto runs only when explicitly selected** (request- or skill-level flag) — never global-implicit.
  Write the resolved per-skill model into the effective-contract + propagate to the pod
  (`2-config-map.ts` `models[]`/default). **Anchors:** effective-contract endpoint,
  `apps/operator/src/tenants/deploy/2-config-map.ts`.
- [x] **AIR.3 Skill-level model definition. — LANDED 2026-06-18.** `Skill` gained
  `modelMode`/`pinnedModel`/`autoConfig`; dedicated `/api/v1/skills/posture` router (the `Skill` model had
  no prior read/write path — `skill-catalog` operates on the separate `SkillBundle`) keyed by
  (name,scope,team) + `oc skill-posture` CLI. _(Original:)_ Let a skill self-define its model in the skill-registry
  metadata — a **pinned** model or **`auto`** (with a per-skill auto config) — surfaced via the skill
  API + `oc skill …` + the effective-contract. **Anchors:** skill-registry schema, control-plane skill
  routes, contract compiler.
- [x] **AIR.4 "auto" configuration surface. — LANDED 2026-06-18.** `ModelRoutingDefault` table (scope
  global|clusterTenant) + `/api/v1/model-routing/defaults` CRUD + `oc model-default` CLI + the
  `AutoRoutingConfig` type. **Config surface only** — the runtime optimizer that consumes `autoConfig` is
  AIR.7. _(Original:)_ The opt-in auto knobs (router report §12):
  objective/strategy (cheapest-passing-bar default | best-quality-within-budget | balanced via a
  cost↔quality slider), quality floor (skill bar), budget cap, allowed-model set (= key `models[]`),
  latency ceiling, fallback chain, scope (global|ClusterTenant|skill|request), session-pin (default on),
  exploration toggle. API-first + `oc` + WeOwnAI. **Anchors:** config schema in `openapi/spec.ts`,
  contract, CLI.
- [x] **AIR.5 Per-tenant virtual-key hardening. — LANDED 2026-06-18.** Operator: richer `/key/generate`
  params (`team_id` from clusterTenantRef/team, `budget_duration`, config-default tpm/rpm) + a `/key/update`
  drift-reconcile replacing the no-rotation early-return (key value preserved, no pod restart). Control-plane:
  revoke now best-effort `/key/delete` by alias, audited. **Deferred:** `org-shared-secrets` broadcast removal
  (cutover — would break tenants before AIR.2 operator-side lands) + per-key `models[]` allowlist (needs the
  operator→models data path). _(Original:)_ Extend `_generateLiteLlmVirtualKey` to send `team_id`
  (ClusterTenant→LiteLLM Team), `models[]` allowlist, `budget_duration`, `tpm/rpm`; fix the no-rotation
  early-return; complete revocation (`/key/delete`); stop the `org-shared-secrets` `envFrom` broadcast
  (keys stay at the proxy). **Anchors:** `apps/operator/src/tenants/internal/tenant-litellm-keys.ts`,
  `deploy/3-deployment.ts`, `core/ai-budget/ai-budget.logic.ts`.
- [x] **AIR.6 Shadow-mode savings measurement. — LANDED 2026-06-18 (foundation).** `RoutingEvalCase`
  data model + `/api/v1/model-routing/eval-cases` API + `oc routing eval-case`; pure `savings.ts`
  estimator (at-bar fraction → `1 - effective/baseline`, bootstrap 95% CI, injectable rng) +
  `shadow-measure.ts` orchestrator (per-case run+judge → `RoutingMeasurement`, emits a Pending proposal
  only when CI excludes zero) behind `JudgeClient`/`ModelRunner` seams (`_BuildShadowSeams`, env-gated,
  no-op when unconfigured); `/model-routing/measurements` (+ `POST /run`) + `oc routing measurement`;
  Langfuse trace-capture wiring (LiteLLM `LITELLM_SUCCESS_CALLBACK=langfuse` + `LANGFUSE_*`, values-gated
  default-off, points at an operator-provided Langfuse — not bundled). **Live seams IMPLEMENTED 2026-06-18:**
  `shadow-seams.ts` now builds a real `ModelRunner` (LiteLLM `/v1/chat/completions`, cost from the
  `x-litellm-response-cost` header) + a vendor-neutral `JudgeClient` (`ROUTING_JUDGE_MODEL`, robust 0–1 score
  parse) when `LITELLM_ENDPOINT` + `LITELLM_MASTER_KEY` + `ROUTING_JUDGE_MODEL` are set (null pair / no-op
  otherwise); hard HTTP failures throw (clean 500, no corrupt sample), soft cases degrade. Ops recipe in
  `docs/operators/routing-measurement.md`. **Version-stamping LANDED 2026-06-19:** every `RoutingMeasurement`
  /`RoutingProposal` now records `skillContentHash` + `skillDigest` (live published `SkillBundle`) + the stable
  `candidateModelId`/`proposedModelId` (`litellmModelId`, not just the slug) + `candidateUpstreamModel` (migration
  0020, best-effort lookups), and the recommendation feed surfaces them — so performance is attributable to a
  specific *(skill content version × model deployment)* and stale evidence is detectable. (Residual: a provider
  drifting a model behind a slug needs dated provider model ids to fully detect.) 352 tests green.
  **Remaining = the live RUN itself**
  (deploy DB-backed LiteLLM + provider keys + a judge model, then `oc routing measurement run` → the first real
  savings number) — an operator step on a live cluster, plus reading sampled production traffic out of Langfuse.
  _(Original:)_ LiteLLM
  `CustomLogger` → **Langfuse** (skill id, model, cost, latency, propensity); per-skill golden eval set
  + quality bar; nightly shadow-grade a sample with a **neutral judge** (not the candidates' vendor);
  **OPE** (Open Bandit Pipeline, doubly-robust + bootstrap CIs + per-tenant breakdown); produce the
  per-skill **go/no-go savings table**. (Router §11.) **Deliverable:** "routing would save X%±Y at equal
  quality; overhead Z%." Needs AIR.0 + candidate models registered (AIR.1). **Anchors:** new optimizer
  service/job, Langfuse self-host (MIT), LiteLLM callback.
- [x] **AIR.7 Nightly improvement loop for "auto" skills. — LANDED 2026-06-18 (foundation).** Human-gated
  `RoutingProposal` lifecycle (`/api/v1/model-routing/proposals` + `oc routing proposal` approve/reject):
  a proposal is emitted only when the savings CI excludes zero, and **apply happens ONLY on explicit
  approve** (pins the skill to `proposedModel` via the AIR.3 write, status→Applied, audited) — never
  auto-deployed; reject leaves routing untouched. Pure `ope.ts` off-policy estimators (replay +
  doubly-robust + bootstrap CI) provide the AIR.7 substrate for assessing a candidate policy from logs.
  **Deferred (live-infra / next slices):** live judge+runner execution, Langfuse-backed sampling, the
  RouteLLM/bandit policy learner, and staged canary % rollout (proposal status exists; graded traffic-%
  rollout not implemented). _(Original:)_ judge → OPE → propose
  (cheapest-≥-bar; later RouteLLM matrix-factorization/BERT or a bandit) → gate on a frozen private
  hold-out + significance (95% CI excludes zero) → **canary** → **human-approved diff via the control
  plane** → write per-skill default + LiteLLM `/model/update` + per-key `models[]`. IAM-gated + audited;
  **never auto-deploy.** Four rules: log propensities/explore, neutral judge (multi-vendor
  self-preference), frozen hold-out, shadow→canary→approve. (Router §4/§7.)
- [ ] **AIR.8 (FUTURE) Fixed-model-skill savings evaluator + advisory notification.** For skills pinned
  to a fixed model (not auto), run the shadow evaluator continuously and **surface an advisory — never
  auto-change a pinned skill**: WeOwnAI/CLI lists fixed-model skills with *"by changing this skill's
  model you could save up to N% in token cost at equal quality,"* one-click **"switch to recommended"** /
  **"enable auto."** (Router §12.) **In-repo enablers DONE:** the savings-recommendation feed
  (`/model-routing/recommendations`, AIR.11) now also carries the skill's `modelMode` (pinned|auto|null) so the
  console can flag a *fixed-model* skill distinctly; the one-click actions map to existing APIs (proposal
  approve = AIR.7, enable-auto = `oc skill-posture set --mode auto` = AIR.3). Remaining is the WeOwnAI view itself.
- [ ] **AIR.9 (FUTURE) Safety / guardrail stream.** If/when a guardrail service is adopted, run it as an
  external OSS service (LiteLLM's built-in callbacks are Enterprise), emit verdicts to Langfuse keyed by
  skill id; use as a hard routing filter + a safety term in the per-skill score — **not** the quality
  judge. No such service exists today.
- [x] **AIR.10 (FRONTEND ENABLER) Langfuse-metrics proxy. — LANDED 2026-06-18.** `GET /api/v1/model-routing/metrics`
  proxies Langfuse v1 `/api/public/metrics` (overridable via `LANGFUSE_METRICS_PATH`) with server-side HTTP Basic
  auth; **503** when unconfigured, **502** on upstream error; non-operators get a tenant-dimension filter injected
  (fail-closed **403** when their ClusterTenant can't be resolved); `oc routing metrics`. **Open:** the tenant
  filter field (`metadata.clusterTenant`) is a documented `TODO(AIR.10)` to confirm once the gateway stamps the
  tenant dimension into trace metadata. _(Original:)_ Control-plane read endpoint proxying
  Langfuse's **v1** Metrics/Public API (v2 is Cloud-only) with project keys held server-side + scoped
  per tenant, so the WeOwnAI console can render native eval/cost trend tiles without the browser ever
  holding Langfuse credentials. IAM-gated. (Verified 2026-06-18: Langfuse has no iframe embed → build
  native over the API + link out for deep eval UX.)
- [x] **AIR.11 (FRONTEND ENABLER) Savings-recommendation read endpoint. — LANDED 2026-06-18.**
  `GET /api/v1/model-routing/recommendations` joins each skill's latest `RoutingMeasurement` with any open
  Pending `RoutingProposal`, sorted by `projectedSavingsPct` desc, scope-filtered (operator sees all,
  non-operator only their own ClusterTenant, fail-closed `[]`); new `SavingsRecommendation` contract type;
  `oc routing recommendation list`. The "save up to N%" feed behind the console differentiator. _(Original:)_ Aggregate the latest
  `RoutingMeasurement` + open `RoutingProposal` per skill/tenant into a "save up to N%" feed — the API
  behind the console's headline differentiator (the inline savings-recommendation + one-click human-gated
  apply, market whitespace; see `litellm-router-autonomous-improvement-research.md` §14). Pure read over
  data the AIR.6/7 loop already produces.

> **Frontend (WeOwnAI, separate proprietary repo — out of this AGPL tree):** the management *views* live
> there as just-another-API-client (`/auth/me` claims hide UI; the API enforces). Prioritized capability
> catalogue + Langfuse embed/link/native guidance in `litellm-router-autonomous-improvement-research.md`
> §14. **Eval refinement:** AIR.6's judge should be a thin layer over **Langfuse managed evaluators +
> trace-curated datasets** (all MIT/free on OSS self-host) rather than a fully bespoke judge — §13.

**Sequencing:** AIR.0/0b (prereqs) → AIR.1 (registry) → {AIR.2 selection ∥ AIR.3 skill model ∥ AIR.4 auto config} → AIR.5 key hardening → **AIR.6 shadow measurement is the recommended first end-to-end slice** (proves the savings before building AIR.7) → AIR.7 loop → {AIR.10 ∥ AIR.11 frontend enablers} → AIR.8/9 future.

---

## Phase 4 — original spec, reality-check & locked decisions — ✅ ARCHIVED · full history: plan-done.md § Phase 4 — original spec, reality-check & locked decisions (archived 2026-06-15)

## Go-Live Checklist (Open Items)

> Both open items are now folded into the S-series: *GCP installer smoke* → **S2** (must provision
> Dataplane-V2 + Workload Identity), *DNS + ingress verification* → **S1** (per-org-host path).

| Item | Status | Done Criteria |
|------|--------|---------------|
| GCP installer smoke (`./platform/install.sh gcp`) → **S2** | Not yet revalidated | Fresh GCP project deploys end-to-end; control-plane endpoint reachable; test tenant reconciles successfully. |
| DNS + ingress verification → **S1** | Not started | Domain and TLS resolve correctly; control-plane and tenant subdomains accessible externally. |

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
