/**
 * Per-identity fixed-window rate limiter for gateway WS upgrades.
 *
 * Bounds how many sockets one identity may open per minute, so a single compromised
 * or misbehaving session cannot exhaust pod connection slots. The window is in-memory
 * (per operator replica); the authoritative cross-tenant guard is the control plane's
 * `gateway-resolve` plus per-pod owner pinning, not this counter. A monotonic clock is
 * injected so the limiter is deterministically testable.
 */
export class FixedWindowRateLimiter
{
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  /**
   * @param perMinute - Max allowed events per key per 60s window.
   * @param now       - Monotonic millisecond clock (defaults to `Date.now`).
   */
  constructor(perMinute: number, now: () => number = Date.now)
  {
    this.limit = perMinute;
    this.windowMs = 60_000;
    this.now = now;
  }

  /**
   * Record an attempt for `key` and report whether it is within the limit.
   *
   * @param key - The identity to bucket on (the resolved email).
   * @returns True when allowed; false when the window is exhausted.
   */
  allow(key: string): boolean
  {
    const t = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || t - bucket.windowStart >= this.windowMs)
    {
      this.buckets.set(key, { windowStart: t, count: 1 });
      return true;
    }

    if (bucket.count >= this.limit)
    {
      return false;
    }

    bucket.count += 1;
    return true;
  }
}
