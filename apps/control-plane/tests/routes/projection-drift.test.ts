import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { policiesRouter } from "../../src/routes/policies.js";
import { tenantsRouter } from "../../src/routes/tenants.js";

/**
 * Build a test app that mounts the tenant drift route with mocked dependencies.
 */
function _BuildTenantDriftApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient)
{
  const app = express();
  app.use(express.json());
  app.use("/", tenantsRouter(customApi, prisma));
  return app;
}

/**
 * Build a test app that mounts the policy drift route with mocked dependencies.
 */
function _BuildPolicyDriftApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient)
{
  const app = express();
  app.use(express.json());
  app.use("/", policiesRouter(customApi, prisma));
  return app;
}

describe("projection drift routes", function ()
{
  it("reports tenant field drift without changing the existing tenant routes", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "alpha" },
              spec: {
                displayName: "Alpha From CRD",
                email: "alpha@example.com",
                team: "platform",
              },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([
          {
            name: "alpha",
            displayName: "Alpha From DB",
            email: "alpha@example.com",
            team: "platform",
          },
        ]),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildTenantDriftApp(customApi, prisma)).get("/drift");

    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("Tenant");
    expect(res.body.mode).toBe("detect-only");
    expect(res.body.summary).toEqual({
      sourceCount: 1,
      projectionCount: 1,
      driftCount: 1,
    });
    expect(res.body.mismatches).toEqual([
      {
        name: "alpha",
        issue: "field-mismatch",
        fields: ["displayName"],
      },
    ]);
  });

  it("reports missing projection rows for policies", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "default-deny" },
              spec: {
                description: "Default deny policy",
                domains: { deny: ["*"] },
              },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const prisma = {
      accessPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildPolicyDriftApp(customApi, prisma)).get("/drift");

    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("AccessPolicy");
    expect(res.body.summary).toEqual({
      sourceCount: 1,
      projectionCount: 0,
      driftCount: 1,
    });
    expect(res.body.mismatches).toEqual([
      {
        name: "default-deny",
        issue: "missing-projection",
      },
    ]);
  });
});
