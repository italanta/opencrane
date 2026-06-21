import type { OidcAuthConfig } from "./oidc.config.types.js";

/** Load OIDC session auth configuration from environment variables. */
export function ___LoadOidcAuthConfig(): OidcAuthConfig
{
  const issuerUrl = process.env.OIDC_ISSUER_URL?.trim() ?? "";
  const clientId = process.env.OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() ?? "";
  const sessionSecret = process.env.OIDC_SESSION_SECRET?.trim() ?? "";
  const hasAnyOidcConfig = Boolean(issuerUrl || clientId || clientSecret || redirectUri || sessionSecret);

  if (!hasAnyOidcConfig)
  {
    return {
      enabled: false,
      issuerUrl: "",
      clientId: "",
      redirectUri: "",
      scopes: "openid email profile",
      sessionSecret: "",
      cookieName: "opencrane_oidc",
      cookieSecure: false,
      sessionMaxAgeMs: 12 * 60 * 60 * 1000,
      allowedEmailDomains: [],
      allowedEmails: [],
      groupsClaim: process.env.OIDC_GROUPS_CLAIM?.trim() || "groups",
      rolesClaim: process.env.OIDC_ROLES_CLAIM?.trim() || "roles",
      platformOperatorGroups: _readPlatformOperatorGroups(),
      orgAdminGroups: _readCsv(process.env.OPENCRANE_ORG_ADMIN_GROUPS),
    };
  }

  const missingVariables: string[] = [];

  if (!issuerUrl) missingVariables.push("OIDC_ISSUER_URL");
  if (!clientId) missingVariables.push("OIDC_CLIENT_ID");
  if (!redirectUri) missingVariables.push("OIDC_REDIRECT_URI");
  if (!sessionSecret) missingVariables.push("OIDC_SESSION_SECRET");

  if (missingVariables.length)
  {
    throw new Error(`OIDC is partially configured. Missing required variables: ${missingVariables.join(", ")}`);
  }

  return {
    enabled: true,
    issuerUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri,
    scopes: process.env.OIDC_SCOPES?.trim() || "openid email profile",
    sessionSecret,
    cookieName: process.env.OIDC_COOKIE_NAME?.trim() || "opencrane_oidc",
    cookieSecure: _resolveCookieSecure(process.env.OIDC_COOKIE_SECURE, redirectUri),
    sessionMaxAgeMs: _readNumber(process.env.OIDC_SESSION_MAX_AGE_SECONDS, 12 * 60 * 60) * 1000,
    allowedEmailDomains: _readCsv(process.env.OIDC_ALLOWED_EMAIL_DOMAINS),
    allowedEmails: _readCsv(process.env.OIDC_ALLOWED_EMAILS),
    groupsClaim: process.env.OIDC_GROUPS_CLAIM?.trim() || "groups",
    rolesClaim: process.env.OIDC_ROLES_CLAIM?.trim() || "roles",
    platformOperatorGroups: _readPlatformOperatorGroups(),
    orgAdminGroups: _readCsv(process.env.OPENCRANE_ORG_ADMIN_GROUPS),
  };
}

/**
 * Read the platform-operator group allowlist that drives `isPlatformOperator`.
 *
 * Sourced from `OPENCRANE_PLATFORM_OPERATOR_GROUPS` (comma-separated, lowercased);
 * the legacy `OIDC_PLATFORM_OPERATOR_GROUPS` is honoured as a fallback. Empty when
 * neither is set, so the derived `isPlatformOperator` is false for everyone until a
 * platform admin opts in — fail-closed, since OpenCrane has no role model yet.
 */
function _readPlatformOperatorGroups(): string[]
{
  const primary = _readCsv(process.env.OPENCRANE_PLATFORM_OPERATOR_GROUPS);
  return primary.length ? primary : _readCsv(process.env.OIDC_PLATFORM_OPERATOR_GROUPS);
}

/**
 * Resolve whether the session cookie must be HTTPS-only, fail-closed for prod.
 *
 * An explicit `OIDC_COOKIE_SECURE` always wins (set `=false` for local http dev).
 * Otherwise production forces `Secure` regardless of the redirect-URI scheme, so a
 * misconfigured `OIDC_REDIRECT_URI` can never silently downgrade the cookie to be
 * sent over plain HTTP. Non-production falls back to inferring from the redirect URI.
 *
 * @param rawValue    - The raw `OIDC_COOKIE_SECURE` value, if set.
 * @param redirectUri - The configured OIDC redirect URI.
 */
function _resolveCookieSecure(rawValue: string | undefined, redirectUri: string): boolean
{
  // 1. Explicit override wins — the only way to disable Secure (e.g. local http dev).
  if (rawValue && rawValue.trim() !== "")
  {
    return _readBoolean(rawValue, false);
  }

  // 2. Fail-closed in production — require Secure cookies whatever the redirect scheme.
  if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production")
  {
    return true;
  }

  // 3. Dev convenience — infer from the redirect URI scheme so http dev works.
  return redirectUri.startsWith("https://");
}

/** Parse a boolean environment variable with a fallback default. */
function _readBoolean(rawValue: string | undefined, defaultValue: boolean): boolean
{
  if (!rawValue)
  {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(rawValue.trim().toLowerCase());
}

/** Parse a numeric environment variable with a fallback default. */
function _readNumber(rawValue: string | undefined, defaultValue: number): number
{
  if (!rawValue)
  {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/** Parse a comma-separated environment variable into normalized lowercase values. */
function _readCsv(rawValue: string | undefined): string[]
{
  if (!rawValue)
  {
    return [];
  }

  return rawValue
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}