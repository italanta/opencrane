import type * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";

import { _RepairTenantProjection } from "../routes/internal/projection-repair.js";

/** Default interval (seconds) between projection-repair sweeps. */
const _DEFAULT_INTERVAL_SECONDS = 60;

/**
 * Periodic Tenant-projection repairer for the silo.
 *
 * Post-Stage-4 the fleet-manager creates a ClusterTenant's `<org>-default` Tenant CRD when the
 * org reaches ready (the fleet registry holds no Tenant table). The silo's management API,
 * however, reads its OWN Postgres projection — so a CRD created out-of-band by the fleet is
 * invisible to the silo until its projection row exists. The control-plane no longer dual-writes
 * (CRD + DB) at create time, so this loop is what closes the gap: it periodically reconciles the
 * silo DB to the Tenant CRDs in its namespace (the authoritative desired state), creating the
 * missing projection rows so fleet-seeded workspaces appear in the silo API without an operator
 * watch in the silo.
 *
 * Idempotent (a converged namespace is a no-op) and fail-soft (a sweep error is logged and the
 * loop continues). Disable by setting the interval to 0.
 */
export class TenantProjectionRepairer
{
  /** Kubernetes custom-objects client for reading Tenant CRDs. */
  private readonly _customApi: k8s.CustomObjectsApi;

  /** Prisma client for the silo's Tenant projection rows. */
  private readonly _prisma: PrismaClient;

  /** Namespace whose Tenant CRDs are reconciled into the silo DB. */
  private readonly _namespace: string;

  /** Scoped logger. */
  private readonly _log: Logger;

  /** Sweep interval in milliseconds; 0 disables the loop. */
  private readonly _intervalMs: number;

  /** Active interval handle; null when stopped/disabled. */
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Guards against overlapping sweeps when one runs longer than the interval. */
  private _running = false;

  /**
   * @param customApi  - Kubernetes custom-objects client.
   * @param prisma     - Prisma client for the silo projection rows.
   * @param namespace  - Namespace whose Tenant CRDs to reconcile.
   * @param log        - Pino logger; a scoped child is derived.
   * @param intervalMs - Sweep interval in ms (default 60 000; 0 disables).
   */
  constructor(customApi: k8s.CustomObjectsApi, prisma: PrismaClient, namespace: string, log: Logger, intervalMs = _DEFAULT_INTERVAL_SECONDS * 1000)
  {
    this._customApi = customApi;
    this._prisma = prisma;
    this._namespace = namespace;
    this._log = log.child({ component: "tenant-projection-repairer" });
    this._intervalMs = intervalMs;
  }

  /**
   * Start the periodic repair loop. A sweep fires immediately so a freshly-seeded workspace
   * surfaces without waiting a full interval. A non-positive interval disables the loop.
   */
  start(): void
  {
    if (this._intervalMs <= 0)
    {
      this._log.info("tenant projection repairer disabled (interval <= 0)");
      return;
    }
    this._log.info({ namespace: this._namespace, intervalMs: this._intervalMs }, "tenant projection repairer started");
    const repairer = this;
    this._timer = setInterval(function _tick() { void repairer._sweep(); }, this._intervalMs);
    void this._sweep();
  }

  /** Stop the loop and release the interval handle. */
  stop(): void
  {
    if (this._timer !== null)
    {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run one repair sweep: reconcile the silo DB to the namespace's Tenant CRDs, creating any
   * missing projection rows. Skips when a previous sweep is still running; never throws.
   */
  private async _sweep(): Promise<void>
  {
    if (this._running) return;
    this._running = true;
    try
    {
      const report = await _RepairTenantProjection(this._customApi, this._prisma, this._namespace, false);
      // Only log when the sweep actually changed something — a converged namespace is silent.
      if (report.repairedCount > 0)
      {
        this._log.info({ namespace: this._namespace, repairedCount: report.repairedCount }, "tenant projection repaired drifted rows");
      }
    }
    catch (err)
    {
      // A sweep failure (cluster blip, etc.) must not kill the loop — log and retry next tick.
      this._log.warn({ err, namespace: this._namespace }, "tenant projection repair sweep failed; will retry next interval");
    }
    finally
    {
      this._running = false;
    }
  }
}
