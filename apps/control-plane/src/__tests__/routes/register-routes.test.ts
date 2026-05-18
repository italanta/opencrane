import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import type * as k8s from "@kubernetes/client-node";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _RegisterRoutes } from "../../routes.js";

/**
 * Build a minimal Express app with all control-plane routes registered.
 * @param prisma - Prisma client mock used by route handlers
 * @returns An app instance with routes mounted
 */
function _buildRegisteredApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());

  const customApi = {} as unknown as k8s.CustomObjectsApi;
  const coreApi = {} as unknown as k8s.CoreV1Api;
  _RegisterRoutes(app, prisma, customApi, coreApi);

  return app;
}

describe("_RegisterRoutes", () =>
{
  const originalMasterKey = process.env.LITELLM_MASTER_KEY;

  beforeEach(() =>
  {
    process.env.LITELLM_MASTER_KEY = "master-key";
  });

  afterEach(() =>
  {
    if (originalMasterKey !== undefined)
    {
      process.env.LITELLM_MASTER_KEY = originalMasterKey;
    }
    else
    {
      delete process.env.LITELLM_MASTER_KEY;
    }

    vi.restoreAllMocks();
  });

  it("mounts spend endpoint under /api/spend/:tenantName", async () =>
  {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ name: "tenant-a" }),
      },
    } as unknown as PrismaClient;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async function _json()
      {
        return {
          total_cost: 12.5,
          max_budget: 100,
          top_models: [],
        };
      },
    }));

    const app = _buildRegisteredApp(prisma);
    const response = await request(app).get("/api/spend/tenant-a");

    expect(response.status).toBe(200);
    expect(response.body.tenantName).toBe("tenant-a");
    expect(response.body.totalCostUsd).toBe(12.5);
    expect(response.body.monthlyBudgetUsd).toBe(100);
    expect(response.body.remainingBudgetUsd).toBe(87.5);
  });
});
