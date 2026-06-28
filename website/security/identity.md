# Authentication

How identities authenticate to OpenCrane and how a single human login grants
access to **both** the control-plane API and the user's own OpenClaw pod.

> **Terminology:** the per-user OpenClaw agent gateway is a **UserTenant** (the openclaw /
> `Tenant` CRD); "UserTenant" is the canonical doc name while the CRD kind is still `Tenant`
> in code. All users in an org connect through the org's single host `<org>.<base>`; the
> identity-routing proxy (in the ClusterTenant operator) routes each session to its pod.
> The **ClusterTenant** is the customer/isolation unit that owns the org host. See the authoritative
> [Tenancy Model](https://github.com/italanta/opencrane/blob/main/docs/agents/cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).
> Below, "tenant pod" / "tenant gateway" means a UserTenant.

> **Status legend:** ✅ implemented · 🔶 planned/target. The OIDC control-plane
> session and the identity-routing proxy (`GET /api/v1/auth/gateway-resolve`) are
> implemented today. The browser holds **no pod credential** — connection auth is
> handled entirely by the proxy replaying the OIDC session cookie. The connection
> security posture is adopted — **trusted-proxy + per-pod owner pinning (CONN.9/10)**;
> see [`claw-security-considerations.md`](/security/connection-security).

## Two planes, one identity

OpenCrane has two backends a user touches, and they must not require two logins:

| Plane | What it serves | How it is reached |
|-------|----------------|-------------------|
| **Control plane** | management + metadata: tenants, policies, groups, budgets, skills, audit, auth | the versioned control-plane API (OIDC session) |
| **UserTenant pod (OpenClaw)** | the live agent session: chat, Cognee retrieval, canvas | the org's gateway WebSocket at `wss://<org>.<base>`, routed to the user's pod by the identity-routing proxy, via the OpenClaw Gateway v4 protocol |

The principle is **one identity, brokered access**: the human signs in once via
OIDC; the control plane then **brokers** the connection to the user's own pod by
handing back that pod's **pairing link** — it never requires a second interactive
login. OpenClaw's native auth is a pairing link, so OpenCrane uses that mechanism
directly rather than minting a parallel bearer token.

## End-to-end flow (single sign-on)

```
1. Browser → /api/v1/auth/login (OIDC) → IdP → /api/v1/auth/callback → session cookie   ← the ONLY login
2. Browser opens  wss://<org>.<base>  (the org's gateway WebSocket)
3. Identity-routing proxy (in the operator):
     - checks Origin against CSWSH allowlist (exact vanity hosts + any https://<org>.<base>)
     - calls GET /api/v1/auth/gateway-resolve (replaying only the session cookie)
     - control plane resolves: verified email → tenant → pod  (fail-closed on ambiguity)
     - proxy strips client-supplied X-Forwarded-User, injects the verified email, and
       reverse-proxies the WS upgrade to openclaw-<user>.<ns>.svc:<gatewayPort>
4. Gateway runs in trusted-proxy mode; OpenClaw's owner-pinning guard (CONN.10)
   rejects any X-Forwarded-User that isn't the pod's registered owner.
5. Browser holds only the HTTP-only session cookie. Re-login only when the OIDC
   session itself expires. Re-connect is automatic; no token management required.
```

All steps are ✅ implemented (gated by `gatewayProxy.enabled`).

### Why this shape

- **One login.** Users never authenticate twice; pod routing is resolved from the
  established OIDC session.
- **No browser-held pod credential.** The browser holds only its HTTP-only session
  cookie; the proxy carries all pod-routing logic, so there is nothing to steal from
  the browser.
- **Defence in depth.** Cross-tenant safety rests on two independent layers: the
  proxy's `gateway-resolve` (routing level) and per-pod owner pinning (pod level) —
  either alone suffices.
- **Revocation is immediate.** Invalidating the OIDC session stops the next
  gateway-resolve call; an already-open socket can be cut via a Kubernetes pod
  force-disconnect (no parallel credential to revoke).

## Credential types (keep them distinct)

| Credential | Subject | Audience / target | TTL / storage | Status |
|-----------|---------|-------------------|---------------|--------|
| **Control-plane session cookie** | the human | control plane + identity-routing proxy | server-signed, HTTP-only cookie (~12h) | ✅ |
| **Projected SA token** | a Kubernetes service account | `obot-gateway` / `skill-registry` / `control-plane` | ~600s, kubelet-rotated, in-cluster only | ✅ |

The browser holds **only** the HTTP-only session cookie. There is no bootstrap token, no
device token, and no pod-specific credential in the browser.

The **projected SA token** is *workload* identity and must **never be handed to a
browser**. It is how the pod calls *outward* — e.g. OpenClaw → Obot MCP Gateway
(`aud=obot-gateway`), and the contract re-pull loop → control plane
(`aud=control-plane`). The browser never holds an `obot-gateway` token and never talks
to Obot directly.

## Two OIDC registrations: fleet and silo

OpenCrane's Stage 4 architecture uses **two separate OIDC registrations** — one for the fleet-manager and one per silo's clustertenant-manager. Both use the same backend-for-frontend session model but target different Zitadel projects and audiences.

| Registration | Component | Helm key | Audience |
|---|---|---|---|
| **Fleet OIDC** | `fleet-manager` (in `opencrane-system`) | `fleetManager.oidc.*` | Fleet operators and billing admins — ClusterTenant lifecycle, billing, platform DNS, Zitadel admin |
| **Silo OIDC** | `clustertenant-manager` (per-silo namespace) | `clustertenantManager.oidc.*` | Per-org end users — tenant management, policies, skills, sessions |

Configure them independently. The fleet and silo can share the same Zitadel *instance* but must use different Zitadel *projects* (and therefore different client IDs and redirect URIs).

::: info Zitadel management is fleet-only
The fleet-manager is the **sole holder** of the Zitadel Management API service-account key (`fleetManager.zitadel.*`). The per-silo clustertenant-manager uses standard OIDC discovery at `clustertenantManager.oidc.issuerUrl` for user login only — it makes no Zitadel Management API calls. See [Fleet and silo operating model](/operators/fleet-silo-model).
:::

## Control-plane session (OIDC)

OpenCrane uses a backend-for-frontend session model for human access to both the fleet
plane and each silo's tenant-facing plane.

- The browser is redirected to an OpenID Connect provider.
- The backend completes the Authorization Code flow with PKCE.
- The backend stores the authenticated user in a secure HTTP-only session cookie.
- Clients read login state from `/api/auth/me` and never keep an OAuth bearer
  token in browser storage.

This works with Google Identity and with self-hosted providers such as Keycloak,
Dex, Authentik, or Zitadel. The variables below apply to **either** the fleet-manager
or the clustertenant-manager; see the table above to know which Helm key maps to which.

### Required environment variables

Set these via Helm (`fleetManager.oidc.*` for the fleet plane, `clustertenantManager.oidc.*` for each silo) — not directly on the deployments.

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
  (the wizard prompts for it; `apps/fleet-platform/deploy.sh --platform-operator-seed-email …`
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

## UserTenant pod access (identity-routing proxy)

To reach a user's OpenClaw, the browser opens the org's gateway WebSocket at
`wss://<org>.<base>`. The **identity-routing proxy** (folded into the ClusterTenant
operator) authorises and routes the connection — the browser holds no pod credential.

The routing authority is **`GET /api/v1/auth/gateway-resolve`** ✅. On each WebSocket
upgrade the proxy:

1. **Checks `Origin`** against the CSWSH allowlist (exact vanity entries + any
   `https://<org>.<base>`) — fails closed if the Origin is missing or not allowed.
2. **Calls `GET /api/v1/auth/gateway-resolve`** on the control plane, replaying only
   the session cookie. The control plane resolves the caller's **UserTenant from the
   session's verified email only** — no request-supplied tenant input — matched
   case-insensitively; more than one match fails closed (`403`).
3. **Strips** any client-supplied `X-Forwarded-User`, **injects** the verified email,
   and **reverse-proxies** to `openclaw-<user>.<ns>.svc:<gatewayPort>`.

The pod runs in **trusted-proxy** mode and pins the allowed identity via
`gateway.auth.trustedProxy.allowUsers` (the pod's owner email — CONN.10), so a
mis-routed socket is rejected at the pod as a second independent guard.

Because the tenant is derived solely from the OIDC session, **a caller cannot reach
another user's pod.**

### Security posture (adopted — CONN.9/10)

The adopted model (2026-06): session-authorised trusted-proxy auth with no browser-held
pod credential + per-pod owner pinning + transport hardening (HSTS, `wss://`-only,
fail-closed `Secure` cookie — CONN.2). The control plane stays *connection*-stateless.
Full threat model and accepted trade-offs are in
[`claw-security-considerations.md`](/security/connection-security).

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
- Never expose kubelet-projected SA tokens to browsers; the session cookie is the
  only browser-held credential, and it never reaches a pod directly — the proxy
  intermediates all pod connections.

## See also

- [Networking & isolation](/operators/networking) — the two-plane model, NetworkPolicy enforcement, the three-layer gateway seam, and known egress gaps
- [Connection security](/security/connection-security) — CONN.9/CONN.10 threat model and transport hardening posture
- [Zitadel key rotation](/security/zitadel-key-rotation) — how to rotate the fleet-manager's Zitadel SA key that provisions ClusterTenant Zitadel Orgs
- [Fleet and silo operating model](/operators/fleet-silo-model) — how fleet OIDC and per-silo OIDC are configured separately
- [Silo IAM: inheritance & sharing](/integrators/silo-iam) — how the Zitadel-bound subject flows into grant compilation and dataset derivation
