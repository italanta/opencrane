import type * as k8s from "@kubernetes/client-node";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { providerKeysRouter } from "../../routes/provider-keys.js";

/** Build a minimal app containing only the provider-keys route. */
function _buildProviderKeysApp(prisma: PrismaClient, coreApi: k8s.CoreV1Api): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/providers/keys", providerKeysRouter(prisma, coreApi, "opencrane", "org-shared-secrets"));
  return app;
}

describe("providerKeysRouter", () =>
{
  it("upserts openai key and projects it into org shared Secret", async () =>
  {
    const prisma = {
      providerApiKey: {
        upsert: vi.fn().mockResolvedValue({ provider: "openai" }),
      },
    } as unknown as PrismaClient;

    const coreApi = {
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: {
          name: "org-shared-secrets",
          namespace: "opencrane",
          resourceVersion: "12",
        },
        data: {
          ANTHROPIC_API_KEY: Buffer.from("claude-token").toString("base64"),
        },
      }),
      replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CoreV1Api;

    const app = _buildProviderKeysApp(prisma, coreApi);
    const res = await request(app)
      .put("/api/providers/keys/openai")
      .send({ value: "openai-token" });

    expect(res.status).toBe(204);
    expect(prisma.providerApiKey.upsert).toHaveBeenCalledWith({
      where: { provider: "openai" },
      update: { keyValue: "openai-token" },
      create: { provider: "openai", keyValue: "openai-token" },
    });
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledWith({
      name: "org-shared-secrets",
      namespace: "opencrane",
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          resourceVersion: "12",
        }),
        stringData: {
          ANTHROPIC_API_KEY: "claude-token",
          OPENAI_API_KEY: "openai-token",
        },
      }),
    });
  });

  it("creates org shared Secret when provider key projection runs for first time", async () =>
  {
    const prisma = {
      providerApiKey: {
        upsert: vi.fn().mockResolvedValue({ provider: "openai" }),
      },
    } as unknown as PrismaClient;

    const notFound = Object.assign(new Error("Not Found"), { statusCode: 404 });
    const coreApi = {
      readNamespacedSecret: vi.fn().mockRejectedValue(notFound),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CoreV1Api;

    const app = _buildProviderKeysApp(prisma, coreApi);
    const res = await request(app)
      .put("/api/providers/keys/openai")
      .send({ value: "openai-token" });

    expect(res.status).toBe(204);
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledWith({
      namespace: "opencrane",
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          name: "org-shared-secrets",
          namespace: "opencrane",
        }),
        stringData: {
          OPENAI_API_KEY: "openai-token",
        },
      }),
    });
  });

  it("treats Kubernetes ApiException code=404 as not found and creates org secret", async () =>
  {
    const prisma = {
      providerApiKey: {
        upsert: vi.fn().mockResolvedValue({ provider: "openai" }),
      },
    } as unknown as PrismaClient;

    const notFoundApiError = Object.assign(new Error("Not Found"), {
      code: 404,
      body: JSON.stringify({ code: 404, reason: "NotFound" }),
    });

    const coreApi = {
      readNamespacedSecret: vi.fn().mockRejectedValue(notFoundApiError),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CoreV1Api;

    const app = _buildProviderKeysApp(prisma, coreApi);
    const res = await request(app)
      .put("/api/providers/keys/openai")
      .send({ value: "openai-token" });

    expect(res.status).toBe(204);
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("deletes openai key projection while keeping other org secret entries", async () =>
  {
    const prisma = {
      providerApiKey: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const coreApi = {
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: {
          name: "org-shared-secrets",
          namespace: "opencrane",
          resourceVersion: "15",
        },
        data: {
          OPENAI_API_KEY: Buffer.from("openai-token").toString("base64"),
          ANTHROPIC_API_KEY: Buffer.from("claude-token").toString("base64"),
        },
      }),
      replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CoreV1Api;

    const app = _buildProviderKeysApp(prisma, coreApi);
    const res = await request(app).delete("/api/providers/keys/openai");

    expect(res.status).toBe(204);
    expect(prisma.providerApiKey.deleteMany).toHaveBeenCalledWith({ where: { provider: "openai" } });
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledWith({
      name: "org-shared-secrets",
      namespace: "opencrane",
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          resourceVersion: "15",
        }),
        stringData: {
          ANTHROPIC_API_KEY: "claude-token",
        },
      }),
    });
  });
});
