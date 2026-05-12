# Identity Provider Integration

This document explains how to connect an external identity provider to the OpenCrane control-plane.

## Model

OpenCrane uses a backend-for-frontend session model for human access to the control-plane.

- The browser is redirected to an OpenID Connect provider.
- The control-plane backend completes the Authorization Code flow with PKCE.
- The backend stores the authenticated user in a secure HTTP-only session cookie.
- The Angular UI reads login state from `/api/auth/me` and never needs to keep an OAuth bearer token in browser storage.

This works with Google Identity and with self-hosted providers such as Keycloak, Dex, Authentik, or Zitadel.

## Required Environment Variables

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
| `OIDC_COOKIE_SECURE` | No | Defaults to `true` when redirect URI is HTTPS |
| `OIDC_SESSION_MAX_AGE_SECONDS` | No | Defaults to 43200 (12 hours) |
| `OIDC_ALLOWED_EMAIL_DOMAINS` | No | Comma-separated allowlist of email domains |
| `OIDC_ALLOWED_EMAILS` | No | Comma-separated allowlist of exact email addresses |

## Google Identity Example

1. Create a Web application OAuth client in Google Cloud.
2. Add the control-plane callback URL as an authorized redirect URI.
3. Set the control-plane environment variables.

Example:

```env
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
OIDC_CLIENT_SECRET=replace-me
OIDC_REDIRECT_URI=https://control-plane.example.com/api/auth/callback
OIDC_SESSION_SECRET=replace-with-a-long-random-secret
OIDC_ALLOWED_EMAIL_DOMAINS=example.com
```

## Local Or Non-Cloud Example

Use any OIDC-capable IdP that exposes a discovery document.

Example with Keycloak:

```env
OIDC_ISSUER_URL=https://keycloak.local/realms/opencrane
OIDC_CLIENT_ID=opencrane-control-plane
OIDC_CLIENT_SECRET=replace-me
OIDC_REDIRECT_URI=http://localhost:8080/api/auth/callback
OIDC_SESSION_SECRET=replace-with-a-long-random-secret
OIDC_COOKIE_SECURE=false
OIDC_ALLOWED_EMAIL_DOMAINS=local.test
```

The same model works with Dex or Authentik as long as the issuer supports standard OpenID Connect discovery.

## Kubernetes And IAM Split

Human users authenticate to the control-plane through OIDC.

- Human identity is handled by the OIDC provider and the control-plane session.
- Kubernetes RBAC remains machine-facing and is bound to Kubernetes service accounts.
- Cloud IAM or local secret systems should be bound to workloads through the Kubernetes service account identity, not through human bearer tokens.

## Review Notes

- The current bearer token path can still exist as a temporary fallback for API-only break-glass usage.
- For production, prefer a confidential client with `OIDC_CLIENT_SECRET` set.
- If the control-plane is behind an ingress or reverse proxy, ensure forwarded headers are preserved so callback and secure-cookie handling use the external URL correctly.