import express from "express";
import type { Express } from "express";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";

import { authMiddleware } from "./middleware/auth.js";

/**
 * Build a minimal Express app with the auth middleware and a test endpoint.
 * @returns An Express app wired for testing
 */
function _buildTestApp(): Express
{
  const app = express();
  app.use(express.json());
  app.use(authMiddleware());

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
    const app = _buildTestApp();
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: true });
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
    });

    it("rejects requests without Authorization header when token is configured", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = _buildTestApp();

      const res = await request(app).get("/api/test");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Missing Authorization header" });
    });

    it("rejects requests with wrong token", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = _buildTestApp();

      const res = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer wrong-token");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Invalid token" });
    });

    it("allows requests with correct token", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = _buildTestApp();

      const res = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer test-secret");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("allows all requests when no token is configured (dev mode)", async () =>
    {
      delete process.env.OPENCRANE_API_TOKEN;
      const app = _buildTestApp();

      const res = await request(app).get("/api/test");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("healthz bypasses auth even with token configured", async () =>
    {
      process.env.OPENCRANE_API_TOKEN = "test-secret";
      const app = _buildTestApp();

      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });
});
