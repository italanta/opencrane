# ADR 0001 — ClusterTenant-as-virtual-network strict isolation

- **Status:** Accepted
- **Date:** 2026-06-25
- **Task:** `task_5164276f` (Phase 3 / S6 of the strict-multi-tenancy program)
- **Supersedes / superseded by:** none
- **Related:** [`silo-multi-tenant-plan.md`](../../silo-multi-tenant-plan.md) (§2 identity loop, §4 phases) · [`website/operators/networking.md`](../../website/operators/networking.md) (the north-south edge + the L3/4 floor this layers on)

## Context

Every ClusterTenant (a customer org) is modelled as a strictly isolated **silo / virtual
network**. All silos feed a single **main network** (`opencrane-system`) that hosts the
super-admin control plane. The goal is east-west default-deny: no silo→silo traffic ever,
and the control-plane/operator super-admin identity as the **only** cross-silo principal.

The live system has already shipped the L3/4 floor of this model in S2 (`task_08734d58` +
`task_d6404452`): the operator emits a per-silo default-deny `NetworkPolicy`
(`_BuildSiloBaselineNetworkPolicy`) in each ClusterTenant namespace. That floor is keyed on
namespaces and ports — it is correct and necessary, but it is **not** workload-identity-aware,
it does not give us mTLS, and it cannot express L7 (per-route) authorization.

The open question this ADR settles: **what substrate carries workload identity and L7
authorization on top of that floor**, given two hard constraints:

1. The org is going **k8s-native and portable** — actively moving off GCP-managed bits.
   A substrate that only works on GKE (or that hard-couples isolation to a managed Google
   product) is a non-starter for the shared/dedicated tiers.
2. Identity must be **cryptographic and robust to pod churn**, not a CIDR/IP allow-list
   (the live bug — policies present, enforcement off, zero isolation — is exactly the
   failure mode of coupling isolation to addressing).

## Decision

### Substrate = Linkerd service mesh

**Linkerd** is the chosen substrate for workload identity and L7 authorization across silos:

- **Workload identity via mTLS.** Linkerd issues each meshed workload a per-service-account
  identity and establishes mutual TLS between them automatically. This is the cryptographic,
  auto-rotating, churn-robust identity the silo model requires — keyed on the workload, not
  its IP.
- **L7 `AuthorizationPolicy`.** Linkerd `Server` + `AuthorizationPolicy` resources let the
  operator express "only the super-admin/control-plane identity may reach into this silo" at
  the request layer, on top of the namespace floor.
- **Portable / no cloud lock-in.** Linkerd runs on any conformant Kubernetes — GKE, and
  whatever the org moves to. This is the deciding factor: it keeps the isolation substrate
  portable as the org goes k8s-native and off GCP-managed networking.

### GKE Dataplane V2 = interim L3/4 NetworkPolicy floor only

The per-silo default-deny `NetworkPolicy` that S2 shipped **stays** as a defense-in-depth
L3/4 floor. It is expressed in **standard Kubernetes `NetworkPolicy`**, which is portable;
the enforcer is whatever CNI the cluster runs — **GKE Dataplane V2** today, Calico/Cilium
elsewhere. We depend on DV2 only as a *NetworkPolicy enforcer*, not for any GKE-specific
isolation feature. Linkerd layers identity + L7 on top; the NetworkPolicy floor is never
removed.

### Per-CT operator + per-CT planes is the target the substrate enables

The substrate exists to make the **Phase 3 silo architecture** safe: moving the operator and
the data/runtime planes (Obot/MCP, skill-registry, LiteLLM, Cognee, tenant DB) *into* each
silo, with the control plane remaining the only shared, cross-silo plane. Linkerd identity is
what lets a silo-local plane trust a caller without falling back to network position.

### Mesh rollout is additive (S5)

Adopting the mesh does not require a flag-day. The operator:

1. annotates each silo namespace `linkerd.io/inject: enabled` so silo workloads join the mesh
   and get an identity + mTLS;
2. emits a Linkerd `Server` + `AuthorizationPolicy` per silo expressing the same
   default-deny + allow-super-admin posture at L7.

The DV2 / `NetworkPolicy` floor stays in place throughout. The two compose: NetworkPolicy
drops anything not allowed at L3/4; Linkerd authorization drops anything not allowed at L7.
A silo gains identity/L7 isolation incrementally as it is annotated, with no window where it
is *less* isolated than the S2 floor.

### Substrate scales with `isolationTier`

The substrate is not one-size-fits-all; it tracks `ClusterTenant.spec.isolationTier`:

| Tier | Substrate |
|------|-----------|
| `shared` | DV2/CNI NetworkPolicy floor **+ Linkerd identity & L7** in one cluster |
| `dedicatedNodes` | same as `shared`, pinned to dedicated nodes |
| `dedicatedCluster` | vcluster / Kamaji — a separate control plane per silo (strongest isolation) |

## Alternatives considered

- **Self-managed Cilium (BYO CNI) with `CiliumNetworkPolicy` + SPIFFE mTLS** — richest
  identity-aware L3/4/L7 and the original front-runner in the plan. **Deferred.** It is the
  fallback **only if** full `CiliumNetworkPolicy` + SPIFFE mutual-auth turns out to be
  required *and* we are willing to leave GKE Autopilot and run our own CNI (significantly more
  ops). Linkerd delivers the workload-identity + L7 we need today with far less operational
  surface and no Autopilot exit.
- **vcluster / Kamaji per silo** — strongest possible isolation (a separate Kubernetes
  control plane per silo). **Reserved for the `dedicatedCluster` tier**, where the customer is
  buying that level and footprint. It is also the AGPL / WeOwnAI enterprise seam, so it stays
  an arm's-length, out-of-process provisioner rather than the default substrate.
- **GKE Dataplane V2 as the *whole* isolation story** — rejected as a complete answer: the
  GKE-managed surface exposes standard `NetworkPolicy` + GKE FQDN policy, but **not** full
  `CiliumNetworkPolicy` or SPIFFE mutual-auth, and leaning on it for identity would re-couple
  isolation to the managed Google product we are moving away from. Kept strictly as the
  portable L3/4 floor.
- **Istio (ambient or sidecar)** — comparable L7 identity authorization, but heavier to run
  than Linkerd for the posture we need. Not chosen.

## Consequences

- **Portable by construction.** Both layers we own — standard `NetworkPolicy` and Linkerd —
  run on any conformant Kubernetes. The only cloud-specific dependency is "a CNI that enforces
  NetworkPolicy," which every target platform provides.
- **Two-layer defense in depth.** L3/4 floor (NetworkPolicy) + L7 identity authorization
  (Linkerd) are independent; a gap or misconfiguration in one does not open the silo, because
  the other still has to pass.
- **Cryptographic, churn-robust identity.** mTLS identities are short-lived and auto-rotating,
  bound to the workload's service account — no shared secret, no IP allow-list to drift.
- **New operational dependency.** The cluster now runs Linkerd (control plane + per-workload
  proxies); this is added build/run surface (S5) and a new failure domain to monitor. The
  NetworkPolicy floor remaining in place bounds the blast radius if the mesh is unhealthy.
- **Autopilot stays viable.** Because we did not choose self-managed Cilium, GKE Autopilot
  remains an option for the shared/dedicated-node tiers; the Cilium/SPIFFE path is held in
  reserve behind an explicit "we need full CiliumNetworkPolicy + SPIFFE" trigger.
- **The crown jewel is unchanged and reinforced.** The super-admin (control-plane/operator)
  identity is still the only cross-silo principal; Linkerd authorization now enforces that at
  L7 in addition to the namespace floor, making its issuance/rotation/audit even more
  load-bearing.
