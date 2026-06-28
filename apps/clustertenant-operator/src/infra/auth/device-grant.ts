/**
 * In-memory device authorization grant store.
 *
 * Grants are process-local and do not survive restarts.  The 5-minute TTL
 * means the window of exposure is inherently bounded without requiring
 * persistent state or a distributed cache for Phase 5.
 *
 * For multi-replica deployments, this must be replaced with a shared store
 * (e.g. Redis or a database table) so that the activate and poll calls can
 * land on different pod instances.
 */

import { randomBytes, randomInt } from "crypto";

import type { DeviceGrantInfo, DevicePollResult } from "./device-grant.types.js";

/** Lifetime of a device grant before it expires. */
const _GRANT_TTL_MS = 5 * 60 * 1_000;

/**
 * Characters used when generating user codes.
 * Visually ambiguous glyphs (I, O, 0, 1) are deliberately excluded.
 */
const _USER_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Process-local grant store keyed by the secret device code. */
const _grants = new Map<string, DeviceGrantInfo>();

/**
 * Remove all expired entries from the in-memory store.
 * Called before every write to prevent unbounded growth.
 */
function _pruneExpired(): void
{
  const now = new Date();
  for (const [key, grant] of _grants)
  {
    if (grant.expiresAt <= now)
    {
      _grants.delete(key);
    }
  }
}

/**
 * Pick `n` random characters from `_USER_CODE_CHARS` using `crypto.randomInt`, which draws an
 * unbiased integer in `[0, _USER_CODE_CHARS.length)`. A naive `randomByte % length` would skew
 * toward the first `256 % length` glyphs (modulo bias); `randomInt` rejection-samples internally
 * to keep the distribution uniform.
 *
 * @param n - Number of characters to generate.
 */
function _randomChars(n: number): string
{
  return Array.from(
    { length: n },
    () => _USER_CODE_CHARS[randomInt(_USER_CODE_CHARS.length)],
  ).join("");
}

/**
 * Generate a short XXXX-XXXX user code shown to the operator.
 * Format keeps the code memorable and easy to type without ambiguous glyphs.
 */
function _generateUserCode(): string
{
  return `${_randomChars(4)}-${_randomChars(4)}`;
}

/**
 * Create a new pending device authorization grant and register it in the store.
 *
 * The returned grant contains both the secret device code (for the CLI) and
 * the short user code (for the browser activation page).
 */
export function _CreateDeviceGrant(): DeviceGrantInfo
{
  // 1. Evict stale entries before inserting to keep the map footprint small.
  _pruneExpired();

  // 2. Generate a 64-hex-char device code that cannot be guessed by the browser.
  const deviceCode = randomBytes(32).toString("hex");

  // 3. Build the grant with a 5-minute lifetime and register it.
  const grant: DeviceGrantInfo = {
    deviceCode,
    userCode: _generateUserCode(),
    expiresAt: new Date(Date.now() + _GRANT_TTL_MS),
    status: "pending",
  };
  _grants.set(deviceCode, grant);

  return grant;
}

/**
 * Look up a pending, non-expired device grant by the user code shown in the browser.
 *
 * @param userCode - Short code entered or opened by the user (e.g. ABCD-1234).
 * @returns The matching grant, or undefined if no live grant matches.
 */
export function _FindGrantByUserCode(userCode: string): DeviceGrantInfo | undefined
{
  const now = new Date();
  for (const grant of _grants.values())
  {
    if (grant.userCode === userCode && grant.expiresAt > now)
    {
      return grant;
    }
  }
  return undefined;
}

/**
 * Transition a pending grant to "authorized" and attach the issued token.
 *
 * @param deviceCode  - Secret device code that identifies the grant.
 * @param accessToken - Plain-text access token to deliver to the CLI.
 * @returns true when the grant was found and updated; false if missing or expired.
 */
export function _AuthorizeDeviceGrant(deviceCode: string, accessToken: string): boolean
{
  // 1. Fetch the grant — return false immediately if it does not exist.
  const grant = _grants.get(deviceCode);
  if (!grant)
  {
    return false;
  }

  // 2. Reject expired grants so a lingering activation attempt cannot succeed.
  if (grant.expiresAt <= new Date())
  {
    _grants.delete(deviceCode);
    return false;
  }

  // 3. Set the authorized state and attach the token.
  grant.status = "authorized";
  grant.accessToken = accessToken;
  return true;
}

/**
 * Return the current poll result for a device code and consume the grant if authorized.
 *
 * The token is returned exactly once: once "authorized" is returned the entry is
 * removed from the store so subsequent polls receive "expired".
 *
 * @param deviceCode - Secret device code known only to the CLI.
 */
export function _PollDeviceGrant(deviceCode: string): DevicePollResult
{
  // 1. Look up the grant; treat a missing entry as expired.
  const grant = _grants.get(deviceCode);
  if (!grant)
  {
    return { status: "expired" };
  }

  // 2. Remove and report expired grants.
  if (grant.expiresAt <= new Date())
  {
    _grants.delete(deviceCode);
    return { status: "expired" };
  }

  // 3. If authorized, delete the entry (one-time token delivery) and return the token.
  if (grant.status === "authorized")
  {
    const { accessToken } = grant;
    _grants.delete(deviceCode);
    return { status: "authorized", accessToken };
  }

  // 4. Still waiting for the user to open the browser activation page.
  return { status: "pending" };
}
