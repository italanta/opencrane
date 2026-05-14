import type * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _DetectPolicyProjectionDrift, _DetectTenantProjectionDrift } from "./internal/projection-drift.js";

/**
 * Creates router for infrastructure usage metrics.
 * @param prisma - Prisma ORM client
 * @returns Configured Express router
 */
export function metricsRouter(customApi: k8s.CustomObjectsApi, prisma: PrismaClient): Router
{
  const router = Router();
  const namespace = process.env.NAMESPACE ?? "default";
  const projectionDriftAlertThreshold = _ReadProjectionDriftAlertThreshold();

  /** Returns latest server utilization snapshot for dashboard cards. */
  router.get("/server", async function _serverMetrics(req, res)
  {
    const latest = await prisma.serverMetricSnapshot.findFirst({
      orderBy: { sampledAt: "desc" },
    });

    if (latest)
    {
      res.json({
        cpuPercent: latest.cpuPercent,
        memoryUsedBytes: Number(latest.memoryUsedBytes),
        memoryTotalBytes: Number(latest.memoryTotalBytes),
        storageUsedBytes: Number(latest.storageUsedBytes),
        storageTotalBytes: Number(latest.storageTotalBytes),
        activeTenants: latest.activeTenants,
        sampledAt: latest.sampledAt.toISOString(),
      });
      return;
    }

    const tenantCount = await prisma.tenant.count({ where: { phase: { not: "Suspended" } } });
    res.json({
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: 64 * 1024 * 1024 * 1024,
      storageUsedBytes: 0,
      storageTotalBytes: 1024 * 1024 * 1024 * 1024,
      activeTenants: tenantCount,
      sampledAt: new Date().toISOString(),
    });
  });

  /**
   * Returns a timestamped summary of detect-only projection drift for Tenant and
   * AccessPolicy resources so dashboards can show current mismatch counts.
   */
  router.get("/projection-drift", async function _projectionDriftMetrics(req, res)
  {
    // 1. Read both drift reports from the existing detect-only comparison helpers.
    const [tenantReport, policyReport] = await Promise.all([
      _DetectTenantProjectionDrift(customApi, prisma, namespace),
      _DetectPolicyProjectionDrift(customApi, prisma, namespace),
    ]);

    // 2. Reduce the detailed findings into a metrics-friendly summary payload.
    const totalDriftCount = tenantReport.summary.driftCount + policyReport.summary.driftCount;
    const thresholdEnabled = projectionDriftAlertThreshold > 0;
    const thresholdExceeded = thresholdEnabled && totalDriftCount >= projectionDriftAlertThreshold;

    // 3. Return a timestamped snapshot that dashboards can poll directly.
    res.json({
      mode: "detect-only",
      sampledAt: new Date().toISOString(),
      summary: {
        totalDriftCount,
        resourceCount: 2,
      },
      alert: {
        enabled: thresholdEnabled,
        threshold: projectionDriftAlertThreshold,
        exceeded: thresholdExceeded,
        state: thresholdExceeded ? "alert" : "ok",
      },
      resources: {
        tenant: tenantReport.summary,
        accessPolicy: policyReport.summary,
      },
    });
  });

  return router;
}

/**
 * Read the optional projection-drift alert threshold from the environment.
 * Invalid, negative, or unset values disable threshold evaluation.
 */
function _ReadProjectionDriftAlertThreshold(): number
{
  const rawValue = process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD?.trim() ?? "";

  if (rawValue === "")
  {
    return 0;
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0)
  {
    return 0;
  }

  return Math.floor(parsedValue);
}
