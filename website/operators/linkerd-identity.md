# Linkerd identity substrate (S5)

How OpenCrane's operator layers cryptographic workload identity on top of the L3/4 NetworkPolicy floor — the Linkerd mTLS-identity analogue of the silo isolation baseline. **This feature is gated off by default** (`LINKERD_MESH_ENABLED=false`) and has no effect on clusters without Linkerd installed.

> See also:
> [Networking & isolation](/operators/networking) — the S2 L3/4 NetworkPolicy baseline this layer sits on top of; read that page first for the overall silo model.
> [Silo deployment model](/operators/silo-deployment) — how the central and per-ClusterTenant silo releases are installed; the deployment context for this identity layer.
> [Hosting & deployment](/operators/hosting) — operator configuration, env vars, and the Helm chart.
> [ADR 0001 — ClusterTenant-as-virtual-network strict isolation](https://github.com/italanta/opencrane/blob/main/docs/adr/0001-cluster-tenant-virtual-network-isolation.md) — the architecture decision record that defines the substrate choice and the layering contract.

---

## Why a second isolation layer

The S2 NetworkPolicy baseline (described in [Networking & isolation](/operators/networking)) closes the silo edge at **L3/L4**: it selects pods by namespace label, restricts ports, and drops everything not on the explicit allow-list. That floor is robust and CNI-enforced, but it cannot express **who** a workload is — only where it lives in the network.

Linkerd adds a second, additive layer keyed on **cryptographic workload identity** (mTLS, SPIFFE/X.509 SVIDs bound to Kubernetes ServiceAccounts). The silo posture at this layer is identical to the L3/4 posture: default-deny, with exactly two identities admitted — workloads in the same silo namespace and the operator/control-plane super-admin namespace.

The two layers are **independent defences**. Neither replaces the other:

```
┌──────────────────────────────────────────────────────────────────┐
│  Silo isolation (ClusterTenant namespace)                        │
│                                                                  │
│  L3/4 floor (S2 — always active, CNI-enforced)                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  NetworkPolicy: default-deny + allow intra-silo            │  │
│  │  + allow operator namespace + DNS + external HTTPS         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                          ↕  additive                             │
│  Identity layer (S5 — gated, Linkerd required)                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Server: default-deny all pods in silo namespace           │  │
│  │  MeshTLSAuthentication: allow intra-silo identity          │  │
│  │                       + allow operator namespace identity  │  │
│  │  AuthorizationPolicy: bind Server to authentication        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

A connection between two silos is blocked at **both layers**: L3/4 drops the packet (wrong namespace, not in the allow-list) and the Linkerd policy also rejects it (the source identity is not in the `MeshTLSAuthentication`). A L3/4-only bypass would still hit the identity gate; a compromised Linkerd mesh would still hit the NetworkPolicy gate.

::: tip The floor never goes away
Enabling `LINKERD_MESH_ENABLED` does not remove or relax the S2 NetworkPolicy baseline. The Linkerd objects are applied *in addition*. On a cluster without Linkerd, the L3/4 floor is the only active layer and remains in full effect.
:::

---

## What the operator emits per silo

When `LINKERD_MESH_ENABLED=true`, the operator performs two actions for every ClusterTenant silo namespace it provisions or reconciles:

**1. Namespace annotation.** The silo namespace receives the annotation `linkerd.io/inject: enabled`. This causes the Linkerd control plane to inject a sidecar proxy into every pod that lands in the namespace, giving each workload a Linkerd mTLS identity tied to its Kubernetes ServiceAccount. The annotation is written idempotently — re-applying the namespace with the same annotation is a no-op.

**2. Identity policy bundle.** Three Linkerd custom resources are applied in order:

| Resource | API version | Name | Purpose |
|----------|-------------|------|---------|
| `Server` | `policy.linkerd.io/v1beta1` | `opencrane-<org>-silo-identity` | Selects every pod in the namespace (empty `podSelector`) and sets `accessPolicy: deny` — the default-deny stance at the identity layer. |
| `MeshTLSAuthentication` | `policy.linkerd.io/v1alpha1` | `opencrane-<org>-silo-identity` | Declares the allow-list: `*.<namespace>.serviceaccount.identity.linkerd.cluster.local` (intra-silo) and `*.<operator-namespace>.serviceaccount.identity.linkerd.cluster.local` (the super-admin plane). |
| `AuthorizationPolicy` | `policy.linkerd.io/v1alpha1` | `opencrane-<org>-silo-identity` | Binds the deny-by-default `Server` to the `MeshTLSAuthentication`, re-opening only the allowed identities. |

The three objects share the same deterministic name, so re-applies converge idempotently and one silo's bundle never collides with another's. All carry the labels `app.kubernetes.io/component=silo-isolation` and `opencrane.io/cluster-tenant=<org>`, matching the S2 NetworkPolicy labels so both isolation layers are discoverable together.

Source: [`apps/operator/src/tenants/deploy/silo-linkerd-identity.ts`](https://github.com/italanta/opencrane/blob/main/apps/operator/src/tenants/deploy/silo-linkerd-identity.ts)

---

## Fail-closed behaviour

The operator does not crash or stall the silo reconcile when Linkerd is not installed.

The `LinkerdIdentityClient` applies each object using the `CustomObjectsApi`. If the Linkerd policy CRDs are not served by the API server (i.e., Linkerd is not installed), the API server returns a 404 with a `NotFound` response for the resource group `policy.linkerd.io`. The client detects this as a CRD-absent condition and:

1. Logs a structured `warn` message: `"Linkerd mesh enabled but policy CRD is absent (Linkerd not installed); skipping silo identity policy"`.
2. Returns `applied: false` — the whole bundle is skipped atomically (no partial bundle is left in the namespace).
3. The operator logs a second `warn`: `"Linkerd identity policy skipped (CRDs absent); silo isolated at L3/4 only"`.
4. The silo reconcile continues normally; the rest of the namespace resources are applied as usual.

This means **setting `LINKERD_MESH_ENABLED=true` on a cluster without Linkerd is a safe no-op**, not a wedged reconcile. The cost is two warn-level log lines per silo provisioning cycle.

Existing objects are applied with create-then-replace-on-conflict semantics: if the resource already exists (409 Conflict), the operator fetches the live `resourceVersion` and replaces in-place, so a re-applied silo converges rather than erroring.

---

## Enabling the substrate

Set the environment variable on the operator deployment:

```
LINKERD_MESH_ENABLED=true
```

The operator picks this up at startup via `_readEnvValue<boolean>("LINKERD_MESH_ENABLED", "boolean", false, false)` in [`apps/operator/src/config.ts`](https://github.com/italanta/opencrane/blob/main/apps/operator/src/config.ts). The default is `false`.

**Prerequisites before enabling:**

1. Linkerd is installed on the cluster and its control plane is healthy (`linkerd check`).
2. The Linkerd policy CRDs (`servers.policy.linkerd.io`, `meshtlsauthentications.policy.linkerd.io`, `authorizationpolicies.policy.linkerd.io`) are registered with the API server.
3. The operator's ServiceAccount has permission to create and replace custom resources in the `policy.linkerd.io` group in silo namespaces (the same RBAC that permits applying `DNSEndpoint` CRs applies here).

Once the flag is on, every **new** silo namespace provisioned will receive the annotation and policy bundle. **Existing** silo namespaces are updated on the next reconcile cycle — the operator re-applies all namespace resources on every `ADDED`/`MODIFIED` Tenant watch event, so existing silos converge without manual intervention.

::: info Disable: flag off, manual cleanup
Setting `LINKERD_MESH_ENABLED=false` stops the operator from emitting new Linkerd objects. It does not delete objects already applied to existing namespaces. To remove the identity layer from a live silo, delete the three named custom resources manually and remove the `linkerd.io/inject` annotation from the namespace. The S2 NetworkPolicy baseline remains active throughout.
:::

---

## The identity domain

Linkerd derives each workload's mTLS identity from its Kubernetes ServiceAccount using the trust domain:

```
<serviceaccount>.<namespace>.serviceaccount.identity.linkerd.cluster.local
```

The `MeshTLSAuthentication` uses a wildcard to match **every ServiceAccount in a namespace**:

```
*.<namespace>.serviceaccount.identity.linkerd.cluster.local
```

This means any pod in the silo namespace can talk to any other pod in the same namespace (intra-silo), regardless of which specific ServiceAccount it runs as — mirroring the S2 NetworkPolicy rule that admits all pods in the same namespace by `podSelector: {}`.

The only foreign identity domain admitted is the operator/control-plane namespace's wildcard. No other silo's domain is ever listed, so the mTLS identity layer enforces the same cross-silo denial as the L3/4 floor.

---

## Current status

🔶 Gated, default OFF. The implementation is complete and the operator applies the objects correctly when the gate is on, but the feature is off by default pending broader mesh rollout. The S2 L3/4 NetworkPolicy baseline is the active isolation floor on all current deployments.

See the [networking & isolation](/operators/networking) page for the known gaps in the current enforcement status, including the note on identity-aware L7 enforcement.
