import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { _RegisterRoutes } from "../../routes.js";

/**
 * S6 / ADR 0002 — the control-plane mounts only the API surface that belongs to its
 * `OPENCRANE_CONTROL_PLANE_ROLE`. These tests assert the split at the mount layer:
 *
 *   - `/api/v1/platform/dns` is a fleet (central-only) surface — it is NOT flag-gated, so it is a
 *     clean discriminator for "did the central block mount?".
 *   - `/api/v1/tenants` is a tenant-facing (silo-only) surface.
 *
 * The self-service fleet routers (cluster-tenants / Zitadel / billing) are left flag-disabled here
 * so the test never has to construct the live Zitadel client; the role split itself is what's under
 * test. A route that was not mounted yields Express's 404; a mounted route yields anything else.
 */
/**
 * Build an Express app with the full control-plane route set registered for the role currently
 * in `OPENCRANE_CONTROL_PLANE_ROLE`. Dependencies are stub-mocked because these tests assert mount
 * presence (404 vs not) only, not handler behaviour. No auth middleware is mounted.
 *
 * @returns The configured Express app.
 */
function _buildApp(): Express
{
  const prisma = {} as unknown as PrismaClient;
  const customApi = {} as unknown as k8s.CustomObjectsApi;
  const coreApi = {} as unknown as k8s.CoreV1Api;
  const authApi = {} as unknown as k8s.AuthenticationV1Api;

  const app = express();
  app.use(express.json());
  // No auth middleware mounted — these tests only assert mount presence (404 vs not), not authz.
  return _RegisterRoutes(app, prisma, customApi, coreApi, authApi);
}

describe("control-plane API surface split by deployment role (S6 / ADR 0002)", function _suite()
{
  let originalRole: string | undefined;
  let originalManager: string | undefined;
  let originalBilling: string | undefined;

  beforeEach(function _save()
  {
    originalRole = process.env.OPENCRANE_CONTROL_PLANE_ROLE;
    originalManager = process.env.OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED;
    originalBilling = process.env.OPENCRANE_BILLING_ENABLED;
    // Keep the heavy self-service fleet routers off so no live Zitadel client is constructed.
    process.env.OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED = "false";
    process.env.OPENCRANE_BILLING_ENABLED = "false";
  });

  afterEach(function _restore()
  {
    for (const [key, value] of [
      ["OPENCRANE_CONTROL_PLANE_ROLE", originalRole],
      ["OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED", originalManager],
      ["OPENCRANE_BILLING_ENABLED", originalBilling],
    ] as const)
    {
      if (value === undefined) { delete process.env[key]; }
      else { process.env[key] = value; }
    }
  });

  it("silo mounts the tenant surface and withholds the fleet surface", async function _silo()
  {
    process.env.OPENCRANE_CONTROL_PLANE_ROLE = "silo";
    const app = _buildApp();

    expect((await request(app).get("/api/v1/tenants")).status).not.toBe(404);
    expect((await request(app).get("/api/v1/platform/dns")).status).toBe(404);
    // The always-mounted infra surface is present regardless of role.
    expect((await request(app).get("/healthz")).status).not.toBe(404);
  });

  it("central mounts the fleet surface and withholds the tenant surface", async function _central()
  {
    process.env.OPENCRANE_CONTROL_PLANE_ROLE = "central";
    const app = _buildApp();

    expect((await request(app).get("/api/v1/platform/dns")).status).not.toBe(404);
    expect((await request(app).get("/api/v1/tenants")).status).toBe(404);
    // Internal pod-poll routes belong to the silo's own planes — never on a central control-plane.
    expect((await request(app).get("/api/internal/tenant-models")).status).toBe(404);
    expect((await request(app).get("/healthz")).status).not.toBe(404);
  });
});
