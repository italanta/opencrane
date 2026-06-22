/**
 * CSWSH (Cross-Site WebSocket Hijacking) guard.
 *
 * The browser sends a session cookie automatically on a cross-site WS upgrade, and
 * — unlike fetch/XHR — the WebSocket handshake is NOT covered by CORS, so the
 * browser will happily open a socket a malicious page initiated. The only
 * server-side defence is to check the `Origin` header against an allowlist and
 * refuse anything that does not match exactly.
 *
 * Fail closed: a missing `Origin`, an unparenseable one, or one not in the
 * allowlist is rejected. Under the same-origin per-org model the legitimate gateway
 * socket is always opened by the org's own SPA, so it always carries a known Origin.
 *
 * @param origin         - The request's `Origin` header (may be undefined).
 * @param allowedOrigins - Exact origins permitted (scheme://host[:port]).
 * @returns True only when `origin` is present and exactly allowlisted.
 */
export function _OriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean
{
  if (typeof origin !== "string" || origin.length === 0)
  {
    return false;
  }
  return allowedOrigins.includes(origin);
}
