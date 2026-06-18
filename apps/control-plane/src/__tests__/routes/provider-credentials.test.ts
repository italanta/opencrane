import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { providerCredentialsRouter } from "../../routes/provider-credentials.js";

/** In-memory provider_credentials store backing the mock Prisma client. */
type Row = Record<string, unknown>;

/** Build a Prisma stub over an in-memory map keyed by credential id. */
function _mockPrisma(store: Map<string, Row>): PrismaClient
{
  let seq = 0;
  return {
    providerCredential: {
      findMany: async function _findMany(args?: { where?: { clusterTenant?: string } })
      {
        const all = Array.from(store.values());
        const ct = args?.where?.clusterTenant;
        return ct ? all.filter(function _byCt(r) { return r.clusterTenant === ct; }) : all;
      },
      findUnique: async function _findUnique(args: { where: { id: string } }) { return store.get(args.where.id) ?? null; },
      create: async function _create(args: { data: Row })
      {
        const id = `cred-${++seq}`;
        const now = new Date("2026-06-18T00:00:00.000Z");
        const row = { id, litellmCredentialName: null, clusterTenant: null, createdAt: now, updatedAt: now, ...args.data };
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
  } as unknown as PrismaClient;
}

/** Build a minimal app mounting only the provider-credentials router. */
function _buildApp(prisma: PrismaClient): Express
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1/providers/credentials", providerCredentialsRouter(prisma));
  return app;
}

describe("providerCredentialsRouter", function _suite()
{
  it("lists credentials", async function _list()
  {
    const store = new Map<string, Row>([
      ["cred-1", { id: "cred-1", scope: "Global", clusterTenant: null, provider: "openai", secretRef: "openai-key", litellmCredentialName: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store))).get("/api/v1/providers/credentials");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].provider).toBe("openai");
    expect(res.body[0].scope).toBe("global");
  });

  it("creates a global credential (happy path)", async function _create()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/providers/credentials").send({ provider: "anthropic", secretRef: "anthropic-key" });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("anthropic");
    expect(res.body.secretRef).toBe("anthropic-key");
    expect(res.body.scope).toBe("global");
    expect(res.body.clusterTenant).toBeNull();
  });

  it("creates a clusterTenant-scoped credential", async function _createScoped()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/providers/credentials").send({ scope: "clusterTenant", clusterTenant: "acme", provider: "openai", secretRef: "acme-openai-key" });

    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("clusterTenant");
    expect(res.body.clusterTenant).toBe("acme");
  });

  it("rejects a missing required field with 400", async function _missingRequired()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/providers/credentials").send({ provider: "openai" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects clusterTenant scope without a clusterTenant with 400", async function _missingClusterTenant()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/providers/credentials").send({ scope: "clusterTenant", provider: "openai", secretRef: "k" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a raw-key field with 400 (apiKey)", async function _rejectRawApiKey()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).post("/api/v1/providers/credentials").send({ provider: "openai", secretRef: "k", apiKey: "sk-secret" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RAW_KEY_REJECTED");
  });

  it("rejects a raw-key field with 400 (keyValue and key)", async function _rejectOtherRawKeys()
  {
    const app = _buildApp(_mockPrisma(new Map()));
    const a = await request(app).post("/api/v1/providers/credentials").send({ provider: "openai", secretRef: "k", keyValue: "sk-x" });
    const b = await request(app).post("/api/v1/providers/credentials").send({ provider: "openai", secretRef: "k", key: "sk-y" });

    expect(a.status).toBe(400);
    expect(a.body.code).toBe("RAW_KEY_REJECTED");
    expect(b.status).toBe(400);
    expect(b.body.code).toBe("RAW_KEY_REJECTED");
  });

  it("returns 404 for an unknown credential", async function _get404()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).get("/api/v1/providers/credentials/nope");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROVIDER_CREDENTIAL_NOT_FOUND");
  });

  it("deletes an existing credential", async function _delete()
  {
    const store = new Map<string, Row>([
      ["cred-1", { id: "cred-1", scope: "Global", clusterTenant: null, provider: "openai", secretRef: "k", litellmCredentialName: null, createdAt: new Date(), updatedAt: new Date() }],
    ]);
    const res = await request(_buildApp(_mockPrisma(store))).delete("/api/v1/providers/credentials/cred-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "cred-1", status: "deleted" });
    expect(store.has("cred-1")).toBe(false);
  });

  it("returns 404 when deleting an unknown credential", async function _delete404()
  {
    const res = await request(_buildApp(_mockPrisma(new Map()))).delete("/api/v1/providers/credentials/nope");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROVIDER_CREDENTIAL_NOT_FOUND");
  });
});
