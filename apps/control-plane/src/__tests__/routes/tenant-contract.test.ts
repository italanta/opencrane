import express from "express";
import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { _RegisterInternalTenantContract } from "../../routes/internal/tenant-contract.js";
import { compile } from "../../core/grants/grant-compiler.js";
import { GrantCompilerAccess } from "../../core/grants/grant-compiler.types.js";

// Mock the grant compiler at the module boundary so tests can drive Allow/Deny
// decisions directly without constructing grant rows. Default: no entitlements,
// which keeps every existing test's empty-contract expectations intact.
vi.mock("../../core/grants/grant-compiler.js", () => ({
  compile: vi.fn().mockResolvedValue([]),
}));

// Per-skill model resolution is exercised by its own suite; stub it to [] here so
// the contract-shaping assertions stay focused on entitlement enrichment.
vi.mock("../../core/model-routing/resolve-contract-skill-models.js", () => ({
  _ResolveContractSkillModels: vi.fn().mockResolvedValue([]),
}));

/** Build a mock AuthenticationV1Api that returns a controlled TokenReview response. */
function _buildAuthApi(opts: {
  authenticated: boolean;
  subject?: string;
  audiences?: string[];
}): k8s.AuthenticationV1Api
{
  const status: k8s.V1TokenReviewStatus = {
    authenticated: opts.authenticated,
    audiences: opts.audiences ?? ["control-plane"],
    user: opts.subject ? { username: opts.subject } : undefined,
  };
  return {
    createTokenReview: vi.fn().mockResolvedValue({ status } as k8s.V1TokenReview),
  } as unknown as k8s.AuthenticationV1Api;
}

/** Build a mock Prisma client for contract endpoint tests. */
function _buildPrismaStub(overrides: {
  tenant?: { name: string; team: string | null; awarenessWave?: string | null } | null;
  rollout?: Record<string, unknown> | null;
} = {}): PrismaClient
{
  const tenant = "tenant" in overrides ? overrides.tenant : { name: "team-alpha", team: null };
  const rollout = "rollout" in overrides ? overrides.rollout : null;

  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(tenant),
    },
    grant: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    group: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tenantDatasetMembership: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    mcpServer: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    skillBundle: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tenantWorkspaceDoc: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    awarenessRollout: {
      findUnique: vi.fn().mockResolvedValue(rollout),
    },
  } as unknown as PrismaClient;
}

/** Build a test Express app containing only the internal contract router. */
function _buildApp(prisma: PrismaClient, authApi: k8s.AuthenticationV1Api): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/internal/contract", _RegisterInternalTenantContract(prisma, authApi));
  return app;
}

/** Shared valid auth API for happy-path tests — authenticates as tenant `team-alpha`. */
const _validAuthApi = _buildAuthApi({
  authenticated: true,
  subject: "system:serviceaccount:opencrane:team-alpha",
  audiences: ["control-plane"],
});

describe("_RegisterInternalTenantContract GET /:name", () =>
{
  it("returns 401 when no Authorization header is present", async () =>
  {
    const prisma = _buildPrismaStub();
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app).get("/api/internal/contract/team-alpha");

    expect(res.status).toBe(401);
  });

  it("returns 401 when the token is not authenticated", async () =>
  {
    const authApi = _buildAuthApi({ authenticated: false });
    const prisma = _buildPrismaStub();
    const app = _buildApp(prisma, authApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
  });

  it("returns 403 when the authenticated tenant does not match the requested tenant", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: { name: "team-beta", team: null } });
    const app = _buildApp(prisma, _validAuthApi);

    // `_validAuthApi` authenticates as `team-alpha`, but we request `team-beta`.
    const res = await request(app)
      .get("/api/internal/contract/team-beta")
      .set("Authorization", "Bearer valid-token-for-team-alpha");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 404 when the authenticated tenant does not exist in the database", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: null });
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns a contract with the expected shape for a known tenant", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: { name: "team-alpha", team: "alpha" } });
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("opencrane-runtime/v1alpha1");
    expect(res.body.tenant.name).toBe("team-alpha");
    expect(res.body.tenant.team).toBe("alpha");
    expect(res.body.policy.mcpServers).toBeDefined();
    expect(res.body.skills.entitled).toBeInstanceOf(Array);
    // P4B.3: awareness contract version delivered on every pull. With no rollout
    // defined and an unassigned tenant, it resolves to the pinned version, no shadow,
    // and the final (most-conservative) wave.
    expect(typeof res.body.awareness.contractVersion).toBe("string");
    expect(res.body.awareness.contractVersion.length).toBeGreaterThan(0);
    expect(res.body.awareness).toMatchObject({ shadow: false, wave: "org" });
  });

  it("delivers the rollout target version for a tenant in a promoted wave (P4B.3)", async () =>
  {
    const prisma = _buildPrismaStub({
      tenant: { name: "team-alpha", team: null, awarenessWave: "personal" },
      rollout: {
        id: "default", targetVersion: "awareness/v2alpha1", stableVersion: "awareness/v1alpha1",
        waves: ["personal", "project", "department", "org"], promotedWaves: ["personal"], shadowMode: false,
      },
    });
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(200);
    // The tenant's "personal" wave is promoted → it runs the target version.
    expect(res.body.awareness).toMatchObject({ contractVersion: "awareness/v2alpha1", shadow: false, wave: "personal" });
  });

  it("includes MCP server policy arrays in the response", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: { name: "team-alpha", team: null } });
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.policy.mcpServers.allow)).toBe(true);
    expect(Array.isArray(res.body.policy.mcpServers.deny)).toBe(true);
  });

  it("includes a contract-derived TOOLS.md workspace doc", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: { name: "team-alpha", team: null } });
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(200);
    const tools = res.body.workspace?.["TOOLS.md"];
    expect(typeof tools).toBe("string");
    expect(tools).toContain("# TOOLS");
    // With no entitlements the section renders an explicit "none" note rather than vanishing.
    expect(tools).toContain("No MCP servers are currently entitled.");
  });

  it("enriches skills.entitled with the name + digest the pod needs to pull each bundle", async () =>
  {
    const prisma = _buildPrismaStub({ tenant: { name: "team-alpha", team: null } });
    // The route compiles MCP grants first, then skill grants. Allow one skill bundle.
    // The route only reads `payloadId` + `access`, so cast a minimal decision rather
    // than fabricate every CompiledGrantDecision field.
    const _allowBundle1 = [{ payloadId: "bundle-1", access: GrantCompilerAccess.Allow }] as unknown as Awaited<ReturnType<typeof compile>>;
    vi.mocked(compile)
      .mockResolvedValueOnce([]) // McpServer decisions
      .mockResolvedValueOnce(_allowBundle1); // SkillBundle decisions
    // The entitled-bundle metadata the contract must surface (digest is what addresses the registry).
    (prisma.skillBundle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "bundle-1", name: "company-policy", description: "Org policy", digest: "sha256:abc123" },
    ]);
    const app = _buildApp(prisma, _validAuthApi);

    const res = await request(app)
      .get("/api/internal/contract/team-alpha")
      .set("Authorization", "Bearer valid");

    expect(res.status).toBe(200);
    expect(res.body.skills.entitled).toEqual([
      { id: "bundle-1", name: "company-policy", digest: "sha256:abc123" },
    ]);
  });
});
