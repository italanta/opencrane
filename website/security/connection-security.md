# OpenClaw connection — security considerations

**Status:** **decided — Option B** (2026-06); see [Decision](#decision-2026-06--option-b).
This document records the connection/auth posture between the **SaaS operator**
(browser) and a tenant's **OpenClaw pod**, brokered by the **OpenCrane control
plane**. The concern lives in the control plane (issuance, revocation, and the
Kubernetes substrate), hence this doc is here rather than in the frontend repo.

All protocol claims are grounded in the published docs
([gateway/protocol](https://docs.openclaw.ai/gateway/protocol),
[channels/pairing](https://docs.openclaw.ai/channels/pairing)); items we could
not confirm are flagged **[unconfirmed]**. The SaaS Operator-side implementation +
roadmap is tracked in that repo's `plan.md` (slices S1–S6, blockers B1–B5).

---

## Decision (2026-06) — Option B

**Chosen: Option B** — short-lived, re-brokered credentials (no long-lived token in
the browser) + a per-user central kill-switch (OpenClaw revoke + Kubernetes
force-disconnect), plus the transport hardening in §11. The control plane stays
**connection-stateless**. This covers credential theft, replay, hostile-network,
and per-user incident response with no new stateful infra and small effort, and it
is a strict prerequisite to the proxy anyway.

**Trade-offs we accepted:**
- Live-session cut is **per-user, not per-session** — incident response cuts *all*
  of an account's sessions (fine given the one-pod-per-tenant topology), not one
  device while leaving the user's others up.
- **No standing per-frame audit/policy choke point** — auditing is at issuance (the
  broker) plus OpenClaw/K8s events, not on the live message stream.
- Per-user cut via NetworkPolicy is **CNI-dependent**; pod-delete is the
  CNI-independent fallback.
- These are acceptable because the data/availability fears do **not** apply:
  transcripts live in the pod (no loss on a CP outage), and Postgres covers all
  durable data — what B preserves is *connection*-statelessness.

**Proxy (Option C) — long-term vision, not adopted now.** Revisit **only if** a hard
requirement emerges for per-session cutting or a standing per-frame audit/policy
point, **and** the computational/operational cost is judged worth it (a
connection-stateful app tier: LB affinity, reconnect storms on every deploy;
message content transiting the CP; ~days of build). If that day comes, prefer an
**Envoy/mesh sidecar** over a bespoke control-plane proxy. Option B is a strict
prerequisite, so nothing built for B is wasted.

Build slices: frontend repo `plan.md` — **S5** (Option B) and **S6** (proxy vision).

---

## 0. Adopted model — trusted-proxy gateway auth + per-pod owner pinning (CONN.9 / CONN.10)

> This supersedes the bootstrap-/device-token mechanics described in §1–§3 below
> (retired in CONN.3): there is **no token in the browser at all**. Those sections
> are kept as the decision record for the credential-theft analysis; the live
> connection model is the one described here.

**How a connection is authorised today:**

1. The browser opens the pod's gateway WebSocket (`wss://<host>`). It holds **no
   pod credential** — only its OIDC **session cookie**.
2. The pod's ingress runs an `auth_request` against the control plane
   (`GET /api/v1/auth/gateway-verify`). A live session → `204` and the verified
   email is copied into the upstream `X-Forwarded-User` header (any client-supplied
   value is stripped — header hygiene); no session → `401` and the upgrade is
   refused. This is the **central cut**: revoke the session and re-connects stop.
3. The gateway runs in **trusted-proxy** auth mode and trusts the injected
   `X-Forwarded-User` as the authenticated identity.

**The owner-pinning guard (CONN.10).** Trusted-proxy mode trusts *whatever* identity
the proxy injects — so on its own it does **not** verify that the identity matches
the pod's owner. Because there is **one pod per tenant** and the pod holds that
owner's mounted secrets, MCP connections, and model keys, any authenticated user
who reached another tenant's pod would be accepted as themselves — a cross-tenant
gap. We close it at the pod with OpenClaw's
[`gateway.auth.trustedProxy.allowUsers`](https://docs.openclaw.ai/gateway/trusted-proxy-auth):
the operator renders the pod's **owner email** into the allowlist, so the gateway
**rejects any `X-Forwarded-User` that isn't the owner**.

```jsonc
// per-tenant openclaw.json (rendered by the operator)
"gateway": {
  "auth": {
    "mode": "trusted-proxy",
    "trustedProxy": {
      "userHeader": "X-Forwarded-User",
      "allowUsers": ["owner@example.com"]   // the tenant's verified owner email
    }
  }
}
```

The allowlist is normalised the **same way** `gateway-verify` normalises the
injected identity — `email.trim().toLowerCase()` — or a case/whitespace mismatch
would lock the owner out.

**Why this matters for routing.** Ownership is now enforced **server-side at the
pod**, independent of *how* the connection is routed. Today routing is by hostname
(`<user>.<org>.<base>` → that user's pod); the guard means a user who connects to
someone else's host is rejected by the pod rather than silently admitted. It is
also the prerequisite that makes **collapsing per-user subdomains** safe — once the
pod self-enforces its owner, an identity-routing proxy on a single per-org host
carries no new cross-tenant risk. See the domain topology design for that step.

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
- ➖ The app tier stops being **connection-stateless**: a live WebSocket is a
  process-bound socket — it **cannot** be offloaded to Postgres, so replicas are no
  longer fungible (LB affinity required, no drain/autoscale without dropping
  sockets, a deploy drops every socket it holds → reconnect storm). *Durable data*
  (registry/audit) is unaffected — that's just rows in Postgres, which the CP
  already has.
- ➖ **Availability, not durability:** if the proxy is down, chat is unavailable
  *during* the outage, but nothing is lost — transcripts live in the pod and the
  client re-fetches on reconnect. Worst case is an interrupted in-flight turn to
  re-issue (**[unconfirmed]** whether OpenClaw keeps the agent run going detached
  from the socket; if it does, even that survives). Cost is uptime during
  outages/deploys, recoverable.
- ➖ Message content **transits** the CP; ~days of build (WS server + Node
  handshake; cross-repo/AGPL boundary → reimplement or extract a shared MIT package).
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
| App tier stays *connection*-stateless ¹ | ✅ | ✅ | ❌ holds process-bound sockets |
| Chat available during a CP outage ² | ✅ | ✅ | ⚠️ down during outage, no data loss |
| Message content avoids our servers | ✅ | ✅ | ➖ transits |
| Build effort | — (built) | small (+ RBAC/admin action) | moderate (~days) |

¹ *Durable data state is a non-issue for all three — the CP already has Postgres,
and a device registry/audit is just rows. "Connection-stateless" is the distinct
property the proxy gives up: an open WebSocket is bound to one process and can't be
offloaded to the DB, so replicas stop being fungible (LB affinity, no clean
drain/autoscale, deploy = reconnect storm).*

² *A CP outage with the proxy is an availability gap, not data loss — transcripts
live in the pod and resume on reconnect; at worst an in-flight turn is re-issued
(**[unconfirmed]** whether OpenClaw continues a detached agent run). "Repair later"
is accurate; the cost is uptime during outages/deploys.*

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

## 10. Man-in-the-middle on a hostile network (e.g. airport WiFi)

Every leg rests on **TLS + the browser's certificate validation**: browser ⇄
OpenCrane (`POST /auth/pod-token`, OIDC session), browser ⇄ OpenClaw pod gateway
(WSS), browser ⇄ IdP (OIDC login). A vanilla airport attacker (no certificate the
browser trusts) **cannot** read or alter any leg — TLS defeats them and the
browser rejects forged certs.

Note the device nonce-signing in the `connect` handshake is **authentication, not
channel binding**: it stops replay of a captured signature against a *different*
nonce, but does **not** stop a real-time relay once TLS is broken. So TLS is the
whole ballgame, and the realistic attacks are the ones that remove it:

- **(a) SSL-strip / downgrade — the airport classic.** The attacker keeps the
  victim on `http://` and proxies plaintext, harvesting the OIDC **session cookie**
  and any **bootstrap token** in flight. Defense: **HSTS** (browser refuses
  `http://` and refuses cert-error bypass) + never serving HTTP. **Gap — §11: the
  app does not set HSTS.**
- **(b) Cert-warning click-through.** HSTS removes the "accept anyway" option for
  known hosts. A managed device with an attacker/corporate **root CA installed**
  defeats TLS transparently — out of scope for airport WiFi, real for managed
  laptops; browser pinning is impractical, so this is an accepted residual.
- **(c) `ws://` downgrade.** A gateway URL that is `ws://` travels in plaintext.
  The broker derives `wss://…`; **harden it to reject `ws://`** so a poisoned
  pairing record can't open a cleartext socket.
- **(d) Captive portal.** Pre-TLS interception is normal; HSTS defends after the
  first secure visit, HSTS **preload** even the first.

**Blast radius if TLS is broken on a leg:** browser⇄OpenCrane → session cookie +
bootstrap token exposed → attacker pairs a device or impersonates the user (worst
case); browser⇄pod → message content + any handshake token exposed.

**What bounds the damage regardless of transport fixes:** the Option-B posture —
single-use ~60s bootstrap token and **no long-lived device token in the browser** —
makes a stripped credential near-useless within a minute, and revoke + K8s cut
(§5) closes the session. Another reason to adopt B's hardening regardless of A/C.

## 11. Transport hardening — current posture & gaps

OpenCrane terminates TLS at the **ingress** (`app.set("trust proxy", 1)`; the app
runs HTTP behind it). From the code:

| Control | Status | Where |
|---|---|---|
| Session cookie `HttpOnly` | ✅ | `oidc.service.ts` |
| Session cookie `SameSite=lax` | ✅ | `oidc.service.ts` |
| Session cookie `Secure` | ⚠️ **conditional** — on only when `OIDC_REDIRECT_URI` is `https://` (or `OIDC_COOKIE_SECURE=true`) | `oidc.config.ts` |
| **HSTS** (Strict-Transport-Security) | ❌ **not set by the app** (no helmet/HSTS) | — |
| HTTP→HTTPS redirect | ❌ not in app (relies on ingress) | — |
| `wss://`-only gateway URLs | ⚠️ derived as `wss://`, not enforced | broker / client |

Recommended (cheap, high-value for the hostile-network case):

1. **Set HSTS** (`max-age=63072000; includeSubDomains; preload`) via `helmet` in the
   app or confirmed at the ingress — the single most important downgrade fix.
   **[unconfirmed]** whether the ingress already sets it; verify, don't assume.
2. **Force `Secure` cookies in production** explicitly (fail closed, not inferred);
   consider a `__Host-` cookie prefix.
3. **App- or ingress-level HTTP→HTTPS redirect.**
4. **Reject non-`wss://`** gateway URLs in the broker and the client.
5. Adopt the Option-B credential posture so a momentary TLS failure leaks nothing
   long-lived.

## Sources
- OpenClaw Gateway protocol — https://docs.openclaw.ai/gateway/protocol
- OpenClaw device pairing — https://docs.openclaw.ai/channels/pairing
