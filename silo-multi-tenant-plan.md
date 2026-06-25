# Silo multi-tenant plan

**One-line goal:** every ClusterTenant (the customer org) is its own strictly isolated
**virtual network (silo)**; all silos feed a **main network** that hosts the shared
control-plane; a single **identity-driven control loop** (OIDC → control-plane → operator →
Cilium/SPIFFE) decides and enforces who may reach what, so no traffic ever crosses into the
wrong tenant.

This file is the canonical plan for the strict-multi-tenancy program. It folds in every
queued task. Keep it updated as phases land.

---

## 1. The model (vocabulary — use these terms everywhere)

- **ClusterTenant = the org (the customer).** The isolation unit. Each is a **silo /
  virtual network / subnet**: its own namespace, its own **operator-API instance backed by
  its own DB**, its own data + runtime planes. Strictly isolated from every other silo. The
  silo-local API serves that silo's users (login introspection, the OpenClaw connection
  broker, gateway routing, workspace CRUD) from silo-local data — so a user only ever
  resolves against **their own silo's tenants**, never the fleet's.
- **`openclaw` Tenant = a user/employee INSIDE a ClusterTenant.** Not an org. Its row lives
  in that silo's own DB, never in a shared table.
- **control-plane = the fleet super-admin plane.** Lives in the **main network**
  (`opencrane-system`). Oversees the whole ClusterTenant fleet. The ONLY shared plane and
  the ONLY identity allowed to cross into a silo. Holds only **fleet metadata** — the
  ClusterTenant registry, ownership, and grants — NOT a silo's per-user `openclaw` Tenant
  rows. (Today it is a single shared instance holding everything; the silo model splits the
  per-user API + data down into each silo — see §3.1.)
- **Silos feed the main network.** Default-deny at every silo edge. Egress allowed only
  toward the control-plane; ingress into a silo allowed only from the control-plane/operator
  super-admin identity. East-west isolation. (North-south edge — org host → ingress →
  gateway-proxy → pod — is documented in `website/operators/networking.md`; this plan is its
  internal complement.)

```
            ┌──────────────────── MAIN NETWORK (opencrane-system) ────────────────────┐
            │  fleet control-plane (super-admin / PDP)  ·  ClusterTenant + grant registry│
            └───────────▲───────────────────▲───────────────────▲─────────────────────┘
       identity-checked │   identity-checked │   identity-checked │   (super-admin is the
       (owner-scoped)   │                    │                    │    ONLY cross-silo principal)
        ┌───────────────┴──────┐  ┌──────────┴───────────┐  ┌─────┴────────────────┐
        │ SILO: opencrane-acme │  │ SILO: opencrane-bcorp │  │ SILO: opencrane-…    │
        │  operator-API(acme)  │  │  operator-API(bcorp)  │  │  operator-API(…)     │
        │   + reconciler       │  │   + reconciler        │  │   + reconciler       │
        │  Obot · skills ·     │  │  Obot · skills ·      │  │  …                   │
        │  litellm · cognee ·  │  │  litellm · cognee ·   │  │                      │
        │  silo DB (own tenants)│ │  silo DB (own tenants)│  │                      │
        │  openclaw pods (users)│ │  openclaw pods (users)│  │                      │
        └──────────────────────┘  └───────────────────────┘  └──────────────────────┘
                 default-deny edge        default-deny edge        default-deny edge
        NO silo-to-silo traffic, ever. Only the super-admin identity crosses inward.
        Each silo's API resolves users against its OWN DB → no cross-silo ambiguity.
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

---

## 3. As-built gap (verified 2026-06-23, code + live gke `opencrane-dev`)

| Dimension | Intended (silo model) | As-built |
|---|---|---|
| User-facing API + DB | per silo (silo-local DB holds only that silo's tenants) | **one shared control-plane + one DB** holds every silo's `openclaw` tenants |
| Operator | one per ClusterTenant, owner-scoped | **one shared** operator in `opencrane-system` reconciles all |
| Planes (Obot/skills/litellm/cognee/DB) | per silo | **shared singletons** in `opencrane-system` |
| Per-CT provisioning | subnet + operator-API + DB + planes | only namespace + quota + DNS + openclaw pods |
| Isolation tier in use | dedicated / virtual-net | all 3 live CTs run `isolationTier=shared` (weakest) |
| Network enforcement | identity-based, default-deny | **NONE** — no Dataplane V2 / Calico; every NetworkPolicy is inert |
| Egress | default-deny per silo | unrestricted (egress baseline sits in the wrong namespace) |

Net: there is currently **no network-level isolation between ClusterTenants at all**, and
**no data-level separation either** — one DB holds every silo's tenants behind one API.

### 3.1 The shared-DB resolution-ambiguity class (retired by the silo model)

Because one DB holds every silo's `openclaw` Tenant rows and every per-user resolution path
keys on the IdP-verified email alone, a human who owns a workspace in **more than one**
ClusterTenant matches multiple rows. Each path fail-closes on `>1` (correctly — it must never
pick an arbitrary tenant), so a multi-silo owner resolves to *nothing* everywhere: the
operator UI shows "No tenant yet", the WeOwnAI frontend shows "No workspace … maps to more
than one", and scoped mutations + gateway routing 403. There are **four** such paths in the
shared control-plane (`/auth/me`, the ClusterTenant mutation scope guard, `/auth/pod-token`
[+`/pod-token/cut`], `/auth/gateway-resolve`).

This is a **shared-topology artifact, not a domain rule.** Under the silo model each silo has
its own API instance + its own DB containing **only that silo's tenants**, so a user reaching
`<org>.<base>` resolves against one silo's data and matches exactly one row — the ambiguity
cannot arise. The fleet control-plane keeps a fleet view (ClusterTenant ownership), but it is
the super-admin/PDP, not the per-user resolver.

**Interim shim (shared tier only — superseded by Phase 3):** branch `fix/cluster-tenant-resolver`
(PR #68) scopes all four paths to the silo derived from the request host (`<clusterTenant>.<base>`
first label) so multi-silo owners resolve on the current shared topology *today*. Once each
silo runs its own API + DB this host-scoping is redundant (the silo DB is already single-silo),
though it stays harmless — a no-op filter against a single-silo table. Treat it as a stopgap that
buys correctness until the per-silo split lands, not as the destination.

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
- `task_845dd617` — operator auto-derives `trustedProxies` from its own pod IP (downward API);
  kills the "forgot the CIDR → all pods fail-closed" footgun.
- `task_bbafd7e9` — preflight + `values.schema.json` guards (incl. the missing **WI-enabled**
  check, not just `roles/dns.admin`; `gatewayProxy`↔`externalIp` coherence; non-empty
  `trustedProxies`).
- `task_5cab917e` — deploy auto-derives `ingress.externalIp` from the ingress-nginx LB +
  a post-deploy verify phase (DNSEndpoints present, external-dns no auth errors, pods Running,
  host resolves).
- `task_d611ab4d` — CI contract test: render the tenant ConfigMap, validate `openclaw.json`
  against the pinned OpenClaw zod schema (prevents the `trustNothing`-class crash).

### Phase 1 — Enforcement floor: make isolation real
Nothing below matters until an enforcer exists; even the namespace isolation that exists today
is a no-op without it.

- `task_d6404452` — **P0**: enable NetworkPolicy enforcement (prefer Dataplane V2 / Cilium —
  doubles as the Phase-2 identity substrate) + default-deny-all baseline in `opencrane-system`
  and every silo namespace (fail closed, not open). Cluster-lifecycle (Terraform/gcloud), not
  Helm.
- `task_08734d58` — operator emits a baseline egress NetworkPolicy per silo namespace
  (default-deny except DNS + the allowed planes/control-plane); retire the misplaced
  `opencrane-tenant-default`.

### Phase 2 — The identity loop (IAM)  · design first
Wire OIDC → control-plane (PDP) → operator (reconciler) → Cilium/SPIFFE (PEP) into the closed
loop of §2. Depends on Phase 1 substrate.
- Design lives in the ADR (`task_5164276f`, §3 below). Implementation tasks to be split out
  once the substrate is chosen (SPIRE/Cilium identity wiring; operator provisions identities +
  identity policies per silo; super-admin identity issuance/rotation/audit).

### Phase 3 — Silo architecture: per-CT operator-API + per-CT DB + per-CT planes
The virtual-network model proper. **Each ClusterTenant runs its own operator-API instance
backed by its own DB**, plus its own runtime planes — the silo becomes self-contained for
everything its users touch; only the fleet super-admin plane stays shared.
- `task_5164276f` — **ADR: ClusterTenant-as-virtual-network strict isolation.** Decides the
  substrate (managed Dataplane V2 vs self-managed Cilium vs mesh vs vcluster/Kamaji), which
  planes move into the silo vs stay in the main network, the per-CT-operator design, and the
  cost/footprint model per tier. Then split implementation tasks (per-CT operator-API +
  DB; templating planes into the silo; reparent under `ClusterTenantProvisioner` /
  `multiInstance`-per-CT).
- **Per-CT API + DB split.** Stand up a silo-local API instance bound to a silo-local DB
  holding only that silo's `openclaw` tenants; route `<org>.<base>` to it; reduce the fleet
  control-plane to the super-admin/PDP over the ClusterTenant + grant registry. This
  **dissolves the §3.1 resolution-ambiguity class by construction** (single-silo data ⇒
  unambiguous email→tenant) and retires the host-scoping shim (PR #68). Open sub-questions for
  the ADR: how silo DBs are provisioned/migrated/backed-up at fleet scale; whether the fleet
  plane projects ownership down or the silo reads up; the super-admin's read path into a silo.

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
