# Networking & network isolation

OpenCrane organises all cluster traffic into **two distinct planes**: a narrow public edge that terminates TLS and routes DNS, and a fully private internal network where every platform service runs as a ClusterIP. Understanding the boundary between them — and how the operator bridges it safely — is the mental model you need to operate, debug, and harden the platform.

> See also:
> [Identity & connection auth](/security/identity) — how OIDC sessions and projected-identity tokens authenticate traffic across the planes.
> [Connection security](/security/connection-security) — the full threat model and adopted posture for the browser-to-pod WebSocket.
> [DNS configuration](/operators/dns-config) — how external-dns and cert-manager manage the DNS/TLS side of plane 1.
> [Hosting & deployment](/operators/hosting) — ingress class, TLS cert modes, and cloud hosting adapters.

---

## The two planes at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  PLANE 1 — PUBLIC EDGE                                              │
│                                                                     │
│  Internet ──► single LoadBalancer IP (ingress-nginx)               │
│                │                                                    │
│                ├── platform host  (dev.opencrane.ai / apex)         │
│                │     └── /  ──► control-plane Service :8080         │
│                │                                                    │
│                └── org wildcard  (*.dev.opencrane.ai)               │
│                      ├── /api/* ──► control-plane Service :8080     │
│                      └── /      ──► gateway-proxy Service :8090     │
│                                                                     │
│  TLS: *.<base> wildcard cert (DNS-01)  +  per-org vanity cert       │
│  DNS: platform records (manual/Terraform) + per-org A records       │
│       written by external-dns from DNSEndpoint CRs                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                   operator gateway-proxy
                   (identity-routing seam)
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  PLANE 2 — INTERNAL CLUSTER NETWORK (ClusterIP only)               │
│                                                                     │
│  control-plane :8080    mcp-gateway :8080    skill-registry :5000   │
│  litellm :4000          cognee :8000         postgres (CNPG) :5432  │
│                                                                     │
│  per-org namespaces (opencrane-<org>):                              │
│    openclaw-<tenant> :18789  (no Ingress, no public DNS)            │
│                                                                     │
│  Protected by NetworkPolicy + projected-identity tokens             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Plane 1 — the public edge

### What is publicly reachable

Exactly two host classes ever receive external traffic. Everything else is ClusterIP-only and is unreachable from outside the cluster by design.

| Host | Example (dev) | Resolves to | Routes to |
|------|--------------|-------------|-----------|
| Control-plane host | `dev.opencrane.ai` | LoadBalancer IP | control-plane Service :8080 |
| Per-org host | `acme.dev.opencrane.ai` | LoadBalancer IP | gateway-proxy :8090 (WebSocket) + control-plane :8080 (`/api/*`) |

The control-plane host is either the apex (`<base>`) or a dedicated `platform.<base>`, controlled by the chart value `ingress.controlPlaneHost`. The dev cluster uses the apex directly (`dev.opencrane.ai`). The wildcard Ingress is rendered only when both `ingress.enabled` and `gatewayProxy.enabled` are true (see [`platform/helm/templates/gateway-ingress.yaml`](https://github.com/italanta/opencrane/blob/main/platform/helm/templates/gateway-ingress.yaml)).

There are **no per-user subdomains**. Every user in an org connects through one org host; the identity-routing proxy resolves each session to its own pod.

### How an org host resolves

When a new org is provisioned, the operator's domain provisioner ([`apps/operator/src/cluster-tenants/internal/org-domain.provisioner.ts`](https://github.com/italanta/opencrane/blob/main/apps/operator/src/cluster-tenants/internal/org-domain.provisioner.ts)) creates a `DNSEndpoint` CR named `org-dns-<org>` in the org's namespace. This CR carries a single A record:

```
<org>.<base>  A  <ingress-ip>  TTL 300
```

external-dns (running with `--source=crd --policy=sync --domain-filter=<base> --provider=google`) reads the `DNSEndpoint` CR and reconciles it into the cloud DNS zone. Workload Identity grants the external-dns service account `roles/dns.admin` on the zone's project.

Creation is gated on two conditions: `ingress.externalIp` (the `INGRESS_IP` env var) must be set, and the `DNSEndpoint` CRD must be present. If either is absent, the provisioner skips DNS write and still returns `ready: false, skipped: true` — the org continues to reach the ready phase rather than failing hard. The platform-level records (`platform.<base>`, apex, wildcard `*.<base>`) are written once at install (Terraform or manually) and are never operator-managed.

### TLS

A single platform wildcard cert (`*.<base>`) covers every `<org>.<base>` host. The cert also carries explicit SANs for the control-plane host and the apex. It is issued by cert-manager via ACME DNS-01 (wildcards require DNS-01) into the Secret named by `ingress.tls.secretName` (default `opencrane-wildcard-tls`; v3 in dev). The wildcard Ingress and the control-plane Ingress both reference this Secret.

The wildcard matches exactly one DNS label, so `*.<base>` covers `<org>.<base>` but not `<user>.<org>.<base>`. This is intentional — there are no per-user subdomains, so a second wildcard level is neither needed nor issued.

When a ClusterTenant has a `vanityDomain` set, the operator issues a separate per-org HTTP-01 certificate (SAN = the vanity host only). The customer adds a CNAME at their own provider pointing their domain at the org's canonical host; no DNS-01 is needed because it is a non-wildcard name.

::: tip One wildcard level is enough
Because all users share the org host, the `*.<base>` cert is the only wildcard the platform ever needs. No per-org wildcard certs and no per-org DNS-01 challenges are required.
:::

---

## Plane 2 — the internal cluster network

### Internal services and their ports

All platform services are ClusterIP-only. No plane service exposes an Ingress or a public DNS record. Traffic between them travels over `<release>-<svc>.<namespace>.svc.cluster.local`.

| Service | Port | Namespace |
|---------|------|-----------|
| control-plane | 8080 | opencrane-system |
| mcp-gateway (Obot) | 8080 | opencrane-system |
| skill-registry | 5000 | opencrane-system |
| litellm | 4000 | opencrane-system |
| cognee | 8000 | opencrane-system |
| Postgres (CNPG) | 5432 | opencrane-system |
| openclaw-`<tenant>` (per-org) | 18789 | opencrane-`<org>` |

Tenant (openclaw) pods run in per-org namespaces (`opencrane-<org>`), one pod per user. They have no Ingress and no public DNS record. The ClusterIP Service for each tenant pod is `openclaw-<tenant>`.

### The authenticated operator seam

The only path from the public internet into a tenant pod passes through three independent enforcement layers. All three must pass; any one failing closes the connection.

```
browser ─── wss://<org>.<base> + OIDC cookie ───► wildcard Ingress (*.<base>)
                                                       │
                                               gateway-proxy (in operator pod)
                                                       │
                                    ┌──────────────────┼──────────────────────┐
                                    │  Layer 1: NetworkPolicy (L4)             │
                                    │  admits TCP :18789 ONLY from             │
                                    │  namespace=opencrane-system,             │
                                    │  component=operator                      │
                                    └──────────────────┼──────────────────────┘
                                                       │
                                    ┌──────────────────┼──────────────────────┐
                                    │  Layer 2: trusted-proxy auth (L7)        │
                                    │  gateway accepts X-Forwarded-User only   │
                                    │  from GATEWAY_TRUSTED_PROXIES CIDR       │
                                    │  (dev: 10.8.0.0/14 = cluster pod CIDR)  │
                                    └──────────────────┼──────────────────────┘
                                                       │
                                    ┌──────────────────┼──────────────────────┐
                                    │  Layer 3: owner pinning (identity)       │
                                    │  allowUsers=[owner email] rejects any    │
                                    │  forwarded identity ≠ pod owner          │
                                    └──────────────────┼──────────────────────┘
                                                       │
                                              tenant OpenClaw pod :18789
```

**Layer 1 — NetworkPolicy (L4).** The operator builds and applies a per-tenant NetworkPolicy named `openclaw-<tenant>-gateway` (see [`apps/operator/src/tenants/deploy/network-policy.ts`](https://github.com/italanta/opencrane/blob/main/apps/operator/src/tenants/deploy/network-policy.ts)). It selects the tenant pod by its labels and admits ingress to port 18789 from exactly one source: pods with `component=operator` in the namespace labelled `kubernetes.io/metadata.name=opencrane-system`. No other in-cluster pod can reach the gateway port. Without this policy, any pod that knew the ClusterIP could assert an arbitrary `X-Forwarded-User` header and be trusted.

**Layer 2 — trusted-proxy auth (L7).** The OpenClaw gateway runs in `trusted-proxy` mode and accepts the `X-Forwarded-User` identity header only from sources listed in `GATEWAY_TRUSTED_PROXIES` (the cluster pod CIDR; dev = `10.8.0.0/14`). OpenClaw fails closed on an empty `trustedProxies` list.

**Layer 3 — owner pinning.** `gateway.auth.trustedProxy.allowUsers` is rendered by the operator to contain only the pod owner's email. Any `X-Forwarded-User` that does not match is rejected at the pod. This is a cross-tenant guard that is independent of routing: even if the proxy ever mis-routed a socket to the wrong pod, the pod would reject the mismatched identity.

The security argument for this three-layer seam is detailed in [connection security](/security/connection-security) and [authentication](/security/identity).

### Plane ingress NetworkPolicies

The chart renders per-plane ingress NetworkPolicies when `networkPolicy.enabled` is true (see [`platform/helm/templates/networkpolicy-planes.yaml`](https://github.com/italanta/opencrane/blob/main/platform/helm/templates/networkpolicy-planes.yaml)).

| Policy | Protects | Admits ingress from |
|--------|----------|---------------------|
| `*-control-plane-ingress` | control-plane :8080 | ingress-nginx namespace + operator + mcp-gateway + skill-registry + tenant pods (contract re-pull) |
| `*-mcp-gateway-ingress` | mcp-gateway :8080 | tenant pods + control-plane + operator |
| `*-skill-registry-ingress` | skill-registry :5000 | tenant pods + control-plane + operator |
| `*-skill-oci-ingress` | skill OCI store | control-plane only |

Tenant pods reach the control plane to re-pull their effective contract (`GET /api/internal/contract/:name`); the policy allows this, and the handler enforces identity via TokenReview — so network and application auth are both in play.

Tenant-to-plane calls carry **audience-bound projected-identity tokens** mounted at `/var/run/opencrane/tokens`. The plane enforces app-level auth on these tokens in addition to the network-layer policy.

---

## The per-silo default-deny baseline

Each ClusterTenant (org) is modelled as a strictly isolated **silo**. The operator now emits a per-silo default-deny baseline `NetworkPolicy` in **every** ClusterTenant namespace as it provisions the silo — `_BuildSiloBaselineNetworkPolicy` (see [`apps/operator/src/tenants/deploy/silo-baseline-network-policy.ts`](https://github.com/italanta/opencrane/blob/main/apps/operator/src/tenants/deploy/silo-baseline-network-policy.ts)), named `opencrane-<cluster-tenant>-silo-baseline`.

The policy uses an **empty `podSelector`** (it selects every pod in the silo namespace) and names both `Ingress` and `Egress` in `policyTypes`, which flips the namespace to **default-deny**: anything not explicitly allowed below is dropped. The allow-list is the minimum a silo needs to function while staying isolated from every *other* silo — there is no silo→silo path because no rule ever names another silo namespace:

| Direction | Allowed | Why |
|-----------|---------|-----|
| Ingress | the same silo namespace (intra-silo) | pods within one org talk to each other |
| Ingress | the control-plane / operator namespace | the super-admin plane is the only principal allowed to reach inward (it brokers the gateway connection) |
| Egress | cluster DNS (`kube-system`, UDP/TCP 53) | without this every name lookup fails and the pod is dead |
| Egress | the same silo namespace + the control-plane / operator namespace | reach the shared planes (control-plane, Obot/MCP, skill-registry, LiteLLM, Cognee) in the shared tier |
| Egress | external HTTPS (TCP 443) | the agent legitimately calls out to LLM / MCP / Git endpoints |

This **replaces the retired `opencrane-tenant-default` policy**, which sat in the install namespace (`opencrane-system`) and selected tenant pods cluster-wide by `app.kubernetes.io/component=tenant` — so it governed nothing in the per-org namespaces where tenant pods actually run, leaving egress unrestricted there. The operator now emits one correctly-scoped policy per silo namespace it provisions, so egress (DNS + HTTPS only) and east-west default-deny are enforced in the right place. The companion per-tenant gateway policy (`openclaw-<tenant>-gateway`, [Layer 1](#the-authenticated-operator-seam) above) narrows the gateway *port* to the operator on top of this baseline; `NetworkPolicy` rules are additive, so the two compose.

::: tip Enforcement is CNI-dependent
This baseline is an **L3/L4** floor — a namespace-scoped, port-keyed allow-list. It only takes effect on a `NetworkPolicy`-enforcing CNI: GKE Dataplane V2 (and Autopilot) enforce it inherently; Calico/Cilium do elsewhere. On a CNI that does not enforce `NetworkPolicy`, the floor is inert.
:::

### Identity-aware L7 isolation is coming (Linkerd)

The baseline above is keyed on namespaces and ports, not on **workload identity**, and it cannot express L7 (per-route) authorization. The next layer of the silo model adds a [Linkerd](https://linkerd.io) service mesh on top of this floor: the operator will annotate each silo namespace `linkerd.io/inject: enabled` (giving every silo workload an mTLS identity bound to its service account) and emit a Linkerd `Server` + `AuthorizationPolicy` per silo expressing the same default-deny + allow-super-admin posture at the request layer. The rollout is **additive** — the `NetworkPolicy` floor stays in place as defence-in-depth, and a silo gains identity/L7 isolation as it is meshed, never going below the floor described here. See [ADR 0001 — ClusterTenant-as-virtual-network strict isolation](https://github.com/italanta/opencrane/blob/main/docs/adr/0001-cluster-tenant-virtual-network-isolation.md) for the substrate decision and why Linkerd (portable, no cloud lock-in) was chosen.

For fine-grained egress FQDN filtering (e.g. allowing only `api.openai.com`), an operator can additionally bind an `AccessPolicy` with `egressRules`, or apply a `CiliumNetworkPolicy` with `spec.domains.allow` on a Cilium-enabled cluster.

---

## Current enforcement status and known gaps

The following gaps are honest assessments verified against the live codebase. They do not undermine the overall isolation model but operators should be aware of them.

**litellm, langfuse, and the otel-collector have no ingress NetworkPolicy.** The plane ingress policies cover the control plane, mcp-gateway, skill-registry, and OCI store. LiteLLM, Langfuse, and the OTEL collector are not yet covered by a corresponding ingress policy — a defence-in-depth gap. Application-level auth still applies on those services.

**Plane ingress rules use tenant podSelectors without a namespaceSelector.** The rules admitting tenant pods to the control plane and plane services select by `app.kubernetes.io/component=tenant` without scoping to the correct namespace. In a multi-instance cluster, a tenant pod from a different instance's namespace could match. This is a multi-instance hygiene gap; the fix is to also add a `namespaceSelector` that constrains to the instance's own org namespaces.

**Identity-aware L7 enforcement is not yet live.** Until the Linkerd layer lands, cross-silo isolation rests on the L3/L4 baseline alone — robust against routing position but not yet expressing per-workload identity or per-route authorization. The super-admin namespace is trusted as a whole at L3/L4; L7 will narrow that to the super-admin *identity*.

---

## See also

- [Identity & connection auth](/security/identity) — credential types, OIDC session, projected-identity tokens, and the identity-routing proxy flow
- [Connection security](/security/connection-security) — the full CONN.9/CONN.10 threat model, the trusted-proxy auth decision record, and the transport hardening posture
- [DNS configuration](/operators/dns-config) — external-dns setup, cert-manager issuers, and the zone-write identity model
- [Hosting & deployment](/operators/hosting) — ingress class, TLS cert modes, cloud hosting adapters
- [ADR 0001 — ClusterTenant-as-virtual-network strict isolation](https://github.com/italanta/opencrane/blob/main/docs/adr/0001-cluster-tenant-virtual-network-isolation.md) — the substrate decision behind the per-silo baseline and the coming Linkerd L7 layer
