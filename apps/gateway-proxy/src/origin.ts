/**
 * CSWSH (Cross-Site WebSocket Hijacking) guard.
 *
 * The browser sends a session cookie automatically on a cross-site WS upgrade, and
 * — unlike fetch/XHR — the WebSocket handshake is NOT covered by CORS, so the
 * browser will happily open a socket a malicious page initiated. The only
 * server-side defence is to check the `Origin` header against an allowlist and
 * refuse anything that does not match.
 *
 * Two complementary forms are accepted, so a multi-org platform need not enumerate
 * every org host:
 *  - **Base-domain match** — the every-org case. An `https://<label>.<base>` host
 *    (one label under a configured platform base, e.g. `acme.weownai.eu`) or the
 *    base apex itself is allowed. This is exactly the set of org serving hosts under
 *    the fixed-wildcard topology.
 *  - **Exact match** — for customer-vanity hosts (`https://ai.client-co.com`) that do
 *    not sit under a platform base.
 *
 * Fail closed in every other case: a missing/empty `Origin`, a non-`https` scheme, an
 * unparseable value, a multi-label subdomain, or a host under no configured base and
 * not exactly allowlisted is rejected. With neither list configured, all are refused.
 *
 * @param origin         - The request's `Origin` header (may be undefined).
 * @param allowedOrigins - Exact origins permitted (scheme://host), for vanity hosts.
 * @param baseDomains    - Platform base domains; any `https://<label>.<base>` or the
 *                         base apex is allowed.
 * @returns True only when `origin` is present, `https`, and base- or exactly-allowed.
 */
export function _OriginAllowed(origin: string | undefined, allowedOrigins: string[], baseDomains: string[] = []): boolean
{
  if (typeof origin !== "string" || origin.length === 0)
  {
    return false;
  }

  // Exact allowlist (vanity hosts) — match before any parsing.
  if (allowedOrigins.includes(origin))
  {
    return true;
  }

  if (baseDomains.length === 0)
  {
    return false;
  }

  // Parse and require https — a downgraded ws/http origin is never trusted.
  let url: URL;
  try
  {
    url = new URL(origin);
  }
  catch
  {
    return false;
  }
  if (url.protocol !== "https:" || url.port.length > 0)
  {
    return false;
  }

  const host = url.hostname.toLowerCase();
  return baseDomains.some((raw) =>
  {
    const base = raw.trim().toLowerCase();
    if (base.length === 0) return false;
    // The base apex (`<base>`) or exactly one label under it (`<label>.<base>`) — never
    // a deeper subdomain (`a.b.<base>`), which is not a valid org serving host.
    if (host === base) return true;
    if (!host.endsWith(`.${base}`)) return false;
    const label = host.slice(0, host.length - base.length - 1);
    return label.length > 0 && !label.includes(".");
  });
}
