# WeOwnAI handoff — single-per-org-host connection model

> **Audience:** the WeOwnAI Angular frontend team (separate repo). This is a change-spec,
> not code — it describes what the frontend must change now that the platform serves each
> org from one host and routes the gateway WebSocket through an identity-routing proxy
> folded into the operator. Nothing in the platform repo enforces the old per-user-subdomain
> shape any more.

## What changed on the platform side

- **One host per org.** An org is served at its single host `<org>.<base>` (e.g.
  `company.opencrane.ai`). There are **no per-user subdomains** (`<user>.<org>.<base>` is
  gone). The app UI, `/api/*`, and the gateway WebSocket are all served **same-origin**
  under that one host.
- **Identity-routing gateway proxy.** The gateway WS upgrade is authorised and routed by an
  in-cluster proxy (currently folded into the operator): it checks `Origin`, calls the
  control plane to resolve the caller's pod, injects the verified identity, and reverse-
  proxies to that user's OpenClaw pod. The browser holds **no pod credential** — only its
  OIDC session cookie.
- **`/auth/gateway-verify` is removed.** It was the per-user-ingress `auth_request`; it no
  longer exists. Do not call it.

## What the frontend must do

### 1. Serve the app from the org host
The SPA loads from `https://<org>.<base>` (or the org's vanity domain). Login, API calls,
and the gateway socket must **all** use that same origin so the browser is same-origin and
the session cookie is sent automatically.

### 2. Login (unchanged shape, same-origin)
- Send the user to `GET /api/v1/auth/login` **on the current org host**.
- The control plane derives the OIDC `redirect_uri` from the request host, so the callback
  returns to `https://<org>.<base>/api/v1/auth/callback` and the session cookie is
  **host-scoped** to that org host. Read login state from `GET /api/v1/auth/me`.
- **Operator/IdP prerequisite (not frontend):** the IdP must allow the per-org redirect
  hosts (a wildcard redirect URI, e.g. `https://*.<base>/api/v1/auth/callback`).

### 3. Open the gateway WebSocket same-origin
- Connect to **`wss://<org>.<base>`** — the current origin — **not** a per-user subdomain.
  `POST /api/v1/auth/pod-token` still returns `{ gatewayUrl, tenant, ingressHost }`; the
  `gatewayUrl` is now the org host (`wss://<org>.<base>`). Prefer the returned `gatewayUrl`;
  it will match the current origin.
- The browser sends only the **session cookie**. There is **no `bootstrapToken`** and no
  device token to manage for the gateway — that machinery is retired. Remove any device-
  token persistence / re-broker logic tied to the gateway connection.
- The WS must be opened from the org-host page so the `Origin` header is
  `https://<org>.<base>` — the proxy's CSWSH allowlist requires it. A socket opened from any
  other origin is refused (403).

### 4. The connect handshake is now trusted-proxy, not device-signed
The proxy injects the verified `X-Forwarded-User` on the upstream, so the OpenClaw gateway
authenticates the socket in **trusted-proxy** mode. The browser does **not** sign a device
challenge for authentication. Open the socket, then proceed to the normal OpenClaw Gateway
v4 session (`sessions.messages.subscribe`, etc.). **Confirm against the pinned OpenClaw
version** whether any non-auth handshake fields are still expected; the *auth* portion is
handled by the proxy + trusted-proxy, not by a client device signature.

### 5. Refusal handling
On the WS upgrade, the proxy may close with:
- **401** — no/expired session → send the user back through login.
- **403** — forbidden Origin, or no/ambiguous tenant for the session email → surface a clear
  "no workspace for this account" error; do not retry blindly.
- **429** — per-identity rate limit → back off.

## Things to delete in WeOwnAI
- Any construction of per-user gateway hosts (`<user>.<org>.<base>`).
- Any `bootstrapToken` / device-token handling for the gateway connection.
- Any reference to `/auth/gateway-verify`.

## Open confirmation
- The exact OpenClaw Gateway v4 connect-handshake fields still required by the pinned
  OpenClaw version under trusted-proxy mode (auth is proxy-injected; confirm the rest).
