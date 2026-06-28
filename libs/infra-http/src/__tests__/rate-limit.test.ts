import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { _RateLimit } from "../rate-limit.js";

/**
 * Build an app whose every route is covered by a low-cap limiter, plus the two exempt
 * surfaces (`/healthz`, `/api/internal/*`), so a single test app exercises both the
 * enforce path and the skip path.
 * @param max - Per-window request cap.
 * @returns An Express app with the limiter mounted before its routes.
 */
function _buildApp(max: number): express.Express
{
  const app = express();
  app.use(_RateLimit({ max }));
  app.get("/thing", function _thing(_req, res) { res.json({ ok: true }); });
  app.get("/healthz", function _healthz(_req, res) { res.json({ status: "ok" }); });
  app.get("/api/internal/poll", function _poll(_req, res) { res.json({ ok: true }); });
  return app;
}

describe("_RateLimit — per-IP request limiter", function _suite()
{
  it("allows requests up to the cap, then 429s the next one", async function _enforces()
  {
    const app = _buildApp(2);
    expect((await request(app).get("/thing")).status).toBe(200);
    expect((await request(app).get("/thing")).status).toBe(200);
    expect((await request(app).get("/thing")).status).toBe(429);
  });

  it("never throttles /healthz", async function _skipsHealthz()
  {
    const app = _buildApp(1);
    for (let i = 0; i < 4; i++)
    {
      expect((await request(app).get("/healthz")).status).toBe(200);
    }
  });

  it("never throttles the internal pod-poll surface", async function _skipsInternal()
  {
    const app = _buildApp(1);
    for (let i = 0; i < 4; i++)
    {
      expect((await request(app).get("/api/internal/poll")).status).toBe(200);
    }
  });
});
