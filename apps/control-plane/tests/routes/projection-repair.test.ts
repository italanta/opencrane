import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { tenantsRouter } from "../../src/routes/tenants.js";
import { policiesRouter } from "../../src/routes/policies.js";

/** Build a test app that mounts the tenants router with mocked dependencies. */
function _BuildTenantRepairApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient)
{
  const app = express();
  app.use(express.json());
  app.use("/", tenantsRouter(customApi, prisma));
  return app;
}

/** Build a test app that mounts the policies router with mocked dependencies. */
function _BuildPolicyRepairApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient)
{
  const app = express();
  app.use(express.json());
  app.use("/", policiesRouter(customApi, prisma));
  return app;
}

describe("projection repair routes", function ()
{
  it("dry-runs tenant repair and reports what would change without writing", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "alpha" },
              spec: { displayName: "Alpha Fixed", email: "alpha@example.com", team: "platform" },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const create = vi.fn();
    const update = vi.fn();
    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([
          { name: "alpha", displayName: "Alpha Stale", email: "alpha@example.com", team: "platform" },
        ]),
        create,
        update,
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildTenantRepairApp(customApi, prisma)).post("/repair");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("dry-run");
    expect(res.body.resource).toBe("Tenant");
    expect(res.body.repairedCount).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ name: "alpha", action: "updated", dryRun: true });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("applies tenant repair and writes the corrected row when dryRun=false", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "beta" },
              spec: { displayName: "Beta", email: "beta@example.com", team: null },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([
          { name: "beta", displayName: "Beta Old", email: "beta@example.com", team: null },
        ]),
        create: vi.fn(),
        update,
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildTenantRepairApp(customApi, prisma))
      .post("/repair?dryRun=false");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("apply");
    expect(res.body.repairedCount).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ name: "beta", action: "updated", dryRun: false });
    expect(update).toHaveBeenCalledOnce();
  });

  it("creates a missing tenant projection row when CRD exists but row is absent", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "gamma" },
              spec: { displayName: "Gamma", email: "gamma@example.com", team: "eng" },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([]),
        create,
        update: vi.fn(),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildTenantRepairApp(customApi, prisma))
      .post("/repair?dryRun=false");

    expect(res.status).toBe(200);
    expect(res.body.repairedCount).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ name: "gamma", action: "created", dryRun: false });
    expect(create).toHaveBeenCalledOnce();
  });

  it("skips a tenant projection row that has no matching CRD source", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ body: { items: [] } }),
    } as unknown as k8s.CustomObjectsApi;

    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([
          { name: "orphan", displayName: "Orphan", email: "orphan@example.com", team: null },
        ]),
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildTenantRepairApp(customApi, prisma)).post("/repair");

    expect(res.status).toBe(200);
    expect(res.body.skippedCount).toBe(1);
    expect(res.body.repairedCount).toBe(0);
    expect(res.body.entries[0]).toMatchObject({ name: "orphan", action: "skipped" });
  });

  it("dry-runs policy repair and does not write when fields drift", async function ()
  {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: "egress-policy" },
              spec: {
                description: "Updated description",
                tenantSelector: null,
                domains: null,
                egressRules: null,
                mcpServers: { allow: ["skills"] },
              },
            },
          ],
        },
      }),
    } as unknown as k8s.CustomObjectsApi;

    const update = vi.fn();
    const prisma = {
      accessPolicy: {
        findMany: vi.fn().mockResolvedValue([
          {
            name: "egress-policy",
            description: "Old description",
            tenantSelector: null,
            domains: null,
            egressRules: null,
            mcpServers: null,
          },
        ]),
        create: vi.fn(),
        update,
      },
    } as unknown as PrismaClient;

    const res = await request(_BuildPolicyRepairApp(customApi, prisma)).post("/repair");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("dry-run");
    expect(res.body.resource).toBe("AccessPolicy");
    expect(res.body.repairedCount).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ name: "egress-policy", action: "updated", dryRun: true });
    expect(update).not.toHaveBeenCalled();
  });
});
