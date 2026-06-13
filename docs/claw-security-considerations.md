# OpenClaw connection — security considerations

**Status:** decision pending. This document exists so the connection/auth posture
between **SaaS operator** (browser) and a tenant's **OpenClaw pod**, brokered by the
**OpenCrane control plane**, can be chosen deliberately. The concern lives in the
control plane (issuance, revocation, and the Kubernetes substrate), hence this
doc is here rather than in the frontend repo.

All protocol claims are grounded in the published docs
([gateway/protocol](https://docs.openclaw.ai/gateway/protocol),
[channels/pairing](https://docs.openclaw.ai/channels/pairing)); items we could
not confirm are flagged **[unconfirmed]**. The SaaS Operator-side implementation +
roadmap is tracked in that repo's `plan.md` (slices S1–S6, blockers B1–B5).

---

## 1. How the connection works today

```
SaaS ──OpenAPI (OIDC session)──▶ OpenCrane  POST /auth/pod-token
   │                                   └─ { gatewayUrl, bootstrapToken, tenant }   (the pairing link, brokered)
   └──Gateway v4 WS: connect handshake + device pairing──▶ tenant OpenClaw pod
```

1. The browser, authenticated by its OIDC session, asks OpenCrane for the pod's
   **pairing link** (`{ url, bootstrapToken }`). OpenCrane resolves it for the
   caller's own tenant only (fail-closed on an ambiguous email→tenant mapping).
2. The browser opens the gateway WebSocket and runs the **`connect` handshake**:
   answers a `connect.challenge` by signing the nonce with a persistent device
   key, sends `connect` with the bootstrap (or persisted device) token, and on
   `hello-ok` receives a **device token** it persists for reconnects.

**Topology that matters for everything below:** there is **one OpenClaw pod per
tenant** (`openclaw-<tenant>`), and tenants resolve 1:1 from a user's verified
email. So "the tenant's pod" ≈ "one user's pod" — per-tenant actions are
effectively per-user.

---

## 2. The credential model

| Credential | Lifetime | Where it lives | Risk |
|---|---|---|---|
| **Bootstrap token** | Short-lived, single-device | Transient — broker → browser → spent at handshake | **Low.** HTTPS to an already-authenticated browser; usable only to *open* one pairing, then consumed. |
| **Device token** (`hello-ok`) | **No documented TTL** — long-lived | Browser `localStorage` (current impl) | **High.** Persistent bearer credential; XSS-exfiltratable; grants `operator.read/write` until explicitly revoked. The weakest link. |

The bootstrap profile auto-grants `node` + bounded `operator` (read/write/approvals);
`operator.admin`/`operator.pairing` need a separate approved pairing — so the
browser deliberately **cannot** revoke or manage devices. The device-signature
scheme is **[unconfirmed]** (B1).

---

## 3. The two clocks (the crux)

A token and a socket run on **two independent clocks**; the token only controls
the first.

### Clock 1 — opening a connection (token)
Auth is checked **only at the handshake**; the gateway does **not** re-validate
mid-session. The token need only survive broker mint → browser → open WS →
complete `connect` ≈ **seconds**. So a bootstrap token can be **single-use +
~30–60s TTL**. **[unconfirmed]** whether OpenCrane can mint bootstrap tokens with
a chosen TTL (B2).

### Clock 2 — how long the socket then runs
Effectively **unbounded**. There is **no server-enforced maximum connection age
and no idle timeout** except one mechanism: a **tick-timeout** — the gateway
closes (WS code `4000`) only when a client is **silent** longer than
`tickIntervalMs × 2`. `hello-ok.policy` exposes `tickIntervalMs`, `maxPayload`
(default 25 MB), `maxBufferedBytes`.

**A short token bounds *opening* a session; it does nothing to a socket already
open.** Killing a live session needs something that acts on Clock 2.

---

## 4. Can we manipulate `tickIntervalMs` to make sockets acceptably short?

**No — not for the threat that matters.** `tickIntervalMs` is an **idle/liveness**
timeout, not a maximum session age. The socket only closes after silence exceeds
`2 × tickIntervalMs`. An actively-held socket — exactly what a hijacker has — just
keeps emitting ticks and **stays connected indefinitely**, no matter how small we
set the interval. There is no mid-session re-auth to piggyback on.

What shortening it *does* buy (set via the pod's gateway config, which OpenCrane
provisions — exact knob **[unconfirmed]**):

- **Reaps abandoned/idle sockets faster** — a forgotten tab, or a stolen socket
  the attacker is *not* actively keeping warm, dies in seconds instead of never.
- **Tighter liveness signal** for our own monitoring.

What it does **not** do: bound or cut an attacker who keeps ticking. **Do not rely
on `tickIntervalMs` for incident response.** Its real value is in combination with
a network-layer cut (§5): once we sever the socket at L3/L4, a short tick-timeout
ensures the *other* side also gives up promptly rather than half-open.

---

## 5. Kubernetes network levers — the force-disconnect OpenClaw lacks

OpenClaw exposes `device.token.revoke` / `device.pair.remove` / `device.pair.list`
/ `device.token.rotate` (require `operator.pairing` ± `operator.admin`), **but
revocation "prevents future authentication and does not terminate active
sessions,"** and there is **no documented force-disconnect** for a single live
socket. The control plane runs the pods on Kubernetes, so the substrate can supply
the missing force-disconnect. Options, coarse → surgical:

| Lever | Granularity | Cuts live sockets? | Notes |
|---|---|---|---|
| **Delete/restart the tenant pod** (`kubectl delete pod` / scale 0) | **Per-tenant** (= per-user) | ✅ immediately | No new infra; OpenCrane already has pod-management RBAC. Pod restarts (or stays down). Because pods are per-tenant, this is **not** fleet-wide — it severs exactly that user's sessions. |
| **NetworkPolicy deny-ingress on the pod** | Per-tenant | ⚠️ **CNI-dependent** | Calico/Cilium evaluate existing flows via conntrack/eBPF and *can* drop established connections on policy change; some CNIs only affect new connections. Faster than a restart and preserves pod state. Source cannot be one browser (traffic arrives via ingress), so it's all-or-nothing for that pod. |
| **Cilium / eBPF policy** | Per-tenant / per-identity | ✅ (drops established flows) | Most reliable at terminating in-flight connections; identity-aware. Still per-pod, not per-WS-session. |
| **conntrack delete** (`conntrack -D`) on the node + drop rule | Per-flow (5-tuple) | ✅ | Node-level, needs the 5-tuple; operationally hairy, not a clean API. |
| **Service-mesh / Envoy sidecar in front of the pod** | **Per-connection** | ✅ via xDS/admin drain | A standing L7 cut-point without building an app proxy; can also re-check auth (ext_authz). This is the "proxy" benefit at the infra layer. |

### The deployable play **without** a proxy
Because pods are per-tenant, OpenCrane can deliver a **per-user instant cut today**
by combining its two existing capabilities:

1. **Revoke** — call `device.token.revoke` + `device.pair.remove` (blocks re-auth).
2. **Force-disconnect** — delete the tenant pod *or* apply a deny NetworkPolicy
   (Cilium/Calico) to drop the live socket(s).
3. Attacker's socket dies and **cannot be re-opened** (revoked; no bootstrap
   issued). A short `tickIntervalMs` (§4) makes any half-open client give up fast.

This needs only modest additions to OpenCrane: `networkpolicies` + `pods/delete`
RBAC, a small "cut tenant" admin action, and the `operator.pairing`-scoped
identity to call revoke. **[unconfirmed]:** whether the cluster CNI drops
established connections on NetworkPolicy change — verify against the deployed CNI;
pod-delete is the CNI-independent fallback.

**Granularity ceiling:** L3/L4 levers act **per-pod (= per-tenant/user)**, not per
WebSocket session. Cutting *one* of a user's several tabs/devices while leaving the
others up requires session awareness — i.e., the proxy or a mesh sidecar.

---

## 6. The options

### Option A — Direct connect, persisted device token *(current impl)*
- ➖ Long-lived stealable credential in the browser; live-cut only via §5.
- ➕ Simplest; control plane stateless.
- **Verdict:** stepping stone only; remove the persisted credential.

### Option B — Direct connect, short single-use tokens, no browser persistence *(plan.md S5-1)*
- ➕ Removes the credential-theft prize; zero new stateful infra.
- ➕ **With §5 (revoke + K8s cut), gains a per-tenant instant live-cut.**
- ➖ Live-cut granularity is per-tenant, not per-session; CNI-dependent unless using
  pod-delete; no standing per-frame audit/choke point.
- **Verdict:** strong, cheap; meets incident-response needs **if per-user (not
  per-session) cutting is acceptable.**

### Option C — Control-plane WebSocket proxy *(plan.md S6)*
- ➕ No browser-held pod credential at all; **per-session** surgical instant cut;
  single standing point to defend / audit / rate-limit; pod lockable to CP-only.
- ➖ Control plane becomes **stateful, on the critical path** (~2 sockets/user,
  connection-count scaling, reconnect storms, CP-down = chat-down); message content
  transits the CP; ~days of build (WS server + Node handshake; cross-repo/AGPL
  boundary → reimplement or extract a shared MIT package).
- **Verdict:** strongest posture; warranted for per-session control or a standing
  audited choke point. A **mesh/Envoy sidecar (§5)** delivers much of this without
  app code if a mesh is already in play.

---

## 7. Comparison

| Property | A: persisted token | B: short tokens + §5 | C: proxy / mesh |
|---|---|---|---|
| Long-lived browser credential | ❌ yes | ✅ none | ✅ none |
| Bounds credential replay window | ❌ no | ✅ ~60s | ✅ n/a |
| Instant live-session cut | ⚠️ pod-restart only | ✅ per-tenant (revoke + K8s) | ✅ per-session |
| Cut one of a user's many sessions | ❌ | ❌ | ✅ |
| Standing choke point / per-frame audit | ❌ | ❌ | ✅ |
| Control plane stays stateless | ✅ | ✅ | ❌ |
| Chat survives control-plane outage | ✅ | ✅ | ❌ |
| Message content avoids our servers | ✅ | ✅ | ➖ transits |
| Build effort | — (built) | small (+ RBAC/admin action) | moderate (~days) |

---

## 8. The deciding question

> **What live-cut granularity does incident response require?**

- **Per-user is enough** ("this account is compromised — cut all its sessions") →
  **Option B + §5.** Keep the control plane stateless; cut via revoke + pod-delete
  (CNI-independent) or NetworkPolicy. This is the recommended default given the
  per-tenant pod topology.
- **Per-session, or a standing audited choke point, is required** → **Option C**
  (control-plane proxy, or a mesh/Envoy sidecar if already on a mesh). Accept the
  stateful-CP weight.

**Do regardless:** Option B's hardening (drop browser persistence, short single-use
tokens) — strictly better than A and a prerequisite to either path. And add the
§5 capability (revoke + K8s cut) since it's cheap and turns "pod restart" into a
deliberate, scriptable kill-switch.

---

## 9. Open dependencies / unknowns

- **B1** — device-signature scheme (algorithm/encoding/signed-bytes) unconfirmed.
- **B2** — provisioning path for the pairing link, and whether bootstrap-token TTL
  and `tickIntervalMs` are configurable by OpenCrane per pod.
- **CNI behaviour** — does the deployed CNI drop *established* connections on a
  NetworkPolicy change? Verify; else use pod-delete.
- **RBAC** — to enable §5, OpenCrane needs `networkpolicies` (create/delete) and
  `pods` (delete), plus an `operator.pairing`-scoped device per pod for revoke.
- **Force-disconnect** — no gateway API to drop one live socket; only `shutdown`
  (all), §5 (per-pod), or a proxy/mesh (per-session).

## Sources
- OpenClaw Gateway protocol — https://docs.openclaw.ai/gateway/protocol
- OpenClaw device pairing — https://docs.openclaw.ai/channels/pairing
