/**
 * Result of parsing and validating the operator's `GATEWAY_TRUSTED_PROXIES`
 * env value into the trust allowlist the OpenClaw gateway is configured with
 * (OC-2 / CONN.4 trusted-proxy auth).
 *
 * The shape makes the trust decision **explicit** so the empty case can never be
 * read as the ambiguous "trust everything": `trustNothing` is `true` only when the
 * operator was given no proxy source at all, and `cidrs` is the validated allowlist
 * otherwise.
 */
export interface TrustedProxyParseResult
{
  /**
   * Validated, de-duplicated trust sources (bare IPs or CIDR blocks) the gateway
   * may trust the user-identity header from. Empty when, and only when,
   * {@link trustNothing} is `true`.
   */
  cidrs: string[];

  /**
   * Fail-closed flag: `true` when no proxy source was configured, so the gateway
   * must trust **no** source and the trusted-proxy header is never honoured. This
   * disambiguates the empty input — empty means trust-none, never trust-all.
   */
  trustNothing: boolean;
}
