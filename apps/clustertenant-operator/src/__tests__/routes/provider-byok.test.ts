import { Buffer } from "node:buffer";

import express from "express";
import type { Express } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { providerByokRouter } from "../../routes/provider-byok.js";

/** In-memory provider_credentials store backing the mock Prisma client. */
type Row = Record<string, unknown>;

/** The operator namespace the router writes Secrets into, in tests. */
const _NS = "opencrane-acme";

/**
 * Build a Prisma stub over an in-memory map keyed by credential id, covering the calls the BYOK
 * router makes: findMany (with a provider `in` filter), findFirst, create, update, deleteMany.
 */
function _mockPrisma(store: Map<string, Row>, models: Map<string, Row> = new Map()): PrismaClient
{
  let seq = 0;
  let modelSeq = 0;
  const match = (r: Row, where?: { scope?: string; clusterTenant?: string | null; provider?: string }): boolean =>
    !where || ((where.scope === undefined || r.scope === where.scope)
      && (where.clusterTenant === undefined || r.clusterTenant === where.clusterTenant)
      && (where.provider === undefined || r.provider === where.provider));
  const matchModel = (r: Row, where?: { scope?: string; clusterTenant?: string | null; publicModelName?: string; isDefault?: boolean }): boolean =>
    !where || ((where.scope === undefined || r.scope === where.scope)
      && (where.clusterTenant === undefined || r.clusterTenant === where.clusterTenant)
      && (where.publicModelName === undefined || r.publicModelName === where.publicModelName)
      && (where.isDefault === undefined || r.isDefault === where.isDefault));
  return {
    modelDefinition: {
      findFirst: async function _mFindFirst(args: { where: Record<string, unknown> })
      {
        return Array.from(models.values()).find(function _m(r) { return matchModel(r, args.where); }) ?? null;
      },
      create: async function _mCreate(args: { data: Row })
      {
        const id = `model-${++modelSeq}`;
        const row = { id, isDefault: false, providerCredentialId: null, apiBase: null, ...args.data };
        models.set(id, row);
        return row;
      },
      update: async function _mUpdate(args: { where: { id: string }; data: Row })
      {
        const row = { ...(models.get(args.where.id) as Row), ...args.data };
        models.set(args.where.id, row);
        return row;
      },
    },
    providerCredential: {
      findMany: async function _findMany(args?: { where?: { provider?: { in?: string[] } } })
      {
        const inList = args?.where?.provider?.in;
        return Array.from(store.values()).filter(function _byIn(r) { return !inList || inList.includes(r.provider as string); });
      },
      findFirst: async function _findFirst(args: { where: { scope: string; clusterTenant: string | null; provider: string } })
      {
        return Array.from(store.values()).find(function _m(r) { return match(r, args.where); }) ?? null;
      },
      create: async function _create(args: { data: Row })
      {
        const id = `cred-${++seq}`;
        const now = new Date("2026-06-30T00:00:00.000Z");
        const row = { id, createdAt: now, updatedAt: now, ...args.data };
        store.set(id, row);
        return row;
      },
      update: async function _update(args: { where: { id: string }; data: Row })
      {
        const row = { ...(store.get(args.where.id) as Row), ...args.data, updatedAt: new Date("2026-06-30T12:00:00.000Z") };
        store.set(args.where.id, row);
        return row;
      },
      deleteMany: async function _deleteMany(args: { where: { provider: string } })
      {
        let count = 0;
        for (const [id, r] of store)
        {
          if (match(r, args.where)) { store.delete(id); count++; }
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;
}

/** A k8s 404 error shaped like the client's NotFound, used to drive the create path. */
function _notFound(): Error & { code: number }
{
  return Object.assign(new Error("not found"), { code: 404 });
}

/** Build a CoreV1Api stub backed by an in-memory Secret store keyed by name. */
function _mockCoreApi(secrets: Map<string, k8s.V1Secret>): k8s.CoreV1Api
{
  return {
    readNamespacedSecret: async function _read(args: { name: string })
    {
      const s = secrets.get(args.name);
      if (!s) { throw _notFound(); }
      return s;
    },
    createNamespacedSecret: async function _create(args: { body: k8s.V1Secret })
    {
      secrets.set(args.body.metadata!.name!, args.body);
      return args.body;
    },
    replaceNamespacedSecret: async function _replace(args: { name: string; body: k8s.V1Secret })
    {
      secrets.set(args.name, args.body);
      return args.body;
    },
    deleteNamespacedSecret: async function _delete(args: { name: string })
    {
      if (!secrets.has(args.name)) { throw _notFound(); }
      secrets.delete(args.name);
      return {};
    },
  } as unknown as k8s.CoreV1Api;
}

/**
 * Mount only the BYOK router over the supplied stores, seeding an org-admin session by default so
 * the `_RequireOrgAdmin`-gated mutations pass. Pass `{ isOrgAdmin: false }` to exercise the 403 path.
 */
function _buildApp(store: Map<string, Row>, secrets: Map<string, k8s.V1Secret>, user: { isOrgAdmin: boolean } = { isOrgAdmin: true }, models: Map<string, Row> = new Map()): Express
{
  const app = express();
  app.use(express.json());
  app.use(function _seedSession(req, _res, next) { (req as unknown as { session: { authUser: { isOrgAdmin: boolean } } }).session = { authUser: user }; next(); });
  app.use("/api/v1/providers/byok", providerByokRouter(_mockPrisma(store, models), _mockCoreApi(secrets), _NS));
  return app;
}

describe("providerByokRouter", function _suite()
{
  // LiteLLM is unconfigured in tests, so the /credentials push is a no-op and keys stay Secret-only.
  const _saved: Record<string, string | undefined> = {};
  beforeAll(function _clearLitellmEnv()
  {
    for (const k of ["LITELLM_ENDPOINT", "LITELLM_MASTER_KEY"]) { _saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterAll(function _restoreLitellmEnv()
  {
    for (const k of ["LITELLM_ENDPOINT", "LITELLM_MASTER_KEY"]) { if (_saved[k] !== undefined) { process.env[k] = _saved[k]; } }
  });

  it("sets a provider key: writes the Secret (base64), records the credential, Secret-only without LiteLLM", async function _set()
  {
    const store = new Map<string, Row>();
    const secrets = new Map<string, k8s.V1Secret>();
    const res = await request(_buildApp(store, secrets)).put("/api/v1/providers/byok/openai").send({ apiKey: "sk-live-123" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: "openai", configured: true, litellmRegistered: false });

    const secret = secrets.get("byok-provider-key-openai");
    expect(secret?.metadata?.namespace).toBe(_NS);
    expect(Buffer.from(secret!.data!.apiKey, "base64").toString("utf8")).toBe("sk-live-123");

    const row = Array.from(store.values())[0];
    expect(row).toMatchObject({ scope: "Global", clusterTenant: null, provider: "openai", secretRef: "byok-provider-key-openai", litellmCredentialName: null });
  });

  it("seeds a default model bound to the credential so the agent can route through LiteLLM", async function _seedsDefault()
  {
    const store = new Map<string, Row>();
    const models = new Map<string, Row>();
    const app = _buildApp(store, new Map(), { isOrgAdmin: true }, models);
    await request(app).put("/api/v1/providers/byok/openai").send({ apiKey: "sk-live-123" });

    const seeded = Array.from(models.values());
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ scope: "Global", clusterTenant: null, publicModelName: "openai/gpt-4o", isDefault: true });
    // Bound to the upserted credential row so LiteLLM resolves the BYOK key for it.
    const cred = Array.from(store.values())[0];
    expect(seeded[0].providerCredentialId).toBe(cred.id);
  });

  it("first provider configured wins the silo default; the second is added but not default", async function _firstWins()
  {
    const store = new Map<string, Row>();
    const models = new Map<string, Row>();
    const app = _buildApp(store, new Map(), { isOrgAdmin: true }, models);
    await request(app).put("/api/v1/providers/byok/openai").send({ apiKey: "k1" });
    await request(app).put("/api/v1/providers/byok/anthropic").send({ apiKey: "k2" });

    const byName = new Map(Array.from(models.values()).map(function _n(m) { return [m.publicModelName, m]; }));
    expect(byName.get("openai/gpt-4o")).toMatchObject({ isDefault: true });
    expect(byName.get("anthropic/claude-sonnet-4-5")).toMatchObject({ isDefault: false });
  });

  it("never echoes the raw key back in the response body", async function _noEcho()
  {
    const res = await request(_buildApp(new Map(), new Map())).put("/api/v1/providers/byok/anthropic").send({ apiKey: "sk-secret-xyz" });

    expect(JSON.stringify(res.body)).not.toContain("sk-secret-xyz");
  });

  it("refreshes an existing key in place (update, not duplicate row)", async function _refresh()
  {
    const store = new Map<string, Row>();
    const secrets = new Map<string, k8s.V1Secret>();
    const app = _buildApp(store, secrets);
    await request(app).put("/api/v1/providers/byok/gemini").send({ apiKey: "key-1" });
    const res = await request(app).put("/api/v1/providers/byok/gemini").send({ apiKey: "key-2" });

    expect(res.status).toBe(200);
    expect(Array.from(store.values()).filter(function _g(r) { return r.provider === "gemini"; })).toHaveLength(1);
    expect(Buffer.from(secrets.get("byok-provider-key-gemini")!.data!.apiKey, "base64").toString("utf8")).toBe("key-2");
  });

  it("denies a non-org-admin caller with 403 (mutations are org-admin only)", async function _denyNonAdmin()
  {
    const store = new Map<string, Row>();
    const secrets = new Map<string, k8s.V1Secret>();
    const app = _buildApp(store, secrets, { isOrgAdmin: false });
    const res = await request(app).put("/api/v1/providers/byok/openai").send({ apiKey: "sk-live-123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_NOT_ORG_ADMIN");
    expect(secrets.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it("rejects an unsupported provider with 400", async function _badProvider()
  {
    const res = await request(_buildApp(new Map(), new Map())).put("/api/v1/providers/byok/cohere").send({ apiKey: "x" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_PROVIDER");
  });

  it("rejects a missing apiKey with 400", async function _missingKey()
  {
    const res = await request(_buildApp(new Map(), new Map())).put("/api/v1/providers/byok/openai").send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("lists status across all supported providers, never the key", async function _list()
  {
    const store = new Map<string, Row>([
      ["cred-1", { id: "cred-1", scope: "Global", clusterTenant: null, provider: "openai", secretRef: "byok-provider-key-openai", litellmCredentialName: "byok-openai", updatedAt: new Date("2026-06-30T00:00:00.000Z") }],
    ]);
    const res = await request(_buildApp(store, new Map())).get("/api/v1/providers/byok");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    const openai = res.body.find(function _o(s: { provider: string }) { return s.provider === "openai"; });
    expect(openai).toMatchObject({ configured: true, litellmRegistered: true });
    const mistral = res.body.find(function _m(s: { provider: string }) { return s.provider === "mistral"; });
    expect(mistral).toMatchObject({ configured: false, litellmRegistered: false, updatedAt: null });
    expect(JSON.stringify(res.body)).not.toContain("apiKey");
  });

  it("removes a key: deletes the Secret and the record, idempotent 204", async function _delete()
  {
    const store = new Map<string, Row>([
      ["cred-1", { id: "cred-1", scope: "Global", clusterTenant: null, provider: "deepseek", secretRef: "byok-provider-key-deepseek", litellmCredentialName: null, updatedAt: new Date() }],
    ]);
    const secrets = new Map<string, k8s.V1Secret>([["byok-provider-key-deepseek", { metadata: { name: "byok-provider-key-deepseek", namespace: _NS } }]]);
    const app = _buildApp(store, secrets);

    const res = await request(app).delete("/api/v1/providers/byok/deepseek");
    expect(res.status).toBe(204);
    expect(secrets.has("byok-provider-key-deepseek")).toBe(false);
    expect(Array.from(store.values())).toHaveLength(0);

    // Idempotent: deleting again still returns 204.
    const again = await request(app).delete("/api/v1/providers/byok/deepseek");
    expect(again.status).toBe(204);
  });
});
