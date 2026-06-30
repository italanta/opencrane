import express from "express";
import type { Express } from "express";
import { GrantScope, SkillBundleStatus, type PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { skillCatalogRouter } from "../../routes/skill-catalog.js";

/** Build a minimal Prisma stub for skill catalog scan tests. */
function _buildPrismaStub(overrides: {
  findUnique?: Record<string, unknown> | null;
  update?: Record<string, unknown>;
  auditCreate?: Record<string, unknown>;
} = {}): PrismaClient
{
  return {
    skillBundle: {
      findUnique: vi.fn().mockResolvedValue(overrides.findUnique ?? null),
      update: vi.fn().mockResolvedValue(overrides.update ?? {}),
    },
    auditEntry: {
      create: vi.fn().mockResolvedValue(overrides.auditCreate ?? {}),
    },
  } as unknown as PrismaClient;
}

/** Build a test Express app containing only the skill-catalog router. */
function _buildApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/skills/catalog", skillCatalogRouter(prisma));
  return app;
}

describe("skillCatalogRouter — POST /:id/scan", () =>
{
  it("returns 404 when the bundle does not exist", async () =>
  {
    const prisma = _buildPrismaStub({ findUnique: null });
    const app = _buildApp(prisma);

    const res = await request(app).post("/api/v1/skills/catalog/missing-id/scan");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SKILL_BUNDLE_NOT_FOUND");
  });

  it("sets scanStatus to 'failed' when scanner is unavailable", async () =>
  {
    const prisma = _buildPrismaStub({
      findUnique: { id: "bundle-1", name: "my-skill", content: "# Hello" },
    });
    const app = _buildApp(prisma);

    const res = await request(app).post("/api/v1/skills/catalog/bundle-1/scan");

    // Scanner is unavailable in CI; scan must fail gracefully.
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(false);
    expect(res.body.scanStatus).toBe("failed");
    expect(res.body.reason).toBe("scanner-unavailable");
  });

  it("persists the scan outcome via prisma.skillBundle.update", async () =>
  {
    const updateSpy = vi.fn().mockResolvedValue({});
    const prisma = {
      skillBundle: {
        findUnique: vi.fn().mockResolvedValue({ id: "b1", name: "sk", content: "hello" }),
        update: updateSpy,
      },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildApp(prisma);
    await request(app).post("/api/v1/skills/catalog/b1/scan");

    // First update: set scanStatus to 'scanning'.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scanStatus: "scanning" }) }),
    );
    // Second update: persist outcome.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanStatus: expect.stringMatching(/^(passed|failed)$/) }),
      }),
    );
  });
});

describe("skillCatalogRouter — PUT /:id (publish gate)", () =>
{
  it("returns 422 when promoting to published and scan status is not passed", async () =>
  {
    const prisma = {
      skillBundle: {
        findUnique: vi.fn().mockResolvedValue({ scanStatus: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildApp(prisma);
    const res = await request(app)
      .put("/api/v1/skills/catalog/bundle-1")
      .send({ status: "published" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SCAN_REQUIRED");
  });

  it("returns 404 when promoting a non-existent bundle to published", async () =>
  {
    const prisma = {
      skillBundle: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildApp(prisma);
    const res = await request(app)
      .put("/api/v1/skills/catalog/no-bundle")
      .send({ status: "published" });

    expect(res.status).toBe(404);
  });

  it("allows promotion when scanStatus is passed", async () =>
  {
    const updateSpy = vi.fn().mockResolvedValue({});
    const prisma = {
      skillBundle: {
        findUnique: vi.fn().mockResolvedValue({ scanStatus: "passed" }),
        update: updateSpy,
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      skillEntitlement: { deleteMany: vi.fn().mockResolvedValue({}) },
      skillPromotion: { deleteMany: vi.fn().mockResolvedValue({}) },
      grant: { deleteMany: vi.fn().mockResolvedValue({}) },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const app = _buildApp(prisma);
    const res = await request(app)
      .put("/api/v1/skills/catalog/bundle-1")
      .send({ status: "published" });

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });
});

describe("skillCatalogRouter — POST / (direct-publish guard)", () =>
{
  it("maps API scope strings to Prisma enums on create", async () =>
  {
    const createSpy = vi.fn().mockResolvedValue({ id: "bundle-1", name: "demo-skill" });
    const prisma = {
      skillBundle: { create: createSpy },
      auditEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;
    const app = _buildApp(prisma);

    const res = await request(app)
      .post("/api/v1/skills/catalog")
      .send({
        name: "demo-skill",
        version: "1.0.0",
        digest: "sha256:abc",
        scope: "org",
      });

    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        scope: GrantScope.Org,
        status: SkillBundleStatus.Draft,
      }),
    }));
  });

  it("returns 400 when create receives an unsupported scope", async () =>
  {
    const prisma = _buildPrismaStub();
    const app = _buildApp(prisma);

    const res = await request(app)
      .post("/api/v1/skills/catalog")
      .send({
        name: "bad-skill",
        version: "1.0.0",
        digest: "sha256:abc",
        scope: "global",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when trying to create a bundle with status published", async () =>
  {
    const prisma = _buildPrismaStub();
    const app = _buildApp(prisma);

    const res = await request(app)
      .post("/api/v1/skills/catalog")
      .send({
        name: "evil-skill",
        version: "1.0.0",
        digest: "sha256:abc",
        scope: "org",
        status: "published",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SCAN_REQUIRED");
  });
});
