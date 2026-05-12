/** Runtime configuration for OIDC-backed control-plane sessions. */
export interface OidcAuthConfig
{
  /** Whether OIDC is enabled for human login flows. */
  enabled: boolean;

  /** Issuer URL used for OIDC discovery. */
  issuerUrl: string;

  /** Registered OAuth client identifier. */
  clientId: string;

  /** Optional confidential-client secret. */
  clientSecret?: string;

  /** Callback URI registered with the identity provider. */
  redirectUri: string;

  /** OIDC scopes requested during login. */
  scopes: string;

  /** Secret used to sign the local session cookie. */
  sessionSecret: string;

  /** Session cookie name. */
  cookieName: string;

  /** Whether the session cookie must be HTTPS-only. */
  cookieSecure: boolean;

  /** Session lifetime in milliseconds. */
  sessionMaxAgeMs: number;

  /** Lowercased allowlist of email domains. */
  allowedEmailDomains: string[];

  /** Lowercased allowlist of full email addresses. */
  allowedEmails: string[];
}

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
    cookieSecure: _readBoolean(process.env.OIDC_COOKIE_SECURE, redirectUri.startsWith("https://")),
    sessionMaxAgeMs: _readNumber(process.env.OIDC_SESSION_MAX_AGE_SECONDS, 12 * 60 * 60) * 1000,
    allowedEmailDomains: _readCsv(process.env.OIDC_ALLOWED_EMAIL_DOMAINS),
    allowedEmails: _readCsv(process.env.OIDC_ALLOWED_EMAILS),
  };
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