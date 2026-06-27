import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the repair function so the loop is exercised without a cluster or DB. `vi.hoisted`
// makes `_repair` available inside the hoisted `vi.mock` factory.
const { _repair } = vi.hoisted(function _h()
{
  return { _repair: vi.fn().mockResolvedValue({ entity: "tenant", repairedCount: 0, skippedCount: 0, entries: [] }) };
});
vi.mock("../../routes/internal/projection-repair.js", function _mock()
{
  return { _RepairTenantProjection: _repair };
});

import { TenantProjectionRepairer } from "../../infra/tenant-projection-repairer.js";

const _log = pino({ enabled: false });
const _customApi = {} as k8s.CustomObjectsApi;
const _prisma = {} as PrismaClient;

/** Yield to the microtask queue so the immediate `void _sweep()` settles. */
function _tick(): Promise<void> { return new Promise(function _r(resolve) { setTimeout(resolve, 0); }); }

describe("TenantProjectionRepairer", function _suite()
{
  afterEach(function _reset() { _repair.mockClear(); });

  it("runs an immediate sweep on start and reconciles the configured namespace", async function _immediate()
  {
    const repairer = new TenantProjectionRepairer(_customApi, _prisma, "opencrane-acme", _log, 60_000);
    repairer.start();
    await _tick();
    repairer.stop();

    expect(_repair).toHaveBeenCalledTimes(1);
    // Reconciles the silo namespace against its Tenant CRDs, applying repairs (dryRun=false).
    expect(_repair).toHaveBeenCalledWith(_customApi, _prisma, "opencrane-acme", false);
  });

  it("is disabled (no sweep) when the interval is non-positive", async function _disabled()
  {
    const repairer = new TenantProjectionRepairer(_customApi, _prisma, "opencrane-acme", _log, 0);
    repairer.start();
    await _tick();
    repairer.stop();

    expect(_repair).not.toHaveBeenCalled();
  });

  it("stop() is safe to call when never started", function _stopSafe()
  {
    const repairer = new TenantProjectionRepairer(_customApi, _prisma, "opencrane-acme", _log, 60_000);
    expect(() => repairer.stop()).not.toThrow();
  });
});
