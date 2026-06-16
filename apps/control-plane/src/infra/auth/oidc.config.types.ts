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

  /** Claim name carrying the caller's group memberships (default `groups`). */
  groupsClaim: string;

  /** Claim name carrying the caller's roles (default `roles`). */
  rolesClaim: string;

  /** Claim name carrying the caller's ClusterTenant (customer) key (default `cluster_tenant`). */
  clusterTenantClaim: string;

  /**
   * Lowercased group/role values that mark a caller as a platform operator.
   * A caller whose `groupsClaim`/`rolesClaim` values intersect this set resolves
   * to `platform-operator`; everyone else resolves to `customer-admin`. Empty by
   * default, so callers are least-privilege (`customer-admin`) until configured.
   */
  platformOperatorGroups: string[];
}
