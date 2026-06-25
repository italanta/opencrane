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

/** The opt-in sentinel that asks the operator to derive a trusted-proxy CIDR from its own pod IP. */
export const _AUTO_TRUSTED_PROXY_TOKEN = "auto";

/** Default mask applied to the operator's pod IP when deriving the `auto` CIDR (GKE pod-range /14). */
export const _DEFAULT_AUTO_TRUSTED_PROXY_MASK = 14;

/**
 * Derive a trusted-proxy CIDR from the operator's own pod IP (downward API
 * `status.podIP`) — the convenience path behind the opt-in `auto` sentinel
 * (task_845dd617). The ingress controller shares the cluster's pod network, so
 * the operator's pod IP masked to the pod-range prefix is a sane trust source
 * when no explicit CIDR was configured, killing the "forgot the CIDR ⇒ every pod
 * fails closed" footgun.
 *
 * This is **opt-in only** and never the default: an empty `GATEWAY_TRUSTED_PROXIES`
 * still resolves to trust-nothing (CONN.9). Trusting the pod range widens the
 * boundary to any pod on it, so the caller must ask for it explicitly and log loudly.
 *
 * IPv4 only — GKE/most CNIs hand pods IPv4. A non-IPv4 / malformed pod IP or an
 * out-of-range mask returns `null` so the caller falls back to fail-closed rather
 * than emitting a bogus entry.
 *
 * @param podIp - The operator pod's own IPv4 address (downward API), or empty/unset.
 * @param maskBits - The prefix length to mask the pod IP to (0–32).
 * @returns The derived `network/mask` CIDR, or `null` when it cannot be derived.
 */
export function _DeriveTrustedProxyCidr(podIp: string, maskBits: number): string | null
{
  // 1. Reject anything that isn't a canonical IPv4 literal or an in-range mask —
  //    derivation must fail to null (→ caller stays fail-closed), never guess.
  const trimmed = podIp.trim();
  if (!_isValidIpv4(trimmed) || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > _IPV4_MAX_PREFIX)
  {
    return null;
  }

  // 2. Pack the four octets into a 32-bit value, mask off the host bits, and
  //    unpack the network address back to dotted-quad. `>>> 0` keeps the shift
  //    unsigned so the high octet never goes negative.
  const octets = trimmed.split(".").map(Number);
  const ipInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const maskInt = maskBits === 0 ? 0 : (0xffffffff << (_IPV4_MAX_PREFIX - maskBits)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;
  const network = [(networkInt >>> 24) & 0xff, (networkInt >>> 16) & 0xff, (networkInt >>> 8) & 0xff, networkInt & 0xff].join(".");

  return `${network}/${maskBits}`;
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
