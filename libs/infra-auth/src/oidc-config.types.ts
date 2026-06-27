/** Runtime configuration for OIDC-backed manager sessions (fleet or clustertenant). */
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

  /**
   * Optional post-logout redirect URI for OIDC RP-Initiated Logout. Sent as
   * `post_logout_redirect_uri` to the IdP's `end_session_endpoint` so the IdP
   * returns the user-agent here after destroying the upstream session. Empty
   * when unset, in which case `/auth/logout` still tears down the local session
   * but returns no end-session URL (the browser stays put). The origin is
   * re-derived per request from the host header so multi-host (`<org>.<base>`)
   * deployments end up back on the same host they logged in from; only the
   * PATH from this value is used. The IdP must allow the resulting URL.
   */
  postLogoutRedirectUri: string;

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

  /** Claim name carrying the caller's group memberships (default `groups`). */
  groupsClaim: string;

  /** Claim name carrying the caller's roles (default `roles`); unioned into `groups`. */
  rolesClaim: string;

  /**
   * Lowercased group names that mark a caller as a platform operator. A caller is
   * a platform operator iff their groups intersect this set. Empty by default, so
   * nobody is a platform operator until configured (fail-closed). Sourced from
   * `OPENCRANE_PLATFORM_OPERATOR_GROUPS`.
   *
   * TODO: superseded once OpenCrane gains a first-class role model — this is the
   * non-presumptuous, config-driven stopgap, not a role system.
   */
  platformOperatorGroups: string[];

  /**
   * Lowercased group names that mark a caller as an organisation admin — the role
   * that may curate the MCP catalogue / manage an organisation they own. A caller
   * is an org admin iff their groups intersect this set (platform operators are
   * always org admins, being a superset). Empty by default, so nobody is an org
   * admin until configured (fail-closed). Sourced from `OPENCRANE_ORG_ADMIN_GROUPS`.
   */
  orgAdminGroups: string[];

  /**
   * Lowercased, trimmed per-cluster seed email that bootstraps the FIRST platform
   * operator before any IdP group/role mapping exists. A caller is a platform operator
   * if their **verified** email equals this value (compared case-insensitively + trimmed),
   * which is OR-ed with the group-based check in {@link platformOperatorGroups} — seed
   * OR group ⇒ operator.
   *
   * Empty by default, so the seed grants operator to NOBODY until a platform admin sets
   * it at install (fail-closed). It is a per-cluster INSTALL parameter — never hardcoded —
   * sourced from `OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL`.
   *
   * TODO: superseded once OpenCrane gains a first-class role model — this is the
   * non-presumptuous, config-driven bootstrap, not a role system.
   */
  platformOperatorSeedEmail: string;
}
