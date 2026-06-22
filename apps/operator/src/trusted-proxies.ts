import type { TrustedProxyParseResult } from "./trusted-proxies.types.js";

/** Maximum prefix length for an IPv4 CIDR (a /32 is a single host). */
const _IPV4_MAX_PREFIX = 32;

/** Maximum prefix length for an IPv6 CIDR (a /128 is a single host). */
const _IPV6_MAX_PREFIX = 128;

/**
 * Parse and validate the raw `GATEWAY_TRUSTED_PROXIES` env value into the trust
 * allowlist the OpenClaw gateway uses for trusted-proxy auth (OC-2 / CONN.4).
 *
 * The gateway authenticates a connection as the user named in the trusted-proxy
 * header **only** when the TCP source matches one of these entries. Getting the
 * allowlist wrong is a security boundary failure, so this parser is deliberately
 * **fail-closed**:
 *
 * - **Empty / unset input ⇒ trust nothing.** The result carries `trustNothing:
 *   true` and an empty `cidrs`, so the caller can render an unambiguous
 *   trust-none config instead of an empty list a runtime might read as trust-all.
 * - **Malformed entry ⇒ throw.** A typo'd CIDR must crash the operator at config
 *   load rather than silently widen or narrow the trust boundary. The error names
 *   the offending entry so the misconfiguration is obvious in the logs.
 *
 * Each entry may be a bare IPv4/IPv6 address (treated as a single host) or a CIDR
 * block. Whitespace around entries is trimmed and blank entries are dropped before
 * validation.
 *
 * @param raw - The unsplit env value (comma-separated), or an already-split list.
 * @returns The validated trust allowlist with an explicit trust-nothing flag.
 * @throws Error when any non-empty entry is not a valid IP or CIDR.
 */
export function _ParseTrustedProxies(raw: string | string[]): TrustedProxyParseResult
{
  // 1. Normalise to a trimmed, non-empty entry list. Accept both the raw
  //    comma-separated env string and an already-split array so the same
  //    validation runs whether called from config load or a test.
  const entries = (Array.isArray(raw) ? raw : raw.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // 2. Empty input is the fail-closed trust-none case — surface it explicitly so
  //    the caller never emits a bare `[]` that a runtime could read as trust-all.
  if (entries.length === 0)
  {
    return { cidrs: [], trustNothing: true };
  }

  // 3. Validate every entry, failing closed on the first malformed one — a typo
  //    must crash config load, never silently shift the trust boundary.
  for (const entry of entries)
  {
    if (!_isValidCidrOrIp(entry))
    {
      throw new Error(`GATEWAY_TRUSTED_PROXIES contains an invalid IP/CIDR entry: "${entry}"`);
    }
  }

  // 4. De-duplicate while preserving order so a copy-paste repeat doesn't bloat
  //    the rendered config or the gateway's match list.
  const cidrs = [...new Set(entries)];
  return { cidrs, trustNothing: false };
}

/**
 * Validate a single trust entry as either a bare IP address or a CIDR block.
 *
 * @param entry - A trimmed, non-empty candidate entry.
 * @returns `true` when the entry is a valid IPv4/IPv6 address or CIDR block.
 */
function _isValidCidrOrIp(entry: string): boolean
{
  // 1. Split off an optional /prefix; reject anything with more than one slash.
  const parts = entry.split("/");
  if (parts.length > 2)
  {
    return false;
  }

  const [address, prefix] = parts;

  // 2. The address half must be a valid IPv4 or IPv6 literal.
  const isV6 = _isValidIpv6(address);
  const isV4 = _isValidIpv4(address);
  if (!isV4 && !isV6)
  {
    return false;
  }

  // 3. A bare address (no /prefix) is a valid single-host entry.
  if (prefix === undefined)
  {
    return true;
  }

  // 4. A prefix must be a non-negative integer within the family's bound.
  return _isValidPrefix(prefix, isV4 ? _IPV4_MAX_PREFIX : _IPV6_MAX_PREFIX);
}

/**
 * Validate a dotted-quad IPv4 address (four 0–255 octets, no leading zeros that
 * would make it ambiguous).
 *
 * @param address - The candidate address half of an entry.
 * @returns `true` when the value is a well-formed IPv4 address.
 */
function _isValidIpv4(address: string): boolean
{
  const octets = address.split(".");
  if (octets.length !== 4)
  {
    return false;
  }

  return octets.every(function _octetInRange(octet)
  {
    // Reject empty, non-numeric, leading-zero ("01"), and out-of-range octets so
    // only canonical 0–255 values pass.
    if (!/^\d{1,3}$/.test(octet))
    {
      return false;
    }
    if (octet.length > 1 && octet.startsWith("0"))
    {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

/**
 * Validate an IPv6 address. Accepts the canonical 8-group form and the `::`
 * zero-compressed form; this is intentionally permissive on group count but
 * strict on the allowed character set, which is sufficient to reject typos in a
 * trust allowlist.
 *
 * @param address - The candidate address half of an entry.
 * @returns `true` when the value parses as a plausible IPv6 address.
 */
function _isValidIpv6(address: string): boolean
{
  // 1. Must contain a colon and only hex digits and colons (trust entries use
  //    plain IPv6 — no IPv4 dotted-tail support here).
  if (!address.includes(":") || !/^[0-9a-fA-F:]+$/.test(address))
  {
    return false;
  }

  // 2. At most one "::" compression marker is allowed.
  const doubleColonCount = address.split("::").length - 1;
  if (doubleColonCount > 1)
  {
    return false;
  }

  // 3. Each group must be 1–4 hex digits; empty groups are only allowed where the
  //    "::" compression produces them.
  const groups = address.split(":");
  return groups.every((group) => group.length <= 4);
}

/**
 * Validate a CIDR prefix length against the address family's maximum.
 *
 * @param prefix - The raw prefix string after the "/".
 * @param max - The family bound (32 for IPv4, 128 for IPv6).
 * @returns `true` when the prefix is a canonical integer in `[0, max]`.
 */
function _isValidPrefix(prefix: string, max: number): boolean
{
  // 1. Reject empty, non-numeric, and leading-zero prefixes so only canonical
  //    integers pass (e.g. "08" or "" must fail).
  if (!/^\d{1,3}$/.test(prefix))
  {
    return false;
  }
  if (prefix.length > 1 && prefix.startsWith("0"))
  {
    return false;
  }

  // 2. The integer must fall within the address family's prefix bound.
  const value = Number(prefix);
  return value >= 0 && value <= max;
}
