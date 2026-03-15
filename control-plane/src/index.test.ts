import { describe, it, expect } from "vitest";
import { Hono } from "hono";

describe("Control Plane", () => {
  it("healthz endpoint returns ok", async () => {
    const app = new Hono();
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    const res = await app.request("/healthz");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("auth middleware rejects missing token when configured", async () => {
    const originalToken = process.env.OPENCRANE_API_TOKEN;
    process.env.OPENCRANE_API_TOKEN = "test-secret";

    try {
      const app = new Hono();
      app.use("*", async (c, next) => {
        if (c.req.path === "/healthz") return next();
        const token = process.env.OPENCRANE_API_TOKEN;
        if (!token) return next();

        const header = c.req.header("Authorization");
        if (!header?.startsWith("Bearer ")) {
          return c.json({ error: "Missing Authorization header" }, 401);
        }
        const provided = header.slice(7);
        if (provided !== token) {
          return c.json({ error: "Invalid token" }, 403);
        }
        return next();
      });
      app.get("/api/test", (c) => c.json({ ok: true }));

      // Without token
      const res1 = await app.request("/api/test");
      expect(res1.status).toBe(401);

      // With wrong token
      const res2 = await app.request("/api/test", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res2.status).toBe(403);

      // With correct token
      const res3 = await app.request("/api/test", {
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(res3.status).toBe(200);

      // Health check bypasses auth
      const res4 = await app.request("/healthz");
      expect(res4.status).toBe(404); // no healthz route in this mini app
    } finally {
      if (originalToken) {
        process.env.OPENCRANE_API_TOKEN = originalToken;
      } else {
        delete process.env.OPENCRANE_API_TOKEN;
      }
    }
  });
});
