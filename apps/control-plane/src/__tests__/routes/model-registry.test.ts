import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelRegistryRouter } from "../../routes/model-registry.js";

/** In-memory model_definitions store backing the mock Prisma client. */
type Row = Record<string, unknown>;

/** Build a Prisma stub over an in-memory map keyed by model id, with optional credential rows. */
function _mockPrisma(store: Map<string, Row>, credentials: Map<string, Row> = new Map()): PrismaClient
{
  let seq = 0;
  return {
    modelDefinition: {
      findMany: async function _findMany(args?: { where?: { clusterTenant?: string } })
      {
        const all = Array.from(store.values());
        const ct = args?.where?.clusterTenant;
        return ct ? all.filter(function _byCt(r) { return r.clusterTenant === ct; }) : all;
      },
      findUnique: async function _findUnique(args: { where: { id: string } }) { return store.get(args.where.id) ?? null; },
      create: async function _create(args: { data: Row })
      {
        const id = `model-${++seq}`;
        const now = new Date("2026-06-18T00:00:00.000Z");
        const row = { id, apiBase: null, isDefault: false, providerCredentialId: null, clusterTenant: null, createdAt: now, updatedAt: now, ...args.data };
        store.set(id, row);
        return row;
      },
      update: async function _update(args: { where: { id: string }; data: Row })
      {
        const row = { ...(store.get(args.where.id) as Row), ...args.data, updatedAt: new Date() };
        store.set(args.where.id, row);
        return row;
      },
      delete: async function _delete(args: { where: { id: string } }) { store.delete(args.where.id); return {}; },
    },
    providerCredential: {
      findUnique: async function _findCred(args: { where: { id: string } }) { return credentials.get(args.where.id) ?? null; },
    },
  } as unknown as PrismaClient;
}

/** Build a minimal app mounting only the model-registry router. */
function _buildApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/models", modelRegistryRouter(prisma));
  return app;
}

describe("modelRegistryRouter", function _suite()
{
  const originalEndpoint = process.env.LITELLM_ENDPOINT;
  const originalMasterKey = process.env.LITELLM_MASTER_KEY;

  beforeEach(function _resetEnv()
  {
    delete process.env.LITELLM_ENDPOINT;
    delete process.env.LITELLM_MASTER_KEY;
  });

  afterEach(function _restoreEnv()
  {
    if (originalEndpoint !== undefined) { process.env.LITELLM_ENDPOINT = originalEndpoint; } else { delete process.env.LITELLM_ENDPOINT; }
    if (originalMasterKey !== undefined) { process.env.LITELLM_MASTER_KEY = originalMasterKey; } else { delete process.env.LITELLM_MASTER_KEY; }
    vi.restoreAllMocks();
  });

  it("lists models", async function _list()
  {
    const store = new Map<string, Row>([
      ["model-1", { id: "model-1", scope: "Global", clusterTenant: null, publicModelName: "openai/gpt-4o", litellmModelId: "placeholder:openai-gpt-4o", upstreamModel: "openai/gpt-4o", apiBase: null, isDefault: false, providerCredentialId: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store))).get("/api/v1/models");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].publicModelName).toBe("openai/gpt-4o");
  });

  it("creates a model with a deterministic placeholder id when LiteLLM is unconfigured", async function _createUnconfigured()
  {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/models").send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });

    expect(res.status).toBe(201);
    expect(res.body.litellmModelId).toBe("placeholder:global-openai-gpt-4o");
    expect(res.body.scope).toBe("global");
    // No live LiteLLM → no outbound registration call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers with LiteLLM and stores the returned model id when configured", async function _createConfigured()
  {
    process.env.LITELLM_ENDPOINT = "http://litellm:4000";
    process.env.LITELLM_MASTER_KEY = "master-key";

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async function _json() { return { model_id: "deploy-abc123" }; },
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/models").send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });

    expect(res.status).toBe(201);
    expect(res.body.litellmModelId).toBe("deploy-abc123");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://litellm:4000/model/new");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model_name).toBe("openai/gpt-4o");
    expect(body.litellm_params.model).toBe("openai/gpt-4o");
    // GLOBAL registration: never set the Enterprise-gated team_id.
    expect(body.model_info).toBeUndefined();
  });

  it("falls back to the placeholder id when LiteLLM returns an error (non-fatal)", async function _createLiteLlmError()
  {
    process.env.LITELLM_ENDPOINT = "http://litellm:4000";
    process.env.LITELLM_MASTER_KEY = "master-key";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async function _text() { return "boom"; } }));

    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/models").send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });

    expect(res.status).toBe(201);
    expect(res.body.litellmModelId).toBe("placeholder:global-openai-gpt-4o");
  });

  it("derives distinct placeholder ids for the same slug at different scopes (uniqueness)", async function _placeholderScopeUniqueness()
  {
    const store = new Map<string, Row>();
    const app = _buildApp(_mockPrisma(store));

    const global = await request(app).post("/api/v1/models").send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });
    const scoped = await request(app).post("/api/v1/models").send({ scope: "clusterTenant", clusterTenant: "acme", publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });

    expect(global.body.litellmModelId).toBe("placeholder:global-openai-gpt-4o");
    expect(scoped.body.litellmModelId).toBe("placeholder:clustertenant-acme-openai-gpt-4o");
    expect(global.body.litellmModelId).not.toBe(scoped.body.litellmModelId);
  });

  it("rejects a model that references a credential owned by another ClusterTenant (400)", async function _credentialScopeMismatch()
  {
    const credentials = new Map<string, Row>([
      ["cred-b", { id: "cred-b", scope: "ClusterTenant", clusterTenant: "tenant-b", provider: "openai", secretRef: "k" }],
    ]);
    const res = await request(_buildApp(_mockPrisma(new Map(), credentials)))
      .post("/api/v1/models")
      .send({ scope: "clusterTenant", clusterTenant: "tenant-a", publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o", providerCredentialId: "cred-b" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CREDENTIAL_SCOPE_MISMATCH");
  });

  it("allows a model to bind a Global credential", async function _globalCredentialAllowed()
  {
    const credentials = new Map<string, Row>([
      ["cred-g", { id: "cred-g", scope: "Global", clusterTenant: null, provider: "openai", secretRef: "openai-key" }],
    ]);
    const res = await request(_buildApp(_mockPrisma(new Map(), credentials)))
      .post("/api/v1/models")
      .send({ scope: "clusterTenant", clusterTenant: "tenant-a", publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o", providerCredentialId: "cred-g" });

    expect(res.status).toBe(201);
    expect(res.body.providerCredentialId).toBe("cred-g");
  });

  it("rejects a model that references a non-existent credential (400)", async function _missingCredential()
  {
    const res = await request(_buildApp(_mockPrisma(new Map())))
      .post("/api/v1/models")
      .send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o", providerCredentialId: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing required field with 400", async function _missingRequired()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/models").send({ publicModelName: "openai/gpt-4o" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects clusterTenant scope without a clusterTenant with 400", async function _missingClusterTenant()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/models").send({ scope: "clusterTenant", publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for an unknown model", async function _get404()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).get("/api/v1/models/nope");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("MODEL_DEFINITION_NOT_FOUND");
  });

  it("deletes an existing model", async function _delete()
  {
    const store = new Map<string, Row>([
      ["model-1", { id: "model-1", scope: "Global", clusterTenant: null, publicModelName: "openai/gpt-4o", litellmModelId: "x", upstreamModel: "openai/gpt-4o", apiBase: null, isDefault: false, providerCredentialId: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store))).delete("/api/v1/models/model-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "model-1", status: "deleted" });
    expect(store.has("model-1")).toBe(false);
  });

  it("rejects a PUT that rebinds a credential owned by another ClusterTenant (400)", async function _putCredentialScopeMismatch()
  {
    const store = new Map<string, Row>([
      ["model-1", { id: "model-1", scope: "ClusterTenant", clusterTenant: "acme", publicModelName: "openai/gpt-4o", litellmModelId: "x", upstreamModel: "openai/gpt-4o", apiBase: null, isDefault: false, providerCredentialId: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const credentials = new Map<string, Row>([
      ["cred-b", { id: "cred-b", scope: "ClusterTenant", clusterTenant: "tenant-b", secretRef: "s" }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store, credentials)))
      .put("/api/v1/models/model-1")
      .send({ scope: "clusterTenant", clusterTenant: "acme", publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o", providerCredentialId: "cred-b" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CREDENTIAL_SCOPE_MISMATCH");
    expect((store.get("model-1") as Row).providerCredentialId).toBeNull();
  });

  it("updates fields and binds a Global credential via PUT", async function _putUpdate()
  {
    const store = new Map<string, Row>([
      ["model-1", { id: "model-1", scope: "Global", clusterTenant: null, publicModelName: "openai/gpt-4o", litellmModelId: "x", upstreamModel: "openai/gpt-4o", apiBase: null, isDefault: false, providerCredentialId: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const credentials = new Map<string, Row>([
      ["cred-g", { id: "cred-g", scope: "Global", clusterTenant: null, secretRef: "s" }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store, credentials)))
      .put("/api/v1/models/model-1")
      .send({ publicModelName: "openai/gpt-4o", upstreamModel: "openai/gpt-4o-mini", providerCredentialId: "cred-g", isDefault: true });

    expect(res.status).toBe(200);
    expect(res.body.upstreamModel).toBe("openai/gpt-4o-mini");
    expect(res.body.providerCredentialId).toBe("cred-g");
    expect(res.body.isDefault).toBe(true);
  });
});
