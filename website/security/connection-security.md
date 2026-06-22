# OpenClaw connection — security considerations

**Status:** **proxy model live** (cutover completed 2026-06). The identity-routing
gateway proxy is the current gateway path. This document records the connection/auth
posture between the browser and a user's **OpenClaw pod**, brokered by the **OpenCrane
control plane**.

All protocol claims are grounded in the published docs
([gateway/protocol](https://docs.openclaw.ai/gateway/protocol),
[channels/pairing](https://docs.openclaw.ai/channels/pairing)); items we could
not confirm are flagged **[unconfirmed]**.

---

## 0. Current model — identity-routing gateway proxy

The gateway cutover is done. The proxy is the live path; per-user Ingresses and the
nginx `auth_request → /auth/gateway-verify` hook are retired.

### 0.1 How it works

Every user in an org connects to the **single org host** `<org>.<base>`. The app UI,
`/api/*`, and the gateway WebSocket are same-origin under that host. A dedicated
**identity-routing gateway proxy** sits between the wildcard Ingress and each user's
OpenClaw pod:

```
Browser
  │
  │  wss://<org>.<base>/gateway
  ▼
Wildcard Ingress  (<org>.<base>, covered by *.<base> cert)
  │
  ▼
Identity-routing gateway proxy
  │
  ├─ 1. Origin allowlist (CSWSH guard)
  │      Fail closed on missing or non-allowlisted Origin.
  │
  ├─ 2. GET /api/v1/auth/gateway-resolve  (delegated auth)
  │      Replay session cookie → control plane
  │      Returns: { user: { email, sub },
  │                 tenant: { name, clusterTenantRef },
  │                 podService: { name, namespace } }
  │      401/403 → refuse. Any other non-200 → 502 (fail closed).
  │
  ├─ 3. Per-identity rate limit
  │      Keyed on the resolved email; abuse backstop.
  │
  └─ 4. WS reverse-proxy to  ws://openclaw-<user>.<ns>.svc:<port>
         Strip any client-supplied X-Forwarded-User first (header hygiene),
         then inject X-Forwarded-User: <verified email>
         so the pod trusts only the control-plane-resolved identity.
         The pod also self-enforces via its allowUsers list (CONN.10, §0.2).
```

The proxy holds **no session state**. It replays only the upgrade request's `Cookie`
header to the control plane and is the sole authority for routing decisions. The
control plane is stateless with respect to live WebSocket connections.

### 0.2 Pod-level owner pinning (CONN.10)

Even with the proxy's trusted header in place, each OpenClaw pod enforces its own
`allowUsers` list — it only accepts sessions for the user(s) it was provisioned for.
This means a misconfigured or compromised proxy cannot route one user's socket into
another user's pod. The control plane and the pod are two independent enforcement
points, defence-in-depth.

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

### 0.1 Identity-routing gateway proxy — single per-org host (DOMAIN.T4)

The next step replaces per-user subdomains (`<user>.<org>.<base>`) with **one host
per org** (`<org>.<base>`): the app UI, `/api/*`, and the gateway WebSocket are all
served **same-origin** under that host, and an in-cluster **identity-routing proxy**
forwards each user's gateway socket to their own pod. The proxy is a thin,
logic-free choke point — it holds **no session store and no secrets**, delegating
every decision to the control plane (the same delegate-auth shape as the nginx
`auth_request`, so the express session store is never shared across services).

On each gateway WS upgrade the proxy, in order:

1. **Origin allowlist (CSWSH).** It checks the `Origin` header against an exact
   allowlist and refuses anything else. WebSocket upgrades are **not** covered by
   CORS, and the browser sends the session cookie automatically cross-site — so this
   allowlist is the *only* server-side defence against Cross-Site WebSocket
   Hijacking. It **fails closed**: a missing or non-allowlisted Origin is rejected,
   and an empty allowlist refuses every upgrade.
2. **Delegated auth + routing.** It calls the control plane's
   `GET /api/v1/auth/gateway-resolve`, replaying **only** the cookie. The control
   plane verifies the session and resolves `{ user, tenant, podService }` from the
   IdP-verified email via the **same fail-closed email→tenant rule** as `/pod-token`
   — no request-supplied tenant input, and a missing/ambiguous mapping returns
   **403**. The proxy makes no authorization decision itself.
3. **Per-identity rate limit.** A per-replica fixed-window counter keyed on the
   resolved identity bounds how many sockets one user opens per minute.
4. **Forward** to the resolved pod's cluster-internal Service
   (`openclaw-<user>.<ns>.svc:<gatewayPort>`).

**Defence in depth.** Cross-tenant safety now rests on **two independent layers**:
the proxy's `gateway-resolve` (routing level) *and* per-pod owner pinning (CONN.10,
pod level). Neither the routing layer nor the pod will serve a foreign user, and
either alone is sufficient — so a bug in one is not a breach.

**Same-origin cookie.** Because everything is served under the one org host, the
OIDC session cookie is **host-scoped** to `<org>.<base>` — never the parent
`.<base>` — so a cookie minted for one org cannot be replayed at another. (Cutover
prerequisite: the OIDC redirect-URI allowlist must accept the per-org hosts.)

**Status.** The proxy service (`@opencrane/gateway-proxy`) and the
`gateway-resolve` endpoint are **built and tested**; the proxy is shipped behind
`gatewayProxy.enabled` (off by default). The remaining cutover work — one per-org
Ingress that path-routes `/api`/UI/gateway-WS, retiring the operator's per-user
Ingress + per-user DNS/cert, and confirming multi-host OIDC redirects — is tracked
as the final DOMAIN.T4 slice. Until it lands, routing stays per-user-subdomain and
this proxy is dormant.

---

## 1. How the connection works today

See [§0](#_0-adopted-model-trusted-proxy-gateway-auth-per-pod-owner-pinning-conn-9-conn-10)
for the authoritative description. In brief:

```
SaaS ──OpenAPI (OIDC session)──▶ OpenCrane  POST /auth/pod-token
   │                                   └─ { gatewayUrl, bootstrapToken, tenant }
   └──wss://<org>.<base>/gateway──▶ Wildcard Ingress
                                      └──▶ Gateway proxy (auth → route)
                                            └──▶ tenant OpenClaw pod
```

1. The browser, authenticated by its OIDC session, asks OpenCrane for the pod's
   **pairing link** (`{ url, bootstrapToken }`). OpenCrane resolves it for the
   caller's own tenant only (fail-closed on an ambiguous email→tenant mapping).
2. The browser opens the gateway WebSocket (at `<org>.<base>/gateway`). The proxy
   authenticates the upgrade via `gateway-resolve`, then reverse-proxies the socket
   to `openclaw-<user>.<ns>.svc`, injecting the verified `X-Forwarded-User` header.
3. The OpenClaw pod runs the **`connect` handshake** with the client: answers a
   `connect.challenge` nonce, receives `connect` with the bootstrap (or persisted
   device) token, and on `hello-ok` sends a **device token** the client persists for
   reconnects.

**Topology:** there is **one OpenClaw pod per tenant** (`openclaw-<tenant>`), and
tenants resolve 1:1 from a user's verified email. Every user in an org connects
through the single org host; the proxy routes them to the right pod.

---

## 2. The credential model *(historical — the retired bootstrap/device-token design)*

> **Decision record, not current state.** The credentials below were **retired in
> CONN.3** and no longer exist in the codebase. The live model holds **no token in
> the browser** (see [§0](#_0-adopted-model-trusted-proxy-gateway-auth-per-pod-owner-pinning-conn-9-conn-10)).
> This table records the credential-theft risk of the old design — the analysis
> that motivated moving to session-authorised trusted-proxy auth.

| Credential | Lifetime | Where it lived | Risk |
|---|---|---|---|
| **Bootstrap token** | Short-lived, single-device | Transient — broker → browser → spent at handshake | **Low.** HTTPS to an already-authenticated browser; usable only to *open* one pairing, then consumed. |
| **Device token** (`hello-ok`) | **No documented TTL** — long-lived | Browser `localStorage` | **High.** Persistent bearer credential; XSS-exfiltratable; grants `operator.read/write` until explicitly revoked. The weakest link — and the reason this design was retired. |

The bootstrap profile auto-granted `node` + bounded `operator`
(read/write/approvals); `operator.admin`/`operator.pairing` needed a separate
approved pairing — so the browser deliberately **could not** revoke or manage
devices. The device-signature scheme was **[unconfirmed]** (B1).

---

## 3. The two clocks (the crux) *(analysis of the retired token design)*

> **Decision record.** This reasons about the **retired** bootstrap-token handshake
> (§2). In the live §0 model there is no browser-held token, and "opening a
> connection" is gated by the OIDC session at the ingress rather than a minted
> token. The "Clock 2" socket-lifetime analysis below still holds — a live socket
> runs unbounded regardless of how it was authorised — and it is what motivates the
> §5 Kubernetes force-disconnect levers.

A token and a socket run on **two independent clocks**; the token only controlled
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
| **NetworkPolicy deny-ingress on the pod** | Per-tenant | ⚠️ **CNI-dependent** | Calico/Cilium evaluate existing flows via conntrack/eBPF and *can* drop established connections on policy change; some CNIs only affect new connections. Faster than a restart and preserves pod state. Source cannot be one browser (traffic arrives via the proxy), so it's all-or-nothing for that pod. |
| **Cilium / eBPF policy** | Per-tenant / per-identity | ✅ (drops established flows) | Most reliable at terminating in-flight connections; identity-aware. Still per-pod, not per-WS-session. |
| **conntrack delete** (`conntrack -D`) on the node + drop rule | Per-flow (5-tuple) | ✅ | Node-level, needs the 5-tuple; operationally hairy, not a clean API. |
| **Proxy connection drain** | **Per-session** | ✅ via proxy admin | The gateway proxy holds the live socket; draining the proxy connection severs the session surgically without touching the pod. |

### The deployable play with the proxy
The proxy model already sits between the client and the pod. For a per-user instant
cut:

1. **Revoke** — call `device.token.revoke` + `device.pair.remove` (blocks re-auth).
2. **Force-disconnect** — drain the proxy connection for that session, or delete the
   tenant pod / apply a deny NetworkPolicy (Cilium/Calico) to drop the live socket.
3. Attacker's socket dies and **cannot be re-opened** (revoked; no bootstrap
   issued). A short `tickIntervalMs` (§4) makes any half-open client give up fast.

This needs only modest additions to OpenCrane: `networkpolicies` + `pods/delete`
RBAC, a small "cut tenant" admin action, and the `operator.pairing`-scoped identity
to call revoke. **[unconfirmed]:** whether the cluster CNI drops established
connections on NetworkPolicy change — verify against the deployed CNI;
pod-delete is the CNI-independent fallback.

---

## 6. The options

### Option A — Direct connect, persisted device token *(superseded)*
- ➖ Long-lived stealable credential in the browser; live-cut only via §5.
- ➕ Simplest; control plane stateless.
- **Verdict:** stepping stone only; superseded.

### Option B — Direct connect, short single-use tokens, no browser persistence
- ➕ Removes the credential-theft prize; zero new stateful infra.
- ➕ **With §5 (revoke + K8s cut), gains a per-tenant instant live-cut.**
- ➖ Live-cut granularity is per-tenant, not per-session; CNI-dependent unless using
  pod-delete; no standing per-frame audit/choke point.
- **Verdict:** strong, cheap; meets incident-response needs if per-user cutting is
  acceptable. The credential hardening (short single-use bootstrap, no persisted
  device token) should be adopted regardless of which routing model is in use.

### Option C — Identity-routing gateway proxy *(current model)*
- ➕ No browser-held pod credential needed at connection time; **per-session** routing
  is possible; single standing point to defend / audit / rate-limit; pod lockable to
  proxy-only.
- ➕ **Implemented and live** — the proxy is the current gateway path.
- ➖ The app tier is **connection-aware** at the proxy: a live WebSocket is a
  process-bound socket — replicas require care around draining on deploy.
- ➖ Message content transits the proxy (the control plane's cluster-internal network).
- **Verdict:** adopted. Combine with Option B's credential hardening for defence-in-depth.

---

## 7. Comparison

| Property | A: persisted token | B: short tokens + §5 | C: proxy (current) |
|---|---|---|---|
| Long-lived browser credential | ❌ yes | ✅ none | ✅ none |
| Bounds credential replay window | ❌ no | ✅ ~60s | ✅ n/a |
| Instant live-session cut | ⚠️ pod-restart only | ✅ per-tenant (revoke + K8s) | ✅ per-session via proxy drain |
| Cut one of a user's many sessions | ❌ | ❌ | ✅ |
| Standing choke point / per-frame audit | ❌ | ❌ | ✅ |
| App tier stays *connection*-stateless | ✅ | ✅ | ➖ proxy holds process-bound sockets |
| Chat available during a proxy outage | ✅ | ✅ | ⚠️ down during outage, no data loss |
| Message content avoids our servers | ✅ | ✅ | ➖ transits proxy |

---

## 8. Man-in-the-middle on a hostile network (e.g. airport WiFi)

Every leg rests on **TLS + the browser's certificate validation**: browser ⇄
OpenCrane (`POST /auth/pod-token`, OIDC session), browser ⇄ org gateway WS
(`wss://<org>.<base>/gateway`, covered by the `*.<base>` wildcard cert), browser ⇄
IdP (OIDC login). A vanilla airport attacker (no certificate the browser trusts)
**cannot** read or alter any leg — TLS defeats them and the browser rejects forged
certs.

Note the device nonce-signing in the `connect` handshake is **authentication, not
channel binding**: it stops replay of a captured signature against a *different*
nonce, but does **not** stop a real-time relay once TLS is broken. So TLS is the
whole ballgame, and the realistic attacks are the ones that remove it:

- **(a) SSL-strip / downgrade — the airport classic.** The attacker keeps the
  victim on `http://` and proxies plaintext, harvesting the OIDC **session cookie**
  and any **bootstrap token** in flight. Defense: **HSTS** (browser refuses
  `http://` and refuses cert-error bypass) + never serving HTTP. **Gap — §9: the
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
case); browser⇄proxy → message content + any handshake token exposed.

---

## 9. Transport hardening — current posture & gaps

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
5. Adopt Option B's credential hardening (short single-use bootstrap, no persisted
   device token) in addition to the proxy.

## Open dependencies / unknowns

- **B1** — device-signature scheme (algorithm/encoding/signed-bytes) unconfirmed.
- **B2** — whether bootstrap-token TTL and `tickIntervalMs` are configurable by
  OpenCrane per pod.
- **CNI behaviour** — does the deployed CNI drop *established* connections on a
  NetworkPolicy change? Verify; else use pod-delete.
- **RBAC** — to enable the §5 force-disconnect, OpenCrane needs `networkpolicies`
  (create/delete) and `pods` (delete), plus an `operator.pairing`-scoped device per
  pod for revoke.
- **Force-disconnect** — no gateway API to drop one live socket individually; proxy
  drain (§5) or pod-level levers are the current options.

## Sources
- OpenClaw Gateway protocol — https://docs.openclaw.ai/gateway/protocol
- OpenClaw device pairing — https://docs.openclaw.ai/channels/pairing
- Gateway proxy source — `apps/gateway-proxy/src/proxy.ts`, `apps/gateway-proxy/src/auth-client.ts`
