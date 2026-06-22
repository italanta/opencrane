import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../../gateway-proxy/rate-limit.js";

describe("FixedWindowRateLimiter", () =>
{
  it("allows up to the limit within a window, then refuses, and resets after it elapses", () =>
  {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, () => now);

    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(false);

    now += 60_000;
    expect(limiter.allow("alice")).toBe(true);
  });

  it("buckets each identity independently", () =>
  {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(1, () => now);

    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("bob")).toBe(true);
    expect(limiter.allow("alice")).toBe(false);
  });
});
