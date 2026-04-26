import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spendRouter } from "./spend.js";

/** Build a minimal app containing only the spend route. */
function _buildSpendApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/spend", spendRouter(prisma));
  return app;
}

describe("spendRouter", () =>
{
  const originalEndpoint = process.env.LITELLM_ENDPOINT;
  const originalMasterKey = process.env.LITELLM_MASTER_KEY;
  const originalPathTemplate = process.env.LITELLM_SPEND_PATH_TEMPLATE;

  beforeEach(() =>
  {
    process.env.LITELLM_ENDPOINT = "http://litellm:4000";
    process.env.LITELLM_MASTER_KEY = "master-key";
    process.env.LITELLM_SPEND_PATH_TEMPLATE = "/spend/tenant/{tenant}";
  });

  afterEach(() =>
  {
    if (originalEndpoint !== undefined)
    {
      process.env.LITELLM_ENDPOINT = originalEndpoint;
    }
    else
    {
      delete process.env.LITELLM_ENDPOINT;
    }

    if (originalMasterKey !== undefined)
    {
      process.env.LITELLM_MASTER_KEY = originalMasterKey;
    }
    else
    {
      delete process.env.LITELLM_MASTER_KEY;
    }

    if (originalPathTemplate !== undefined)
    {
      process.env.LITELLM_SPEND_PATH_TEMPLATE = originalPathTemplate;
    }
    else
    {
      delete process.env.LITELLM_SPEND_PATH_TEMPLATE;
    }

    vi.restoreAllMocks();
  });

  it("returns 404 when tenant does not exist", async () =>
  {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;

    const app = _buildSpendApp(prisma);
    const res = await request(app).get("/api/spend/missing-tenant");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Tenant not found" });
  });

  it("returns normalized spend response from LiteLLM payload", async () =>
  {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ name: "jente" }),
      },
      tokenUsageSnapshot: {
        findUnique: vi.fn(),
      },
      accountBudgetSetting: {
        findUnique: vi.fn(),
      },
      globalBudgetSetting: {
        findUnique: vi.fn(),
      },
    } as unknown as PrismaClient;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async function _json()
      {
        return {
          total_cost: 9.2,
          max_budget: 50,
          top_models: [
            { model: "gpt-4.1", total_cost: 8.1, requests: 12 },
            { model: "gpt-4.1-mini", total_cost: 1.1, requests: 9 },
          ],
        };
      },
    }));

    const app = _buildSpendApp(prisma);
    const res = await request(app).get("/api/spend/jente");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("litellm");
    expect(res.body.totalCostUsd).toBe(9.2);
    expect(res.body.monthlyBudgetUsd).toBe(50);
    expect(res.body.remainingBudgetUsd).toBe(40.8);
    expect(res.body.topModels[0].model).toBe("gpt-4.1");
  });

  it("falls back to local token usage snapshot when LiteLLM is unavailable", async () =>
  {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ name: "jente" }),
      },
      tokenUsageSnapshot: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "jente",
          currency: "USD",
          totalCost: 14.5,
        }),
      },
      accountBudgetSetting: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "jente",
          currency: "USD",
          ceilingAmount: 25,
        }),
      },
      globalBudgetSetting: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const app = _buildSpendApp(prisma);
    const res = await request(app).get("/api/spend/jente");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("local");
    expect(res.body.totalCostUsd).toBe(14.5);
    expect(res.body.monthlyBudgetUsd).toBe(25);
    expect(res.body.remainingBudgetUsd).toBe(10.5);
  });
});