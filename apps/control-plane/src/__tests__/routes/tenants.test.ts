import type * as k8s from "@kubernetes/client-node";
import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tenantsRouter } from "../../routes/tenants.js";
import { _NoopGatewayAdmin } from "../../core/connections/gateway-admin.js";

/** Build an Express app containing only the tenants router. */
function _buildTenantsApp(customApi: k8s.CustomObjectsApi, prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/tenants", tenantsRouter(customApi, prisma, {} as k8s.CoreV1Api, new _NoopGatewayAdmin()));
  return app;
}

/** Build a minimal Prisma stub for tenant route tests. */
function _buildPrismaStub(overrides: Partial<{
  tenantFindUnique: unknown;
  datasetMembershipFindMany: unknown;
  datasetMembershipDeleteMany: unknown;
  datasetMembershipCreateMany: unknown;
  transaction: unknown;
  auditEntryCreate: unknown;
}> = {}): PrismaClient
{
  const deleteManySpy = vi.fn().mockResolvedValue("datasetMembershipDeleteMany" in overrides ? overrides.datasetMembershipDeleteMany : { count: 0 });
  const createManySpy = vi.fn().mockResolvedValue("datasetMembershipCreateMany" in overrides ? overrides.datasetMembershipCreateMany : { count: 0 });
  const transactionSpy = vi.fn().mockImplementation(async function _transaction(operations: Promise<unknown>[])
  {
    if ("transaction" in overrides)
    {
      return overrides.transaction;
    }
    return Promise.all(operations);
  });

  return {
    tenant: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue("tenantFindUnique" in overrides ? overrides.tenantFindUnique : { name: "acme" }),
    },
    tenantDatasetMembership: {
      findMany: vi.fn().mockResolvedValue("datasetMembershipFindMany" in overrides ? overrides.datasetMembershipFindMany : []),
      deleteMany: deleteManySpy,
      createMany: createManySpy,
    },
    $transaction: transactionSpy,
    auditEntry: {
      create: vi.fn().mockResolvedValue("auditEntryCreate" in overrides ? overrides.auditEntryCreate : {}),
    },
  } as unknown as PrismaClient;
}

describe("tenantsRouter dataset membership endpoints", () =>
{
  beforeEach(() =>
  {
    process.env.COGNEE_ENDPOINT = "http://cognee.test";
  });

  afterEach(() =>
  {
    delete process.env.COGNEE_ENDPOINT;
    delete process.env.COGNEE_PERMISSIONS_TIMEOUT_MS;
    vi.unstubAllGlobals();
  });

  it("returns dataset memberships from SQL projection rows", async () =>
  {
    const prisma = _buildPrismaStub({
      tenantFindUnique: {
        name: "acme",
      },
      datasetMembershipFindMany: [
        { scope: "Org", subject: "default" },
        { scope: "Team", subject: "engineering" },
        { scope: "Project", subject: "apollo" },
        { scope: "Personal", subject: "owner@example.com" },
      ],
    });
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app).get("/api/tenants/acme/datasets");

    expect(response.status).toBe(200);
    expect(response.body.org).toEqual(["default"]);
    expect(response.body.team).toEqual(["engineering"]);
    expect(response.body.project).toEqual(["apollo"]);
    expect(response.body.personal).toEqual(["owner@example.com"]);
  });

  it("updates tenant dataset memberships and writes an audit entry", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", fetchSpy);
    const auditCreateSpy = vi.fn().mockResolvedValue({});
    const deleteManySpy = vi.fn().mockResolvedValue({ count: 4 });
    const createManySpy = vi.fn().mockResolvedValue({ count: 4 });
    const transactionSpy = vi.fn().mockImplementation(async function _transaction(operations: Promise<unknown>[])
    {
      return Promise.all(operations);
    });

    const prisma = _buildPrismaStub({
      auditEntryCreate: {},
    });
    prisma.auditEntry.create = auditCreateSpy as unknown as PrismaClient["auditEntry"]["create"];
    prisma.tenantDatasetMembership.deleteMany = deleteManySpy as unknown as PrismaClient["tenantDatasetMembership"]["deleteMany"];
    prisma.tenantDatasetMembership.createMany = createManySpy as unknown as PrismaClient["tenantDatasetMembership"]["createMany"];
    prisma.$transaction = transactionSpy as unknown as PrismaClient["$transaction"];

    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme/datasets")
      .send({
        org: ["default"],
        team: ["engineering"],
        department: ["platform"],
        project: ["apollo"],
        personal: ["owner@example.com"],
      });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(transactionSpy).toHaveBeenCalledOnce();
    expect(deleteManySpy).toHaveBeenCalledOnce();
    expect(createManySpy).toHaveBeenCalledOnce();
    expect(auditCreateSpy).toHaveBeenCalledOnce();
    expect(response.body.team).toEqual(["engineering"]);
  });

  it("returns 404 when updating datasets for a missing tenant", async () =>
  {
    const app = _buildTenantsApp(
      {} as k8s.CustomObjectsApi,
      _buildPrismaStub({ tenantFindUnique: null }),
    );
    const response = await request(app)
      .put("/api/tenants/missing/datasets")
      .send({
        org: ["default"],
        team: [],
        department: [],
        project: [],
        personal: [],
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Tenant not found");
  });

  it("returns 400 when dataset update payload is invalid", async () =>
  {
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, _buildPrismaStub());
    const response = await request(app)
      .put("/api/tenants/acme/datasets")
      .send({
        org: "default",
        team: [],
        department: [],
        project: [],
        personal: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("org, team, department, project, and personal must all be string arrays, and org may only contain 'default'");
  });

  it("returns 502 when applying dataset updates in Cognee fails", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prisma = _buildPrismaStub();
    const deleteManySpy = vi.fn().mockResolvedValue({ count: 4 });
    prisma.tenantDatasetMembership.deleteMany = deleteManySpy as unknown as PrismaClient["tenantDatasetMembership"]["deleteMany"];
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme/datasets")
      .send({
        org: ["default"],
        team: [],
        department: [],
        project: [],
        personal: [],
      });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("Failed to apply tenant datasets in Cognee");
    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it("returns 502 when persisting dataset updates fails after Cognee apply", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prisma = _buildPrismaStub();
    prisma.$transaction = vi.fn().mockRejectedValue(new Error("persist failed")) as unknown as PrismaClient["$transaction"];
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme/datasets")
      .send({
        org: ["default"],
        team: [],
        department: [],
        project: [],
        personal: [],
      });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("Failed to persist tenant datasets");
  });

  it("returns 200 when audit write fails after dataset patch succeeds", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prisma = _buildPrismaStub();
    prisma.auditEntry.create = vi.fn().mockRejectedValue(new Error("audit unavailable")) as unknown as PrismaClient["auditEntry"]["create"];
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme/datasets")
      .send({
        org: ["default"],
        team: [],
        department: [],
        project: [],
        personal: [],
      });

    expect(response.status).toBe(200);
    expect(response.body.org).toEqual(["default"]);
  });

  it("returns 502 when loading datasets fails for a non-not-found error", async () =>
  {
    const prisma = _buildPrismaStub();
    prisma.tenant.findUnique = vi.fn().mockRejectedValue(new Error("db unavailable")) as unknown as PrismaClient["tenant"]["findUnique"];
    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app).get("/api/tenants/acme/datasets");

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("Failed to load tenant datasets");
  });
});

describe("tenantsRouter list endpoint — clusterTenantRef projection + filter (WOI.2)", () =>
{
  it("surfaces clusterTenantRef in the list response", async () =>
  {
    const findManySpy = vi.fn().mockResolvedValue([
      { name: "acme", displayName: "Acme", email: "o@acme.io", team: "eng", clusterTenantRef: "acme-corp", phase: "Running", ingressHost: null, createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const prisma = { tenant: { findMany: findManySpy } } as unknown as PrismaClient;

    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app).get("/api/tenants");

    expect(response.status).toBe(200);
    expect(response.body[0].clusterTenantRef).toBe("acme-corp");
    // No filter supplied → no where clause.
    expect(findManySpy).toHaveBeenCalledWith(expect.not.objectContaining({ where: expect.anything() }));
  });

  it("filters server-side by clusterTenantRef when the query param is present", async () =>
  {
    const findManySpy = vi.fn().mockResolvedValue([]);
    const prisma = { tenant: { findMany: findManySpy } } as unknown as PrismaClient;

    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app).get("/api/tenants?clusterTenantRef=acme-corp");

    expect(response.status).toBe(200);
    expect(findManySpy).toHaveBeenCalledWith(expect.objectContaining({ where: { clusterTenantRef: "acme-corp" } }));
  });
});

describe("tenantsRouter create endpoint — Tenant CR appearance validation", () =>
{
  it("creates a tenant when the Tenant CR appears", async () =>
  {
    const customApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CustomObjectsApi;
    const tenantCreateSpy = vi.fn().mockResolvedValue({});
    const auditCreateSpy = vi.fn().mockResolvedValue({});
    const prisma = {
      tenant: { create: tenantCreateSpy },
      auditEntry: { create: auditCreateSpy },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp(customApi, prisma);
    const response = await request(app)
      .post("/api/tenants")
      .send({
        name: "acme",
        displayName: "Acme",
        email: "owner@acme.io",
      });

    expect(response.status).toBe(201);
    expect(tenantCreateSpy).toHaveBeenCalledOnce();
    expect(auditCreateSpy).toHaveBeenCalledOnce();
  });

  it("dual-writes clusterTenantRef to both the CRD spec and the DB row (WOI.2)", async () =>
  {
    const createCrSpy = vi.fn().mockResolvedValue({});
    const customApi = {
      createNamespacedCustomObject: createCrSpy,
      getNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CustomObjectsApi;
    const tenantCreateSpy = vi.fn().mockResolvedValue({});
    const prisma = {
      tenant: { create: tenantCreateSpy },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp(customApi, prisma);
    const response = await request(app)
      .post("/api/tenants")
      .send({ name: "acme", displayName: "Acme", email: "owner@acme.io", clusterTenantRef: "acme-corp" });

    expect(response.status).toBe(201);
    // CRD spec carries clusterTenantRef…
    expect(createCrSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ spec: expect.objectContaining({ clusterTenantRef: "acme-corp" }) }),
    }));
    // …and so does the projected DB row.
    expect(tenantCreateSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clusterTenantRef: "acme-corp" }),
    }));
  });

  it("returns 504 when the Tenant CR does not appear within the SLO window", async () =>
  {
    process.env.TENANT_CR_APPEARANCE_TIMEOUT_MS = "5";
    process.env.TENANT_CR_APPEARANCE_POLL_INTERVAL_MS = "1";
    const customApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ statusCode: 404 }),
    } as unknown as k8s.CustomObjectsApi;
    const tenantCreateSpy = vi.fn().mockResolvedValue({});
    const auditCreateSpy = vi.fn().mockResolvedValue({});
    const prisma = {
      tenant: { create: tenantCreateSpy },
      auditEntry: { create: auditCreateSpy },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp(customApi, prisma);
    const response = await request(app)
      .post("/api/tenants")
      .send({
        name: "slow-tenant",
        displayName: "Slow Tenant",
        email: "owner@acme.io",
      });

    delete process.env.TENANT_CR_APPEARANCE_TIMEOUT_MS;
    delete process.env.TENANT_CR_APPEARANCE_POLL_INTERVAL_MS;

    expect(response.status).toBe(504);
    expect(response.body.error).toContain("within 30 seconds");
    expect(tenantCreateSpy).not.toHaveBeenCalled();
    expect(auditCreateSpy).not.toHaveBeenCalled();
  });
});

describe("tenantsRouter get + update — clusterTenantRef round-trip and clear (WOI.2)", () =>
{
  it("returns clusterTenantRef from a single-tenant get", async () =>
  {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          name: "acme", displayName: "Acme", email: "o@acme.io", team: "eng", clusterTenantRef: "acme-corp", phase: "Running", ingressHost: null, createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
      },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp({} as k8s.CustomObjectsApi, prisma);
    const response = await request(app).get("/api/tenants/acme");

    expect(response.status).toBe(200);
    expect(response.body.clusterTenantRef).toBe("acme-corp");
  });

  it("clears clusterTenantRef to null in both the CRD patch and the DB when given an empty string", async () =>
  {
    const patchSpy = vi.fn().mockResolvedValue({});
    const updateSpy = vi.fn().mockResolvedValue({});
    const customApi = { patchNamespacedCustomObject: patchSpy } as unknown as k8s.CustomObjectsApi;
    const prisma = {
      tenant: { update: updateSpy },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp(customApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme")
      .send({ clusterTenantRef: "" });

    expect(response.status).toBe(200);
    // Empty string clears: the CRD merge-patch deletes the field via null…
    // Second arg carries the merge-patch Content-Type (else k8s rejects the body as JSON-Patch).
    expect(patchSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: { spec: expect.objectContaining({ clusterTenantRef: null }) },
    }), expect.anything());
    // …and the DB row stores null.
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: { clusterTenantRef: null },
    }));
  });

  it("attaches a non-empty clusterTenantRef on update (CRD patch + DB)", async () =>
  {
    const patchSpy = vi.fn().mockResolvedValue({});
    const updateSpy = vi.fn().mockResolvedValue({});
    const customApi = { patchNamespacedCustomObject: patchSpy } as unknown as k8s.CustomObjectsApi;
    const prisma = {
      tenant: { update: updateSpy },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildTenantsApp(customApi, prisma);
    const response = await request(app)
      .put("/api/tenants/acme")
      .send({ clusterTenantRef: "acme-corp" });

    expect(response.status).toBe(200);
    expect(patchSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: { spec: expect.objectContaining({ clusterTenantRef: "acme-corp" }) },
    }), expect.anything());
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: { clusterTenantRef: "acme-corp" },
    }));
  });
});
