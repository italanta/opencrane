/**
 * CSWSH (Cross-Site WebSocket Hijacking) guard for the in-operator gateway proxy.
 *
 * The browser sends the session cookie automatically on a cross-site WS upgrade, and
 * — unlike fetch/XHR — the WebSocket handshake is NOT covered by CORS, so the only
 * server-side defence is to check the `Origin` header against an allowlist.
 *
 * Two complementary forms are accepted so a multi-org platform need not enumerate
 * every org host:
 *  - **Base-domain match** — any `https://<label>.<base>` org host (one label under a
 *    configured platform base, e.g. `acme.weownai.eu`) or the base apex.
 *  - **Exact match** — for customer-vanity hosts that sit under no platform base.
 *
 * Fail closed otherwise: a missing/empty Origin, a non-`https` scheme, an unparseable
 * value, a multi-label subdomain, or a host under no base and not exactly allowlisted
 * is rejected. With neither list configured, all upgrades are refused.
 *
 * @param origin         - The request's `Origin` header (may be undefined).
 * @param allowedOrigins - Exact origins permitted (scheme://host), for vanity hosts.
 * @param baseDomains    - Platform base domains; any `https://<label>.<base>` or apex.
 * @returns True only when `origin` is present, `https`, and base- or exactly-allowed.
 */
export function _OriginAllowed(origin: string | undefined, allowedOrigins: string[], baseDomains: string[] = []): boolean
{
  if (typeof origin !== "string" || origin.length === 0)
  {
    return false;
  }

  if (allowedOrigins.includes(origin))
  {
    return true;
  }

  if (baseDomains.length === 0)
  {
    return false;
  }

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
    if (host === base) return true;
    if (!host.endsWith(`.${base}`)) return false;
    const label = host.slice(0, host.length - base.length - 1);
    return label.length > 0 && !label.includes(".");
  });
}
