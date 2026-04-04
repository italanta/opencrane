import { describe, expect, it } from "vitest";

import { _makeTenant } from "../fixtures.js";
import { _ComputeLastActivityMs, _ListIdleCandidates, _ShouldSuspend } from "../../tenants/idle-policy.js";
import type { Tenant } from "../../tenants/types.js";

describe("idle-policy", () =>
{
  it("lists only running and non-suspended tenants", () =>
  {
    const tenants: Tenant[] = [
      _makeTenant("active-1", { phase: "Running", suspended: false, namespace: "a" }),
      _makeTenant("paused", { phase: "Running", suspended: true, namespace: "b" }),
      _makeTenant("pending", { phase: "Pending", suspended: false, namespace: "c" }),
      _makeTenant("active-2", { phase: "Running", suspended: false }),
    ];

    const candidates = _ListIdleCandidates(tenants);

    expect(candidates).toEqual([
      { name: "active-1", namespace: "a" },
      { name: "active-2", namespace: "default" },
    ]);
  });

  it("computes last activity as max transition timestamp", () =>
  {
    const ts1 = "2026-03-20T10:00:00.000Z";
    const ts2 = "2026-03-20T11:00:00.000Z";

    const last = _ComputeLastActivityMs([
      { type: "Available", status: "True", lastTransitionTime: ts1 } as never,
      { type: "Progressing", status: "True", lastTransitionTime: ts2 } as never,
    ]);

    expect(last).toBe(new Date(ts2).getTime());
  });

  it("returns false when there is no activity timestamp", () =>
  {
    expect(_ShouldSuspend(Date.now(), 0, 60_000)).toBe(false);
  });

  it("returns true when idle duration exceeds threshold", () =>
  {
    const now = 1_000_000;
    const last = 900_000;
    const threshold = 50_000;

    expect(_ShouldSuspend(now, last, threshold)).toBe(true);
  });

  it("returns false when idle duration is within threshold", () =>
  {
    const now = 1_000_000;
    const last = 980_000;
    const threshold = 50_000;

    expect(_ShouldSuspend(now, last, threshold)).toBe(false);
  });
});
