# Silo multi-tenant plan

**One-line goal:** every ClusterTenant (the customer org) is its own strictly isolated
**virtual network (silo)**; all silos feed a **main network** that hosts the shared
control-plane; a single **identity-driven control loop** (OIDC → control-plane → operator →
Cilium/SPIFFE) decides and enforces who may reach what, so no traffic ever crosses into the
wrong tenant.

This file is the canonical plan for the strict-multi-tenancy program. It folds in every
queued task. Keep it updated as phases land.

**Roadmap position (rebased 2026-06-25):** this program is the head of `plan.md`'s forward
sequence — **Phase 0 → S1 · Phase 1 → S2 · Phase 2a → S3 · Phase 2b → S4 · Phase 2 identity
loop → S5 · Phase 3 → S6 · Phase 4 → S7**. The remaining `plan.md` items run after as S8–S12.

---

## 1. The model (vocabulary — use these terms everywhere)

- **ClusterTenant = the org (the customer).** The isolation unit. Each is a **silo /
  virtual network / subnet**: its own namespace, its own operator, its own data + runtime
  planes. Strictly isolated from every other silo.
- **`openclaw` Tenant = a user/employee INSIDE a ClusterTenant.** Not an org.
- **control-plane = the fleet super-admin plane.** Lives in the **main network**
  (`opencrane-system`). Oversees the whole ClusterTenant fleet. The ONLY shared plane and
  the ONLY identity allowed to cross into a silo.
- **Silos feed the main network.** Default-deny at every silo edge. Egress allowed only
  toward the control-plane; ingress into a silo allowed only from the control-plane/operator
  super-admin identity. East-west isolation. (North-south edge — org host → ingress →
  gateway-proxy → pod — is documented in `website/operators/networking.md`; this plan is its
  internal complement.)

```
            ┌──────────────────── MAIN NETWORK (opencrane-system) ────────────────────┐
            │  control-plane (super-admin identity)  ·  fleet metadata DB              │
            └───────────▲───────────────────▲───────────────────▲─────────────────────┘
       identity-checked │   identity-checked │   identity-checked │   (super-admin is the
       (owner-scoped)   │                    │                    │    ONLY cross-silo principal)
        ┌───────────────┴──────┐  ┌──────────┴───────────┐  ┌─────┴────────────────┐
        │ SILO: opencrane-acme │  │ SILO: opencrane-bcorp │  │ SILO: opencrane-…    │
        │  operator(acme)      │  │  operator(bcorp)      │  │  operator(…)         │
        │  Obot · skills ·     │  │  Obot · skills ·      │  │  …                   │
        │  litellm · cognee ·  │  │  litellm · cognee ·   │  │                      │
        │  tenant DB           │  │  tenant DB            │  │                      │
        │  openclaw pods (users)│ │  openclaw pods (users)│  │                      │
        └──────────────────────┘  └───────────────────────┘  └──────────────────────┘
                 default-deny edge        default-deny edge        default-deny edge
        NO silo-to-silo traffic, ever. Only the super-admin identity crosses inward.
```

---

## 2. The identity-driven control loop (the "IAM system")

A closed loop spanning human identity → workload identity → network enforcement. Modelled as
a classic IAM **PDP/PEP** split with continuous reconciliation:

- **Identity sources**
  - *Humans:* OIDC (control-plane already wired — `controlPlane.oidc.issuerUrl/clientId`).
    A ClusterTenant **owner** = an OIDC `sub`/email; **super-admin** = an OIDC group/claim.
  - *Workloads:* every workload runs as a Kubernetes ServiceAccount → a cryptographic
    identity (SPIFFE SVID via SPIRE, or Cilium identity) bound to its silo
    (e.g. `spiffe://opencrane/ct/<org>/…`). OpenCrane already mints audience-bound
    projected-identity tokens at `/var/run/opencrane/tokens` — that is the existing
    workload-identity primitive to extend down to the network layer.
- **PDP — decision (control-plane):** the source of truth for which OIDC identities own which
  ClusterTenants, group membership, and grants. "Owner X may act in silo X; super-admin may
  act fleet-wide."
- **Reconciler — the loop (operator):** watches ClusterTenant + grant state; on every change
  provisions the silo namespace, the workload identities (KSA + SPIFFE registration entries),
  and the Cilium identity policies (default-deny + intra-silo + allow-from-super-admin).
  Continuous reconciliation = self-healing IAM: actual converges to desired.
- **PEP — enforcement:**
  - *Network:* Cilium / GKE Dataplane V2 enforces **identity-based** policy (keyed on
    SA/SPIFFE identity, optional mTLS mutual auth), NOT IP/CIDR. The super-admin identity is
    the only principal allowed to cross into a silo.
  - *App:* the planes verify the audience-bound projected token (already exists) — defence in
    depth.
- **Loop closes:** OIDC grant/revoke or ClusterTenant create/delete → control-plane state →
  operator reconcile → identities + Cilium policy updated → enforcement reflects intent, and
  the diff is audited. Principals + policy + decision point + enforcement point + control
  loop = an IAM system.

**Why identity, not IP:** IP/label NetworkPolicy fails **open** when the enforcer is absent
(exactly the live bug — policies present, enforcement off, zero isolation) and is coupled to
CIDR allocation. Identity is cryptographic, robust to pod churn, and matches the owner's model
("strict identity-based controls").

**Open substrate decision (resolve in the ADR — `task_5164276f`):**
- *GKE-managed Dataplane V2:* you get Cilium under the hood, but GKE exposes a **limited**
  surface (standard NetworkPolicy + GKE FQDN policy) — NOT full `CiliumNetworkPolicy` +
  SPIFFE mutual-auth. Simplest; may be enough for label/identity-by-namespace.
- *Self-managed Cilium (BYO CNI):* full identity-aware L3/4/L7 + SPIFFE mTLS. More ops.
- *Service mesh (Istio ambient / Linkerd) over either:* richest L7 identity authz; most weight.
- *vcluster / Kamaji per silo (`dedicatedCluster` tier):* strongest; AGPL/WeOwnAI seam
  (`docs/enterprise-needs.md`).

**Crown jewel:** the super-admin (control-plane/operator) identity is the only cross-silo
principal. Its compromise = cross-tenant reach. Its issuance / rotation / audit must be
first-class.

### Identity planes — what issues what (DECIDED: Zitadel for humans, k8s/SPIFFE for workloads)

"Everything has an identity" is the goal — but identity comes from the **right issuer per
plane**. Do **not** mint a Zitadel service account per cluster asset.

| Plane | Principal | Issuer | Used by (PEP) |
|---|---|---|---|
| **Human / automation principal** | owner, member, super-admin, CI, `oc`-in-automation | **Zitadel (OIDC)** — system of record | control-plane (app-layer authz), gateway-proxy (north-south, `X-Forwarded-User`) |
| **Workload** | every pod / KSA (operator, openclaw, litellm, cognee, …) | **k8s ServiceAccount → SPIFFE SVID / Cilium identity**, silo-bound (`spiffe://opencrane/ct/<org>/…`); already half-built as projected tokens at `/var/run/opencrane/tokens` | Cilium / Dataplane V2 (east-west L3/4, identity-keyed) |

**Why not Zitadel service accounts for workloads:**
- *Lifecycle mismatch* — pods churn; SPIFFE/Cilium identities are short-lived, auto-rotating,
  cryptographically attested, no shared secret. A Zitadel SA is a long-lived credential to
  provision/distribute/rotate/revoke per pod — the secret-sprawl, fails-open footgun §2 rejects.
- *The enforcer can't read it* — Cilium keys policy on SPIFFE/Cilium identity at L3/4; it cannot
  gate a packet on an OIDC bearer token (app layer).
- *Availability + isolation coupling* — intra-silo auth via an external IdP puts Zitadel on every
  internal call's critical path and makes every silo depend on a shared cross-silo service —
  the opposite of default-deny-at-the-edge.

**Can OIDC manage identity *between resources inside* a ClusterTenant?**
- *human → resource* (user → their openclaw pod): **yes**, already the model (gateway-proxy
  delegated OIDC).
- *resource → resource* (pod → litellm, operator → pod): **no** — workload identity.
- *legitimate intersection:* a workload calling an OIDC-guarded API keeps SPIFFE as its root and
  **token-exchanges** (SPIFFE SVID → short-lived OIDC/JWT) only at that hop (SPIRE↔OIDC
  federation). Root issuer stays k8s/SPIRE, never a Zitadel workload SA.

**The operator is the bridge:** Zitadel claims + control-plane grant state = the PDP decision;
the operator provisions BOTH the workload identities AND the Cilium identity-policies per silo.
Zitadel *drives* workload-identity policy indirectly — it never *issues* workload credentials.

### Zitadel as the PDP system-of-record (auto-provisioning) · NEW

Today the control-plane only **consumes** Zitadel (OIDC login + claim parsing in
`apps/control-plane/src/infra/auth/oidc.service.ts`). It never **writes** to Zitadel — so a
new org host's redirect URI isn't registered (live login bug at `<org>.dev.opencrane.ai/login`,
see `_buildRedirectUri` at `oidc.service.ts:606`), no role/group is created per CT, and a
removed user lingers in the IdP. To close the IAM loop, the control-plane must own Zitadel's
**Management API** as the PDP system-of-record, mirroring every principal lifecycle op.

**Object-model mapping — DECIDED: per-tenant Zitadel Org + app (strict user-pool isolation):**
- **Two auth tiers, strictly separated:**
  - *Platform / masters tier* — the control-plane's OWN Zitadel Org + OIDC app. Pool = tenant
    **masters** (org owners/admins with **billing** access). Log in at `platform.<base>` to manage
    orgs, billing, create tenants. **Super-admin** is a claim here (assigned, never self-served).
    Masters-tier authz stays DB-driven (`OrgMembership`) — control-plane reads which CTs a master owns.
    - *Membership:* **open self-registration** into the masters Org — harmless because nothing is
      actionable until the master adds a **`BillingAccount`** (existing org-creation gate) and
      creates a CT (which makes them its owner — the existing chicken-and-egg breaker). Super-admin
      is NOT obtained this way.
    - *Later* — a master **invites** secondary masters into the masters pool (e.g. an accountant /
      second billing master): masters-Org identity + a billing-scoped `OrgMembership` on the
      master's CT(s). Distinct feature, phased after the primary path.
  - *Per-ClusterTenant tier* — on CT create the control-plane provisions a **dedicated Zitadel
    Organization + OIDC app + project/roles** for that org, then **(a) grants the tenant master
    `admin` on this org (cross-org user grant — see SSO below) and (b) issues the master an
    openclaw Tenant** (subject-bound; reuses/extends `_EnsureOwnerDefaultTenant`). The org's
    *end-users* (employees the master later invites) live ONLY in this Org → **strict user-pool
    isolation; org A cannot see org B's users.** Login at `<org>.<base>` authenticates against this
    org's app (own branding/login policy possible).
- **SSO — single identity, cross-org grant (Zitadel native B2B).** The master is ONE identity in
  the masters Org, **not** duplicated into the CT pool. CT create gives it an admin **user grant on
  the CT project**; because all apps share one Zitadel instance, the master's existing session
  silently issues a token for the CT app → true SSO, no second credential, no separate IdP
  federation. The CT end-user pool stays sealed; the master reaches in as a cross-org grantee
  (the "owner is the bridge principal", mirroring super-admin in the network model).
- **Roles are org-local** (`owner|admin|member` inside each CT's own project) — no `ct:<org>:`
  prefix; the issuing app already carries the org context (control-plane resolved host→CT pre-login).
- **Control-plane resolves `host → CT → per-org OIDC client`** — client_id / org_id / redirect URI
  persisted on the CT record at provisioning. `oidc.service` switches client per request host;
  one shared instance issuer + discovery, per-org client_id + Zitadel org scope
  (`urn:zitadel:iam:org:id:{orgId}`) so only that org's pool can log in. The masters app serves
  `platform.<base>`. **This replaces the single-client `_buildRedirectUri` host-reuse model.**
- **Redirect URIs are per-app** — each CT app's redirect = `<org>.<base>/api/v1/auth/callback`
  (+ post-logout), created WITH the app. No shared redirect-URI list, no wildcard, no `devMode`.
- **Control-plane CONTROLS Zitadel (PDP system-of-record):** every auth mutation flows THROUGH the
  control-plane service — never out-of-band in the Zitadel console. Control-plane = master, Zitadel
  = projection; both move together (transaction rules below).

**Transactional consistency — DB ⇄ Zitadel must not diverge.** Every auth-affecting op touches
local Postgres AND remote Zitadel; there is no 2PC across a remote API, so:
- *Primary (interactive ops — user assignment, role change):* wrap in a Prisma **interactive
  `$transaction`**; do local validation + staged writes, then call Zitadel as the LAST fallible
  step inside the callback. Any Zitadel error throws → DB auto-rolls-back; commit only after
  Zitadel returns OK. Handles the dominant failure (Zitadel rejects → nothing persists).
- *Ordering rule:* the Zitadel mutation is the last step before commit, so the commit is
  near-infallible.
- *Residual window* (Zitadel OK, then commit fails → orphan): all Zitadel ops **idempotent** + the
  **reconcile/backfill loop** detects & compensates drift (Zitadel object w/o DB row, or vice-versa)
  → rare permanent divergence becomes eventual consistency.
- *Caveat / escalation:* an open DB tx across an HTTP call holds locks + a connection — fine for
  low-rate admin ops, an anti-pattern for bulk/hot paths → use a **transactional outbox** (commit
  DB + intent row atomically; worker applies to Zitadel with idempotent retry). Set tx/statement
  timeouts either way.
- User → a **user grant** of the CT role; revoke on member-remove; deactivate/remove on delete.

**Lifecycle ops to mirror (API-first + `oc` CLI, per the API/CLI-first rule):**

| Trigger (control-plane) | Zitadel Management API effect |
|---|---|
| `POST /cluster-tenants` | ensure `ct:<org>:*` roles + add `<org>.<base>/api/v1/auth/callback` redirect URI |
| `DELETE /cluster-tenants/:name` | remove redirect URI + roles/grants for that CT (teardown completeness) |
| `POST /cluster-tenants/:name/members` *(NEW route)* | create/lookup user + grant `ct:<org>:<role>` |
| `PUT  /cluster-tenants/:name/members/:subject` *(NEW)* | change grant role |
| `DELETE /cluster-tenants/:name/members/:subject` *(NEW)* | revoke grant; **delete-user also deactivates/removes the Zitadel user** |
| role/group change | update grant + emit session-invalidation so the user re-logs to pick up new claims |

**Service-layer shape (mirror `OciBundleStore` / `_NoopGatewayAdmin` factory pattern):**
`apps/control-plane/src/core/zitadel/zitadel-client.ts` + `_BuildZitadelManagementClient()` →
returns a no-op when unconfigured (fail-closed: lifecycle ops are best-effort + reconciled, never
block the local write), throws fail-loud on bad config. Auth via a **Zitadel service-account JWT
key** — this is the *one* legitimate Zitadel SA (an automation principal acting on the API), NOT
a workload SA. All ops **idempotent** + a **reconcile/backfill** path (drift between control-plane
state and Zitadel is detected and healed, same loop philosophy as the operator). New env:
`ZITADEL_MGMT_API_URL`, `ZITADEL_MGMT_SA_KEY` (GCP-SM + ESO, never in values), `ZITADEL_PROJECT_ID`,
`ZITADEL_OIDC_APP_ID`.

### Inheritance — an openclaw Tenant ⊆ its user's rights · NEW

An `openclaw` Tenant is **1:1 with one ClusterTenant user** and must act with that user's
entitlements across the silo's planes (Cognee datasets, Skills register, Obot/MCP, inter-user
sharing). **The machinery already exists — it is keyed on the wrong principal.**

*As-built (verified):* `core/grants/grant-compiler.ts:126` already unions `subjectType=User`
+ `Tenant` + every `Group` the principal is in, with **Deny>Allow → priority → recency**
precedence; the contract (`/api/internal/contract/:name`) already projects `mcpServers.allow/deny`
(Obot), `skills.entitled` (Skills register); the pod polls + hot-reloads
(`apps/tenant/deploy/entrypoint.sh:344`); `PerUserObo` (RFC 8693) MCP brokering exists. BUT the
compiler is called with the **tenant name** as the principal, so it inherits the *tenant's* groups,
not the *user's*. There is **no `Tenant.subject` field**; `Group.members` is a hand-maintained
local JSON blob (not from Zitadel); Cognee dataset memberships are **set manually**, not derived.

*Decision — compile over the user's principal-set, not the tenant name:*

```
openclaw Tenant ──bind (NEW Tenant.subject)──▶ user (OIDC sub)
                                                   │
        principal-set = { tenant-name, subject, groups(subject) }   ← groups mirrored from Zitadel
                                                   ▼
              grant-compiler.compile(principal-set)   (union · Deny>Allow · priority · recency)
                                                   ▼
                       per-tenant contract  ──poll + hot-reload──▶ runtime
                       ├─ mcpServers.allow/deny  → Obot / MCP
                       ├─ skills.entitled        → Skills register
                       └─ dataset memberships    → Cognee  (org/team/project/personal)
```

- **Group membership is mirrored FROM Zitadel** into local `Group.members` by the Phase-2a
  reconcile loop — the compiler reads the local mirror so the per-pod contract poll never hits the
  external IdP (availability + the silo-edge rule). Token-carried groups are rejected: the contract
  compiles server-side on a poll, often when the user isn't logged in.
- **Cognee dataset scopes become DERIVED** from the same group/grant expansion (stop the manual
  path being the only writer); `DatasetScope` (Org/Team/Project/Personal) already aligns with
  `Group.scope`.
- **Inter-user sharing = a `Grant(subject=User|Group, Allow)`** — already expressible; needs a
  sharing API/CLI that writes the grant **bounded by least privilege** (a user may only share what
  they themselves hold — no privilege escalation), then the existing recompile→poll→reload
  propagates it.
- **Security tension (design note):** the runtime is an autonomous LLM agent; full inheritance means
  prompt-injection reaches everything the user can. Inheritance stays **auditable + Deny-able**
  (Deny>Allow already wins) and the contract MAY intersect user-rights with a per-agent scope —
  inherit-by-default, least-privilege-capable.

---

## 3. As-built gap (verified 2026-06-23, code + live gke `opencrane-dev`)

| Dimension | Intended (silo model) | As-built |
|---|---|---|
| Operator | one per ClusterTenant, owner-scoped | **one shared** operator in `opencrane-system` reconciles all |
| Planes (Obot/skills/litellm/cognee/DB) | per silo | **shared singletons** in `opencrane-system` |
| Per-CT provisioning | subnet + operator + planes | only namespace + quota + DNS + openclaw pods |
| Isolation tier in use | dedicated / virtual-net | all 3 live CTs run `isolationTier=shared` (weakest) |
| Network enforcement | identity-based, default-deny | **NONE** — no Dataplane V2 / Calico; every NetworkPolicy is inert |
| Egress | default-deny per silo | unrestricted (egress baseline sits in the wrong namespace) |

Net: there is currently **no network-level isolation between ClusterTenants at all.**

---

## 4. Phased plan (all queued tasks folded in)

### Phase 0 — Make the current (shared-tier) install work + demoable · IN PROGRESS
Get multi-tenant functioning on the existing topology and stop the silent-half-install class
of bug. Demo-unblocking.

- ✅ **DONE** — operator `trustNothing` crash fix (commit `f6afafd`).
- ✅ **DONE** — `opencrane-dev` Helm overlay: `externalIp`, `gatewayProxy.enabled`,
  `trustedProxies=[10.8.0.0/14]` (commit `818041d`).
- ✅ **DONE** — networking architecture doc (commit `5795b99`).
- ⏩ **INTERIM** — manual DNS for the demo (see §5).
- ✅ **DONE (S1)** `task_845dd617` — operator auto-derives `trustedProxies` from its own pod IP
  via the opt-in `[auto]` token (downward API `POD_IP`, default /14); empty stays trust-nothing so
  the CONN.9 fail-closed default is preserved. Kills the "forgot the CIDR → all pods fail-closed"
  footgun without silently widening trust.
- ✅ **DONE (S1)** `task_bbafd7e9` — `values.schema.json` coherence guard (`gatewayProxy.enabled` ⇒
  non-empty `ingress.externalIp` + `trustedProxies`, Helm-enforced on every render) + preflight
  **WI-enabled** cluster probe (`gke-metadata-server`), not just the `roles/dns.admin` binding.
- ✅ **DONE (S1)** `task_5cab917e` — `--auto-ingress-ip` derives `ingress.externalIp` from the
  ingress-nginx LB (deploy-multi-tenant opts in when `--ingress-ip` is omitted) + `--verify`
  advisory post-deploy phase (DNSEndpoints present, external-dns no auth errors, pods Running,
  host resolves).
- 🟡 **PARTIAL (S1)** `task_d611ab4d` — landed the **minimal fallback**: a no-dep structural
  contract test pinning the rendered `openclaw.json` to OpenClaw's strict gateway key set
  (catches the `trustNothing`-class crash). Full validation against the **pinned OpenClaw zod
  schema is BLOCKED** — the schema isn't vendored (OpenClaw ships as a container, not an npm dep);
  schema-source is an open decision. Also surfaced: `configOverrides` shallow-merge can replace the
  whole `gateway` block (drops the owner-pin / can inject a crashing key) — follow-up gap.
- **NEW (live login bug)** — `<org>.<base>/login` throws the OIDC redirect error because the host's
  callback isn't a registered redirect URI. **Interim unblock (now):** add
  `elewa-be.dev.opencrane.ai/api/v1/auth/callback` to the current Zitadel app by hand. **Durable
  fix = 2a** (per-CT Org+app, redirect baked in at provisioning) — do NOT build a shared-app
  redirect-URI registrar here, as the decided end-state is per-tenant apps (§2).

### Phase 1 — Enforcement floor: make isolation real
Nothing below matters until an enforcer exists; even the namespace isolation that exists today
is a no-op without it.

- 🟡 **PARTIAL (S2)** `task_d6404452` — **enforcement substrate confirmed**: the GKE Terraform
  module is Autopilot, which enforces Dataplane-V2/NetworkPolicy inherently (documented the
  invariant + the "don't migrate to Standard without ADVANCED_DATAPATH" guard). Silo-namespace
  default-deny ✅ (below). **Still open:** the `opencrane-system` (main-network) default-deny
  baseline — deferred: needs the complete plane ingress/egress allow-list (DB, LiteLLM, Langfuse,
  Cognee…) + live validation to avoid breaking platform traffic. The live `opencrane-dev` cluster
  is a manually-created **Standard** cluster with enforcement OFF — a runbook migration, not code.
- ✅ **DONE (S2)** `task_08734d58` — operator emits `_BuildSiloBaselineNetworkPolicy` per silo
  namespace: default-deny ingress+egress, allow-list = intra-silo + control-plane/operator
  namespace + DNS + external HTTPS; **no rule names another silo** (east-west default-deny by
  construction). Applied in `enforceClusterTenantIsolation`. Misplaced install-namespace
  `opencrane-tenant-default` retired. 5 unit tests.

### Phase 2 — The identity loop (IAM)  · design first
Wire OIDC → control-plane (PDP) → operator (reconciler) → Cilium/SPIFFE (PEP) into the closed
loop of §2. Depends on Phase 1 substrate.
- Design lives in the ADR (`task_5164276f`, §3 below). Implementation tasks to be split out
  once the substrate is chosen (SPIRE/Cilium identity wiring; operator provisions identities +
  identity policies per silo; super-admin identity issuance/rotation/audit).

**2a — Zitadel as the PDP system-of-record, control-plane is master (human/principal plane).**
Make the control-plane *control* Zitadel (object model + tiers + transaction rules in §2).
Independent of the network substrate, so it can land in parallel with Phase 1.
- **`zitadel-client` service** — `core/zitadel/zitadel-client.ts` + `_BuildZitadelManagementClient()`
  no-op-when-unconfigured factory; SA-JWT auth; **idempotent** ops; key via GCP-SM+ESO.
- **Per-CT Org/app provisioning + master onboarding** — on CT create, in one transaction: create
  the org's Zitadel **Organization + OIDC app + project/roles**, persist `client_id/org_id/redirectUri`
  on the CT record, **grant the master `admin` (cross-org user grant)**, and **issue the master's
  openclaw Tenant** (extend `_EnsureOwnerDefaultTenant` to set `Tenant.subject` = master sub, gated
  on the grant landing). On delete: tear the Org/app down. (Masters tier = control-plane's own Org/app.)
- **Host→CT→client resolution in `oidc.service`** — replace the single-client `_buildRedirectUri`
  host-reuse with a per-org client registry keyed by host; add the Zitadel org scope so only that
  org's pool can authenticate. Masters app serves `platform.<base>`.
- **Transactional auth mutations** — wrap every DB+Zitadel op (user assignment, role change, member
  add/remove) in a Prisma interactive `$transaction` with the Zitadel call as the last fallible
  step (commit only on Zitadel OK); reconcile loop covers the commit-after-Zitadel-OK window.
- **Member lifecycle + API** — NEW routes `POST/PUT/DELETE /cluster-tenants/:name/members[/:subject]`
  (none exist today) → create/grant/revoke users in the CT's Zitadel Org; **delete-user also
  deactivates/removes the Zitadel user**; role change emits session-invalidation.
- **`oc` CLI** — `oc cluster-tenant members {list,add,set-role,remove}` mirroring the routes
  (API/CLI-first rule).
- **Reconcile/backfill** — periodic drift check: control-plane DB (`OrgMembership`/CT/Group) vs
  each Zitadel Org's users/roles/grants/redirect-URIs; heal divergence + orphans; audit the diff.
- **Masters self-registration + billing** — enable self-registration on the masters app; master
  adds `BillingAccount` → creates CT → becomes owner (existing gate). Secondary-master invite
  (accountant / second billing master = masters-Org identity + billing-scoped `OrgMembership`) is a
  **later** sub-item, after the primary path.
- **ADR input** — JIT-first-login vs eager per-CT-user creation (`task_5164276f`). *(DECIDED, not
  open: per-tenant Org+app; org-local roles; SSO via single masters identity + cross-org admin
  grant; master gets admin + issued openclaw Tenant on CT create; masters self-register, gated
  downstream by billing; secondary-master invites later.)*

**2b — Inheritance: openclaw Tenant inherits its user's rights (§2 "Inheritance").** The grant
compiler + contract projection + reload loop already exist; the work is re-keying them onto the
human and feeding real group membership. Depends on 2a (Zitadel mirror).
- **Bind `Tenant.subject`** — add the OIDC-sub FK to the `Tenant` model + set it on tenant create
  (the workspace's owning user); backfill existing tenants from `BrokeredDevice`/`email`.
- **Compile over the principal-set** `{tenant, subject, groups(subject)}` — pass the user's subject
  (not the bare tenant name) so `grant-compiler.compile` expands the *user's* groups; union with
  tenant-direct grants. (Group expansion + Deny>Allow precedence already work.)
- **Mirror Zitadel groups → `Group.members`** in the 2a reconcile loop (dept/project membership);
  compiler keeps reading the local mirror (contract poll never hits the IdP).
- **Derive Cognee dataset memberships** from the group/grant expansion (org/team/project/personal),
  instead of the manual `_ApplyTenantDatasetMembershipToCognee`-only path.
- **Inter-user sharing API + CLI** — `POST /…/shares` (or grants route) writing `Grant(subject=User|
  Group, Allow)`, **authorization-bounded** (share only what you hold); existing recompile→poll→
  reload does propagation. `oc share {grant,revoke,list}`.
- **(exists, reuse)** contract poll + hot-reload (`entrypoint.sh:344`), `PerUserObo` MCP brokering.

### Phase 3 — Silo architecture: per-CT operator + per-CT planes
The virtual-network model proper.
- `task_5164276f` — **ADR: ClusterTenant-as-virtual-network strict isolation.** Decides the
  substrate (managed Dataplane V2 vs self-managed Cilium vs mesh vs vcluster/Kamaji), which
  planes move into the silo vs stay in the main network, the per-CT-operator design, and the
  cost/footprint model per tier. Then split implementation tasks (per-CT operator;
  templating planes into the silo; reparent under `ClusterTenantProvisioner` /
  `multiInstance`-per-CT).
- **Per-silo ingress is the operator's job.** When the operator moves into the silo, *that*
  operator must own its silo's north-south edge: emit the `{org}.{base-domain}` Ingress +
  `DNSEndpoint` (and bind the wildcard/cert) for its own org, scoped to its namespace — never a
  shared operator writing every org's ingress. Today the single shared operator already emits the
  per-org Ingress/DNSEndpoint (Track DOMAIN); Phase 3 must preserve that capability per-CT and
  fail-closed (a silo with no ingress is unreachable, not cross-wired to another org's host).

### Phase 4 — Tiers & cost
- Map to `ClusterTenant.spec.isolationTier`: `shared` → `dedicatedNodes` → `dedicatedCluster`
  (Kamaji/vcluster). Cost/footprint model so customers can buy an isolation level.

---

## 5. Interim DNS workaround (demo now — bypasses dead external-dns)

external-dns can't write records (Workload Identity not enabled — Phase 1). For a demo, write
the records by hand in the `opencrane-ai-zone` Cloud DNS zone, pointing org hosts at the
ingress-nginx LB IP `34.22.213.142`. A single wildcard covers all orgs:

```bash
gcloud dns record-sets create '*.dev.opencrane.ai.' \
  --type=A --ttl=300 --rrdatas=34.22.213.142 \
  --zone=opencrane-ai-zone
# (apex, if dev.opencrane.ai itself needs an explicit record too)
gcloud dns record-sets create 'dev.opencrane.ai.' \
  --type=A --ttl=300 --rrdatas=34.22.213.142 \
  --zone=opencrane-ai-zone
```

This makes `<org>.dev.opencrane.ai` **resolve** immediately. To actually **serve** a tenant at
that host you still need (a) the operator image with the `trustNothing` fix deployed and (b)
the overlay applied (`gatewayProxy.enabled` + `trustedProxies`) so the wildcard Ingress +
gateway-proxy route to the pod — see the runbook. Skip the Workload Identity fix for the demo;
the manual record covers it. Remove the manual records once external-dns is healthy (Phase 1),
or external-dns (policy=sync) may fight them.

---

## 6. Demo runbook — make ONE tenant serve end-to-end (Phase 0)

Prereqs: `kubectl` context = `opencrane-dev`; `gcloud` authed to `weownai-proto`; on a branch
containing `f6afafd` (the trustNothing fix).

**Step 1 — Build the operator image with the crash fix.**
Push the branch; CI (`.github/workflows/docker.yml`) builds `ghcr.io/italanta/opencrane-operator:sha-<shortsha>`.
```bash
git push
echo "operator tag: sha-$(git rev-parse --short HEAD)"   # note this tag for step 2
```

**Step 2 — Redeploy (rolls operator + enables routing + trusted-proxy).**
```bash
./platform/deploy-multi-tenant.sh \
  --base-domain dev.opencrane.ai \
  --ingress-ip 34.22.213.142 \
  --operator-tag sha-<shortsha> \
  --reuse-values \
  --values platform/helm/values/opencrane-dev.yaml
```
Enables `gatewayProxy` (creates the `*.dev.opencrane.ai` wildcard Ingress + proxy Service),
sets `trustedProxies=[10.8.0.0/14]`, and rolls the operator to the fixed image.

**Step 3 — Regenerate tenant config + confirm the pod is healthy.**
The new operator rewrites each ConfigMap without `trustNothing`. Nudge + verify:
```bash
oc cluster-tenant refresh elewa-be            # re-sync (POST /cluster-tenants/elewa-be/refresh)
kubectl -n opencrane-elewa-be rollout restart deploy/openclaw-elewa-be-default
kubectl -n opencrane-elewa-be get pods        # expect Running, not CrashLoopBackOff
kubectl -n opencrane-elewa-be logs deploy/openclaw-elewa-be-default | tail   # no "Invalid config"
```

**Step 4 — DNS (manual, bypasses dead external-dns).**
```bash
gcloud dns record-sets create '*.dev.opencrane.ai.' --type=A --ttl=300 \
  --rrdatas=34.22.213.142 --zone=opencrane-ai-zone
```
The wildcard covers both `elewa-be.dev.opencrane.ai` (org host) **and**
`platform.dev.opencrane.ai` (the OIDC redirect host — see auth note).

**Step 5 — Verify.**
```bash
dig +short elewa-be.dev.opencrane.ai          # -> 34.22.213.142
curl -sv https://elewa-be.dev.opencrane.ai/   # TLS via *.dev wildcard cert; reaches gateway-proxy
```

**Auth reality (dev OIDC = Zitadel, verified wired).** Connecting as a USER through the org
host goes through the gateway-proxy's delegated OIDC auth. Two gotchas:
1. `OIDC_REDIRECT_URI=https://platform.dev.opencrane.ai/api/v1/auth/callback` — that host only
   routes once `gatewayProxy` is on (its wildcard Ingress sends `/api/*` → control-plane). The
   Step-4 wildcard makes it resolve. Ensure `platform.dev.opencrane.ai/api/v1/auth/callback` is
   a registered redirect URI in the Zitadel app.
2. The gateway pins to the owner via `allowUsers=[<owner email>]` — log in as that owner.

**Fastest "it's alive" fallback (no proxy/OIDC):** port-forward straight to the pod gateway:
```bash
kubectl -n opencrane-elewa-be port-forward deploy/openclaw-elewa-be-default 18789:18789
```
(Note: trusted-proxy mode expects the `X-Forwarded-User` header from the proxy, so a raw
port-forward demonstrates the runtime is up rather than a fully authenticated session.)

**Simplest demo of all:** the control-plane API/CLI at `dev.opencrane.ai` already works today —
no steps needed.

**Revert after the demo:** delete the manual DNS record once external-dns is healthy (Phase 1),
or `policy=sync` will fight it:
```bash
gcloud dns record-sets delete '*.dev.opencrane.ai.' --type=A --zone=opencrane-ai-zone
```

---

## 7. Done / commits
- `f6afafd` fix(operator): stop rendering invalid `trustNothing` key into tenant openclaw.json
- `818041d` chore(deploy): add `opencrane-dev` Helm overlay for the per-org hosting path
- `5795b99` docs(website): networking & network-isolation architecture page
