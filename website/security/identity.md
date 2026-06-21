# Authentication

How identities authenticate to OpenCrane and how a single human login grants
access to **both** the control-plane API and the user's own OpenClaw pod.

> **Terminology:** the per-user OpenClaw agent gateway is a **UserTenant** (the openclaw /
> `Tenant` CRD); "UserTenant" is the canonical doc name while the CRD kind is still `Tenant`
> in code. It is exposed at `<user>.<ClusterTenant-domain>`. The **ClusterTenant** is the
> customer that owns that base domain. See the authoritative
> [Tenancy Model](https://github.com/italanta/opencrane/blob/main/docs/agents/cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).
> Below, "tenant pod" / "tenant gateway" means a UserTenant.

> **Status legend:** ✅ implemented · 🔶 planned/target. The OIDC control-plane
> session and the pairing **broker** (`POST /api/v1/auth/pod-token`) are
> implemented today. The browser-side OpenClaw **connect handshake** (device
> signing) is implemented in WeOwnAI but cannot be verified end-to-end until the
> device-signature scheme and pod pairing-link provisioning land (see Blocked
> items). The connection-security posture is decided — **Option B**; see
> [`claw-security-considerations.md`](/security/connection-security).

## Two planes, one identity

OpenCrane has two backends a user touches, and they must not require two logins:

| Plane | What it serves | How it is reached |
|-------|----------------|-------------------|
| **Control plane** | management + metadata: tenants, policies, groups, budgets, skills, audit, auth | the versioned control-plane API (OIDC session) |
| **UserTenant pod (OpenClaw)** | the live agent session: chat, Cognee retrieval, canvas | the UserTenant's own `gatewayUrl` (`wss://<ingressHost>`, i.e. `<user>.<ClusterTenant-domain>`), via the OpenClaw Gateway v4 protocol |

The principle is **one identity, brokered access**: the human signs in once via
OIDC; the control plane then **brokers** the connection to the user's own pod by
handing back that pod's **pairing link** — it never requires a second interactive
login. OpenClaw's native auth is a pairing link, so OpenCrane uses that mechanism
directly rather than minting a parallel bearer token.

## End-to-end flow (single sign-on)

```
1. Browser → /api/auth/login (OIDC) → IdP → /api/auth/callback → session cookie   ← the ONLY login
2. Browser/BFF → POST /api/v1/auth/pod-token: "pairing link for my OpenClaw"
3. Control plane: validates session, resolves the caller's tenant from the
   verified email ONLY (fail-closed on ambiguity), returns the pod's pairing link
   { gatewayUrl, bootstrapToken | null, tenant, ingressHost }
4. Browser opens gatewayUrl (wss://…) and runs the OpenClaw connect handshake:
     - gateway pushes  connect.challenge { nonce, ts }
     - client signs the nonce with a persisted device identity and sends
       connect { auth.token = bootstrapToken (first pair) | auth.deviceToken
       (reconnect), device { id, publicKey, signature, signedAt, nonce } }
     - gateway replies hello-ok { auth.deviceToken, role, scopes }
5. Client persists the deviceToken (Option B target: re-broker instead of persist),
   then sessions.messages.subscribe. Re-broker / reconnect when needed; re-login
   only when the OIDC session itself expires.
```

Step 1 and the broker endpoint (steps 2–3) are ✅ implemented. The connect
handshake (step 4) is implemented client-side but 🔶 until the device-signature
scheme (B1) and pairing-link provisioning (B2) are confirmed.

### Why this shape

- **One login.** Users never authenticate twice for one identity; pod access is
  brokered from the established session.
- **OpenClaw-native.** The pairing link (`{ url, bootstrapToken }`) is OpenClaw's
  own mechanism; OpenCrane brokers it instead of inventing a parallel token path.
- **Data sovereignty.** The bootstrap token is short-lived and single-device, and
  the connection is audience-bound to one UserTenant's gateway.
- **Minimal browser secrets.** The browser holds its HTTP-only session cookie; the
  long-term posture (Option B) re-brokers a short-lived bootstrap per session
  rather than persisting a long-lived device token client-side.

## Token / credential types (keep them distinct)

| Credential | Subject | Audience / target | TTL / storage | Status |
|-----------|---------|-------------------|---------------|--------|
| **Control-plane session cookie** | the human | control plane | server-signed, HTTP-only cookie (~12h) | ✅ |
| **OpenClaw bootstrap token** | the device, on the human's behalf | the UserTenant pod's Gateway (one pod) | short-lived, single-device; from the pairing link | ✅ broker / 🔶 short-TTL mint |
| **OpenClaw device token** | the paired device | the UserTenant pod's Gateway | issued in `hello-ok`; persisted per device (Option B target: re-broker, do not persist) | 🔶 |
| **Projected SA token** | a Kubernetes service account | `obot-gateway` / `skill-registry` / `control-plane` | ~600s, kubelet-rotated, in-cluster only | ✅ |

The **projected SA token** is *workload* identity and must **never be handed to a
browser**. It is how the pod calls *outward* — e.g. OpenClaw → Obot MCP Gateway
(`aud=obot-gateway`), and the contract re-pull loop → control plane
(`aud=control-plane`). The **bootstrap / device tokens** carry the device's
identity (established from the human's brokered session) and are what the browser
uses to reach the pod's OpenClaw Gateway. The browser never holds an
`obot-gateway` token and never talks to Obot directly.

## Control-plane session (OIDC)

OpenCrane uses a backend-for-frontend session model for human access to the
control plane.

- The browser is redirected to an OpenID Connect provider.
- The control-plane backend completes the Authorization Code flow with PKCE.
- The backend stores the authenticated user in a secure HTTP-only session cookie.
- Clients read login state from `/api/auth/me` and never keep an OAuth bearer
  token in browser storage.

This works with Google Identity and with self-hosted providers such as Keycloak,
Dex, Authentik, or Zitadel.

### Required environment variables

Set these on the control-plane deployment when enabling OIDC.

| Variable | Required | Purpose |
|----------|----------|---------|
| `OIDC_ISSUER_URL` | Yes | Issuer URL used for OIDC discovery |
| `OIDC_CLIENT_ID` | Yes | Client identifier registered with the IdP |
| `OIDC_CLIENT_SECRET` | Optional | Client secret for confidential clients |
| `OIDC_REDIRECT_URI` | Yes | Must point to `/api/auth/callback` on the control-plane |
| `OIDC_SESSION_SECRET` | Yes | Secret used to sign the control-plane session cookie |
| `OIDC_SCOPES` | No | Defaults to `openid email profile` |
| `OIDC_COOKIE_NAME` | No | Defaults to `opencrane_oidc` |
| `OIDC_COOKIE_SECURE` | No | Explicit override; otherwise **forced `true` in production** and inferred from the redirect-URI scheme in dev (fail-closed — see CONN.2) |
| `OIDC_SESSION_MAX_AGE_SECONDS` | No | Defaults to 43200 (12 hours) |
| `OIDC_ALLOWED_EMAIL_DOMAINS` | No | Comma-separated allowlist of email domains |
| `OIDC_ALLOWED_EMAILS` | No | Comma-separated allowlist of exact email addresses |
| `OIDC_GROUPS_CLAIM` | No | Claim carrying the caller's group memberships. Defaults to `groups` |
| `OIDC_ROLES_CLAIM` | No | Claim carrying the caller's roles; unioned with `groups`. Defaults to `roles` |
| `OPENCRANE_PLATFORM_OPERATOR_GROUPS` | No | Comma-separated, lowercased group/role names that grant platform-operator. Empty ⇒ nobody (fail-closed) |
| `OPENCRANE_ORG_ADMIN_GROUPS` | No | Comma-separated, lowercased group/role names that grant org-admin. Empty ⇒ nobody (fail-closed) |
| `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL` | No | **Per-cluster seed** that bootstraps the first platform operator by verified email. Empty ⇒ nobody (fail-closed). See [Platform-operator seed](#platform-operator-seed-bootstrapping-the-first-operator) |

### Trusted issuer — Zitadel, no Entra dependency

OpenCrane trusts **exactly one** OIDC issuer: the one at `OIDC_ISSUER_URL`. In the
deployed topology that issuer is **Zitadel**, operated as a **Mode-2 broker** — it is
the single identity provider the control-plane validates tokens against. **There is no
upstream Entra (Azure AD) dependency**: OpenCrane does not federate to, call, or require
Microsoft Entra. The login flow is standards-only OIDC discovery + Authorization Code
with PKCE, so any spec-compliant issuer works, but the trusted, supported issuer is
Zitadel.

Configure Zitadel to emit the caller's group memberships and roles as claims, then point
the claim-name env vars at them:

- `OIDC_GROUPS_CLAIM` — the claim Zitadel puts group memberships in (default `groups`).
- `OIDC_ROLES_CLAIM` — the claim Zitadel puts project/app roles in (default `roles`).

Both claims are read and **unioned**, so a match in either grants the corresponding
flag. In Zitadel this typically means adding the *Groups* and/or *Roles* claims to the
ID token / userinfo via an action or the project's role-assertion settings, and mapping
the OpenCrane operator/org-admin group names into `OPENCRANE_PLATFORM_OPERATOR_GROUPS` /
`OPENCRANE_ORG_ADMIN_GROUPS` (comma-separated, compared lowercased).

### Platform-operator seed (bootstrapping the first operator)

Before any group/role mapping exists in Zitadel, a fresh cluster has **no** platform
operator — `OPENCRANE_PLATFORM_OPERATOR_GROUPS` is empty and the derived
`isPlatformOperator` is `false` for everyone (fail-closed). The **seed** is the
per-cluster bootstrap for exactly this gap:

- Set `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL` to the email of the person who should be
  the first operator. The caller whose **verified** OIDC email equals the seed (compared
  case-insensitively and trimmed) is treated as a platform operator.
- The seed is **additive** to the group check: a caller is a platform operator if their
  groups match **or** their verified email matches the seed (seed OR group ⇒ operator).
- It is **fail-closed**: an empty/unset seed grants operator to nobody, and an email the
  IdP marks **unverified** never matches (login already rejects an unverified email).
- It is a **per-cluster install parameter** — never hardcoded. Set it at install time
  (the wizard prompts for it; `./platform/k8s-deploy.sh --platform-operator-seed-email …`
  or the `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL` env accept it; the Helm value is
  `controlPlane.oidc.platformOperatorSeedEmail`). Once a Zitadel group mapping is in
  place, **remove the seed** and rely on groups.

Like `isPlatformOperator` itself, the seed is an introspection-only stopgap until a
first-class role model lands — the API stays the enforcement point.

### Google Identity example

1. Create a Web application OAuth client in Google Cloud.
2. Add the control-plane callback URL as an authorized redirect URI.
3. Set the control-plane environment variables.

```env
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
OIDC_CLIENT_SECRET=replace-me
OIDC_REDIRECT_URI=https://control-plane.example.com/api/auth/callback
OIDC_SESSION_SECRET=replace-with-a-long-random-secret
OIDC_ALLOWED_EMAIL_DOMAINS=example.com
```

### Local or non-cloud example

Use any OIDC-capable IdP that exposes a discovery document. Example with Keycloak:

```env
OIDC_ISSUER_URL=https://keycloak.local/realms/opencrane
OIDC_CLIENT_ID=opencrane-control-plane
OIDC_CLIENT_SECRET=replace-me
OIDC_REDIRECT_URI=http://localhost:8080/api/auth/callback
OIDC_SESSION_SECRET=replace-with-a-long-random-secret
OIDC_COOKIE_SECURE=false
OIDC_ALLOWED_EMAIL_DOMAINS=local.test
```

The same model works with Dex or Authentik as long as the issuer supports
standard OpenID Connect discovery.

### CLI and automation

- **CLI** uses the OIDC device authorization grant (`POST /auth/device` →
  `/auth/device/activate` in a browser → poll `/auth/device/token`).
- **Automation / CI** uses a static bearer token (`Authorization: Bearer …`).
  Treat this as a migration target; prefer OIDC/IAM where possible.

## UserTenant pod access (pairing broker)

To reach a user's OpenClaw, a caller needs to connect to the UserTenant pod's
**Gateway** and complete OpenClaw's native pairing handshake. The **control plane is the
broker**: it authenticates the human and knows the user↔UserTenant mapping (the `Tenant`
CR's `email` field), so it returns that pod's pairing link.

Implemented as **`POST /api/v1/auth/pod-token`** ✅ (the endpoint name predates the
broker model). It returns the pairing link, not a minted bearer token:

1. Resolve the caller's **UserTenant from the session's verified email only** — there
   is no request-supplied tenant input — matched case-insensitively to the `Tenant`
   CR's `email`; more than one match fails closed (`409 AMBIGUOUS_TENANT`).
2. Resolve the pod's pairing details (`_ResolveOpenClawPairing`): read
   `configOverrides.openclaw.{gatewayUrl,bootstrapToken}`, falling back to
   `wss://<ingressHost>`. **Only `wss://` is ever returned** (CONN.2). Returns
   `{ gatewayUrl, bootstrapToken | null, tenant, ingressHost }`; `bootstrapToken`
   is `null` once a device is paired (the client reconnects with its device token).
3. The browser opens `gatewayUrl` and runs the OpenClaw connect handshake
   (answer `connect.challenge`, send `connect` with `auth.token`/`auth.deviceToken`
   + a signed `device` assertion, receive `hello-ok`), then subscribes.
4. Re-broker / reconnect as needed; the OpenClaw `tickIntervalMs` reaps half-open
   clients. Re-login only when the OIDC session expires.

Because the tenant is derived solely from the session, **a caller cannot obtain a
pairing link for another user's pod.**

### Where the handshake runs

- **Token-to-client (current).** The control plane returns the pairing link to the
  browser, which opens the gateway WS and completes the handshake directly. Simple;
  Option B keeps the brokered credential short-lived so a stripped credential is
  useless within ~a minute.
- **Proxy / BFF (deferred — Option C).** The control plane (or an Envoy/mesh
  sidecar) proxies the WebSocket: per-session cut + per-frame audit + zero browser
  credential, at a connection-stateful cost. Not adopted now; see the security doc
  §6/§8 and plan `CONN.7`.

### Security posture (Option B)

Decided 2026-06: short-lived, re-brokered credentials (no long-lived token in the
browser) + a per-user central kill-switch (OpenClaw `device.token.revoke` /
`device.pair.remove` + a Kubernetes force-disconnect) + transport hardening (HSTS,
`wss://`-only, fail-closed `Secure` cookie — CONN.2). The control plane stays
*connection*-stateless. Full trade-off, threat model (MITM/airport, the two clocks,
K8s force-disconnect levers) and accepted compromises are in
[`claw-security-considerations.md`](/security/connection-security).

### Status

The broker endpoint (`POST /api/v1/auth/pod-token`) is implemented ✅ and requires
a valid OIDC session; it no longer mints a Kubernetes ServiceAccount token. Still
🔶: the OpenClaw **device-signature scheme** (algorithm / signed bytes / encoding
— B1) and **pairing-link provisioning** (how a pod's `{ url, bootstrapToken }`
reaches the control plane, and short-TTL bootstrap mint — B2). TLS for the gateway
is provisioned by cert-manager wildcard issuance (plan `CONN.8`).

## Authorization (who can do what)

Authentication establishes *who*; authorization is split across the two planes:

- **Control plane** — management routes are operator-facing. `/auth/me` carries
  identity (`sub`, `email`, `name`) but **no role claim today**; a roles/
  capabilities claim is a 🔶 target so gating can be explicit.
- **Data plane** — what a pod may retrieve/act on is governed by `AccessPolicy`,
  `Group` awareness grants, and tenant dataset memberships, compiled per tenant
  into the **effective contract** (`GET /tenants/{name}/effective-contract`).
  The OpenClaw pairing profile also grants the device a bounded role/scopes on the
  pod gateway (`node` role + `operator.read/write/approvals`; `operator.admin` /
  `operator.pairing` require separate approval).

## Kubernetes and IAM split

- Human identity is handled by the OIDC provider and the control-plane session.
- Kubernetes RBAC remains machine-facing and is bound to Kubernetes service
  accounts.
- Cloud IAM or local secret systems are bound to workloads through the
  Kubernetes service account identity, not through human bearer tokens.

## Review notes

- The static bearer-token path can remain as a temporary break-glass fallback for
  API-only usage; prefer OIDC/IAM for production.
- For production, prefer a confidential client with `OIDC_CLIENT_SECRET` set.
- Behind an ingress or reverse proxy, preserve forwarded headers so callback and
  secure-cookie handling use the external URL correctly (the control plane sets
  `trust proxy`, so `X-Forwarded-Proto` drives `req.secure` / HSTS).
- Never expose kubelet-projected SA tokens to browsers; the brokered pairing link
  (bootstrap / device token) is the only browser-reachable path to a pod.
