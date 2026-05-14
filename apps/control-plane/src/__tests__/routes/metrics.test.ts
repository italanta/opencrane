import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { metricsRouter } from "../../routes/metrics.js";

const _ONE_HOUR_AGO = new Date(Date.now() - (60 * 60 * 1000));
const _THIRTY_MINUTES_AGO = new Date(Date.now() - (30 * 60 * 1000));

/** Build a test app that mounts the metrics router with mocked dependencies. */
function _BuildMetricsApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient)
{
  const app = express();
  app.use(express.json());
  app.use("/", metricsRouter(customApi, prisma));
  return app;
}

describe("metrics routes", function ()
{
  const originalProjectionDriftAlertThreshold = process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD;

  beforeEach(function _resetProjectionDriftThreshold()
  {
    delete process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD;
  });

  afterEach(function _restoreProjectionDriftThreshold()
  {
    if (originalProjectionDriftAlertThreshold !== undefined)
    {
      process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD = originalProjectionDriftAlertThreshold;
      return;
    }

    delete process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD;
  });

  it("returns a detect-only projection drift summary for tenant and policy projections", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockImplementation(async function _listResources(args: { plural: string })
      {
        if (args.plural === "tenants")
        {
          return {
            body: {
              items: [
                {
                  metadata: { name: "alpha" },
                  spec: { displayName: "Alpha", email: "alpha@example.com", team: "platform" },
                },
              ],
            },
          };
        }

        return {
          body: {
            items: [
              {
                metadata: { name: "default-deny" },
                spec: { description: "Default deny", domains: { deny: ["*"] } },
              },
            ],
          },
        };
      }),
    } as unknown as k8s.CustomObjectsApi;

    const prisma = {
      serverMetricSnapshot: {
        findFirst: vi.fn(),
      },
      tenant: {
        count: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            name: "alpha",
            displayName: "Alpha stale",
            email: "alpha@example.com",
            team: "platform",
            updatedAt: _ONE_HOUR_AGO,
          },
        ]),
      },
      accessPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildMetricsApp(customApi, prisma)).get("/projection-drift");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("detect-only");
    expect(res.body.summary).toEqual({ totalDriftCount: 2, resourceCount: 2 });
    expect(res.body.alert).toEqual({ enabled: false, threshold: 0, exceeded: false, state: "ok" });
    expect(res.body.lag.resources.tenant.measuredProjectionCount).toBe(1);
    expect(res.body.lag.resources.tenant.unresolvedMissingProjectionCount).toBe(0);
    expect(res.body.lag.resources.tenant.maxProjectionLagSeconds).toBeGreaterThanOrEqual(3590);
    expect(res.body.lag.resources.tenant.maxProjectionLagSeconds).toBeLessThanOrEqual(3610);
    expect(res.body.lag.resources.accessPolicy).toEqual({
      maxProjectionLagSeconds: null,
      measuredProjectionCount: 0,
      unresolvedMissingProjectionCount: 1,
    });
    expect(res.body.resources).toEqual({
      tenant: {
        sourceCount: 1,
        projectionCount: 1,
        driftCount: 1,
      },
      accessPolicy: {
        sourceCount: 1,
        projectionCount: 0,
        driftCount: 1,
      },
    });
  });

  it("marks the drift snapshot as alerting when the configured threshold is met", async function ()
  {
    process.env.OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD = "2";

    const customApi = {
      listNamespacedCustomObject: vi.fn().mockImplementation(async function _listResources(args: { plural: string })
      {
        if (args.plural === "tenants")
        {
          return {
            body: {
              items: [
                {
                  metadata: { name: "alpha" },
                  spec: { displayName: "Alpha", email: "alpha@example.com", team: "platform" },
                },
              ],
            },
          };
        }

        return {
          body: {
            items: [
              {
                metadata: { name: "default-deny" },
                spec: { description: "Default deny", domains: { deny: ["*"] } },
              },
            ],
          },
        };
      }),
    } as unknown as k8s.CustomObjectsApi;

    const prisma = {
      serverMetricSnapshot: {
        findFirst: vi.fn(),
      },
      tenant: {
        count: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            name: "alpha",
            displayName: "Alpha stale",
            email: "alpha@example.com",
            team: "platform",
            updatedAt: _THIRTY_MINUTES_AGO,
          },
        ]),
      },
      accessPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildMetricsApp(customApi, prisma)).get("/projection-drift");

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ totalDriftCount: 2, resourceCount: 2 });
    expect(res.body.alert).toEqual({ enabled: true, threshold: 2, exceeded: true, state: "alert" });
  });
});