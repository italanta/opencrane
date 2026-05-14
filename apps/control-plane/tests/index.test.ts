import type { PrismaClient } from "@prisma/client";
import express from "express";
import type { Express } from "express";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

import { _CheckDbHealth } from "../src/infra/db/healtcheck-db.js";

/**
 * Build a minimal Express app with a mocked database health handler.
 * @param dbHealthy - Whether the mock DB query should succeed
 * @returns An Express app wired for health-check testing
 */
function _buildHealthApp(dbHealthy: boolean): Express
{
  const prisma = {
    $queryRaw: dbHealthy ? vi.fn().mockResolvedValue([{ 1: 1 }]) : vi.fn().mockRejectedValue(new Error("db unavailable")),
  } as unknown as PrismaClient;

  const app = express();
  app.use(express.json());
  app.get("/healthz", _CheckDbHealth(prisma));

  return app;
}

/**
 * Build a minimal Express app with auth middleware loaded after env setup.
 * @returns An Express app wired for auth testing
 */
async function _buildAuthApp(): Promise<Express>
{
  vi.resetModules();

  const { ___AuthMiddleware } = await import("../src/infra/middleware/auth.middleware.js");
  const app = express();
  app.use(express.json());
  app.use(___AuthMiddleware());

  app.get("/healthz", function _healthz(req, res)
  {
    res.json({ status: "ok", db: true });
  });

  app.get("/api/test", function _test(req, res)
  {
    res.json({ ok: true });
  });

  return app;
}

describe("Control Plane", () =>
{
  it("healthz endpoint returns ok", async () =>
  {
    const app = _buildHealthApp(true);
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: true });
  });

  it("healthz endpoint returns degraded when DB is unavailable", async () =>
  {
    const app = _buildHealthApp(false);
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", db: false });
  });

  describe("auth middleware", () =>
  {
    let originalToken: string | undefined;

    beforeEach(() =>
    {
      originalToken = process.env.OPENCRANE_API_TOKEN;
    });

    afterEach(() =>
    {
      if (originalToken)
      {
        process.env.OPENCRANE_API_TOKEN = originalToken;
      }
      else
      {
        delete process.env.OPENCRANE_API_TOKEN;
      }

      vi.resetModules();
    });

    it("rejects requests without Authorization header when token is configured", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = await _buildAuthApp();

      const res = await request(app).get("/api/test");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Missing Authorization header" });
    });

    it("rejects requests with wrong token", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = await _buildAuthApp();

      const res = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer wrong-token");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Invalid token" });
    });

    it("allows requests with correct token", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = await _buildAuthApp();

      const res = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer test-secret");

      expect(res.status).toBe(200);
    });

    it("allows all requests when no token is configured (dev mode)", async () =>
    {
      delete process.env.OPENCRANE_API_TOKEN;
      const app = await _buildAuthApp();

      const res = await request(app).get("/api/test");
      expect(res.status).toBe(200);
    });

    it("healthz bypasses auth even with token configured", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = await _buildAuthApp();

      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });
});
