import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../rate-limit.js";

describe("FixedWindowRateLimiter", () =>
{
  it("allows up to the limit within a window, then refuses", () =>
  {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(3, () => now);

    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(false); // 4th in the same window
  });

  it("resets after the window elapses", () =>
  {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(1, () => now);

    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("alice")).toBe(false);

    now += 60_000; // window rolls over
    expect(limiter.allow("alice")).toBe(true);
  });

  it("buckets each identity independently", () =>
  {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(1, () => now);

    expect(limiter.allow("alice")).toBe(true);
    expect(limiter.allow("bob")).toBe(true); // bob is not affected by alice's window
    expect(limiter.allow("alice")).toBe(false);
  });
});
