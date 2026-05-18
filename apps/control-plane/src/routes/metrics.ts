import type * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";

import type { ProjectionTimestampRow } from "./metrics.types.js";
import { _DetectPolicyProjectionDrift, _DetectTenantProjectionDrift } from "./internal/projection-drift.js";

/** Module-level logger for webhook delivery errors. */
const _log = pino({ name: "metrics-route" });

/** Timeout for outbound drift-alert webhook requests (ms). */
const WEBHOOK_TIMEOUT_MS = 5000;

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
  const driftWebhookUrl = process.env.OPENCRANE_DRIFT_WEBHOOK_URL?.trim() ?? "";

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
   * Fires a webhook notification when drift exceeds the configured threshold.
   */
  router.get("/projection-drift", async function _projectionDriftMetrics(req, res)
  {
    // 1. Read both drift reports from the existing detect-only comparison helpers.
    const [tenantReport, policyReport] = await Promise.all([
      _DetectTenantProjectionDrift(customApi, prisma, namespace),
      _DetectPolicyProjectionDrift(customApi, prisma, namespace),
    ]);

    // 2. Read projection timestamps so the snapshot can expose how stale drifted rows are.
    const [tenantRows, policyRows] = await Promise.all([
      prisma.tenant.findMany({
        select: { name: true, updatedAt: true },
      }),
      prisma.accessPolicy.findMany({
        select: { name: true, updatedAt: true },
      }),
    ]);

    // 3. Reduce the detailed findings into a metrics-friendly summary payload.
    const sampledAt = new Date();
    const totalDriftCount = tenantReport.summary.driftCount + policyReport.summary.driftCount;
    const thresholdEnabled = projectionDriftAlertThreshold > 0;
    const thresholdExceeded = thresholdEnabled && totalDriftCount >= projectionDriftAlertThreshold;
    const tenantLag = _BuildProjectionLagSummary(tenantReport.mismatches, tenantRows, sampledAt);
    const policyLag = _BuildProjectionLagSummary(policyReport.mismatches, policyRows, sampledAt);

    const responsePayload = {
      mode: "detect-only",
      sampledAt: sampledAt.toISOString(),
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
      lag: {
        maxProjectionLagSeconds: _MaxNullableNumber(tenantLag.maxProjectionLagSeconds, policyLag.maxProjectionLagSeconds),
        resources: {
          tenant: tenantLag,
          accessPolicy: policyLag,
        },
      },
    };

    // 4. Fire a webhook notification when threshold is exceeded and a URL is configured.
    //    This is fire-and-forget — the HTTP response is not blocked on webhook delivery.
    if (thresholdExceeded && driftWebhookUrl)
    {
      _FireDriftWebhook(driftWebhookUrl, responsePayload).catch(function _onWebhookError(err: unknown)
      {
        _log.warn({ err, webhookUrl: driftWebhookUrl }, "drift alert webhook delivery failed");
      });
    }

    // 5. Return a timestamped snapshot that dashboards can poll directly.
    res.json(responsePayload);
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

/**
 * Build lag metrics for the subset of mismatches that still have projection rows.
 */
function _BuildProjectionLagSummary(mismatches: Array<{ name: string; issue: string }>, rows: ProjectionTimestampRow[], sampledAt: Date)
{
  const rowsByName = new Map(rows.map(function _toRowEntry(row)
  {
    return [row.name, row] as const;
  }));

  const driftedProjectionLagSeconds = mismatches
    .map(function _toLagSeconds(mismatch)
    {
      const row = rowsByName.get(mismatch.name);
      if (!row)
      {
        return null;
      }

      return Math.max(0, Math.floor((sampledAt.getTime() - row.updatedAt.getTime()) / 1000));
    })
    .filter(function _hasLag(value): value is number
    {
      return value !== null;
    });

  return {
    maxProjectionLagSeconds: driftedProjectionLagSeconds.length > 0 ? Math.max(...driftedProjectionLagSeconds) : null,
    measuredProjectionCount: driftedProjectionLagSeconds.length,
    unresolvedMissingProjectionCount: mismatches.filter(function _isMissingProjection(mismatch)
    {
      return mismatch.issue === "missing-projection";
    }).length,
  };
}

/** Return the larger of two nullable numbers, preserving `null` when both are absent. */
function _MaxNullableNumber(left: number | null, right: number | null): number | null
{
  if (left === null)
  {
    return right;
  }

  if (right === null)
  {
    return left;
  }

  return Math.max(left, right);
}

/**
 * Send a drift-alert notification to the configured webhook URL.
 *
 * The payload follows a simple envelope format compatible with generic webhook
 * receivers (Slack incoming webhooks, PagerDuty, Opsgenie, etc.).
 * Delivery is best-effort — failures are logged but do not affect the metrics response.
 *
 * @param webhookUrl - HTTP/HTTPS URL to POST the alert payload to.
 * @param driftPayload - The same projection-drift snapshot served to callers.
 */
async function _FireDriftWebhook(webhookUrl: string, driftPayload: unknown): Promise<void>
{
  const controller = new AbortController();
  const timeoutId = setTimeout(function _abortWebhook()
  {
    controller.abort();
  }, WEBHOOK_TIMEOUT_MS);

  try
  {
    const body = JSON.stringify({
      event: "opencrane.projection_drift.alert",
      severity: "warning",
      message: `Projection drift threshold exceeded: ${(driftPayload as { summary: { totalDriftCount: number } }).summary.totalDriftCount} mismatches detected`,
      payload: driftPayload,
    });

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  }
  finally
  {
    clearTimeout(timeoutId);
  }
}
