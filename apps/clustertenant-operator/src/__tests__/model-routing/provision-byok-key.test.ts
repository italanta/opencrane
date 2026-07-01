import { Buffer } from "node:buffer";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { _DeprovisionByokKey, _ProvisionByokKey, _byokSecretName } from "../../core/model-routing/provision-byok-key.js";

/**
 * The shared provisioning core behind both the BYOK route and the boot-time bootstrap. These pin
 * its contract directly (the bootstrap calls it without the HTTP layer): a set writes the Secret,
 * records the Global credential, and seeds a default model; a deprovision removes all three.
 */

type Row = Record<string, unknown>;

const _NS = "opencrane-acme";
const _log = { info() { /* noop */ }, warn() { /* noop */ } } as unknown as Logger;

function _mockPrisma(creds: Map<string, Row>, models: Map<string, Row>): PrismaClient
{
  let credSeq = 0;
  let modelSeq = 0;
  return {
    providerCredential: {
      findFirst: async function _f(args: { where: { provider?: string } }) { return Array.from(creds.values()).find(function _m(r) { return r.provider === args.where.provider; }) ?? null; },
      create: async function _c(args: { data: Row }) { const id = `cred-${++credSeq}`; const row = { id, updatedAt: new Date("2026-06-30T00:00:00.000Z"), ...args.data }; creds.set(id, row); return row; },
      update: async function _u(args: { where: { id: string }; data: Row }) { const row = { ...(creds.get(args.where.id) as Row), ...args.data }; creds.set(args.where.id, row); return row; },
      deleteMany: async function _d(args: { where: { provider: string } }) { let count = 0; for (const [id, r] of creds) { if (r.provider === args.where.provider) { creds.delete(id); count++; } } return { count }; },
    },
    modelDefinition: {
      findFirst: async function _mf(args: { where: Record<string, unknown> }) { return Array.from(models.values()).find(function _m(r) { return (args.where.publicModelName === undefined || r.publicModelName === args.where.publicModelName) && (args.where.isDefault === undefined || r.isDefault === args.where.isDefault); }) ?? null; },
      create: async function _mc(args: { data: Row }) { const id = `model-${++modelSeq}`; const row = { id, isDefault: false, providerCredentialId: null, ...args.data }; models.set(id, row); return row; },
      update: async function _mu(args: { where: { id: string }; data: Row }) { const row = { ...(models.get(args.where.id) as Row), ...args.data }; models.set(args.where.id, row); return row; },
    },
  } as unknown as PrismaClient;
}

function _mockCoreApi(secrets: Map<string, k8s.V1Secret>): k8s.CoreV1Api
{
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  return {
    readNamespacedSecret: async function _r(a: { name: string }) { const s = secrets.get(a.name); if (!s) { throw notFound(); } return s; },
    createNamespacedSecret: async function _c(a: { body: k8s.V1Secret }) { secrets.set(a.body.metadata!.name!, a.body); return a.body; },
    replaceNamespacedSecret: async function _rp(a: { name: string; body: k8s.V1Secret }) { secrets.set(a.name, a.body); return a.body; },
    deleteNamespacedSecret: async function _d(a: { name: string }) { if (!secrets.has(a.name)) { throw notFound(); } secrets.delete(a.name); return {}; },
  } as unknown as k8s.CoreV1Api;
}

describe("_ProvisionByokKey / _DeprovisionByokKey", function _suite()
{
  const _saved: Record<string, string | undefined> = {};
  beforeAll(function _clearEnv() { for (const k of ["LITELLM_ENDPOINT", "LITELLM_MASTER_KEY"]) { _saved[k] = process.env[k]; delete process.env[k]; } });
  afterAll(function _restoreEnv() { for (const k of ["LITELLM_ENDPOINT", "LITELLM_MASTER_KEY"]) { if (_saved[k] !== undefined) { process.env[k] = _saved[k]; } } });

  it("provisions: writes the Secret, records the credential, seeds a default model", async function _provision()
  {
    const creds = new Map<string, Row>();
    const models = new Map<string, Row>();
    const secrets = new Map<string, k8s.V1Secret>();

    const result = await _ProvisionByokKey({ prisma: _mockPrisma(creds, models), coreApi: _mockCoreApi(secrets), operatorNamespace: _NS, provider: "openai", apiKey: "sk-test-123", log: _log });

    // LiteLLM unconfigured in the test → Secret-only.
    expect(result.litellmRegistered).toBe(false);
    expect(Buffer.from(secrets.get(_byokSecretName("openai"))!.data!.apiKey, "base64").toString("utf8")).toBe("sk-test-123");
    expect(Array.from(creds.values())[0]).toMatchObject({ scope: "Global", clusterTenant: null, provider: "openai" });
    // All of the provider's model classes are seeded, ALL bound to the one credential.
    const seeded = Array.from(models.values());
    expect(seeded).toHaveLength(3);
    expect(seeded.map(function slug(m) { return m.publicModelName; }).sort()).toEqual(["openai/gpt-5.4", "openai/gpt-5.4-nano", "openai/gpt-5.5"]);
    expect(seeded.every(function bound(m) { return m.providerCredentialId === result.row.id; })).toBe(true);
    // The flagship (default class) claims the silo default; the other tiers do not.
    const flagship = seeded.find(function f(m) { return m.publicModelName === "openai/gpt-5.5"; });
    expect(flagship).toMatchObject({ isDefault: true });
    expect(seeded.filter(function d(m) { return m.isDefault; })).toHaveLength(1);
  });

  it("deprovisions: removes the Secret and the credential row", async function _deprovision()
  {
    const creds = new Map<string, Row>([["cred-1", { id: "cred-1", scope: "Global", clusterTenant: null, provider: "openai" }]]);
    const secrets = new Map<string, k8s.V1Secret>([[_byokSecretName("openai"), { metadata: { name: _byokSecretName("openai"), namespace: _NS } }]]);

    await _DeprovisionByokKey({ prisma: _mockPrisma(creds, new Map()), coreApi: _mockCoreApi(secrets), operatorNamespace: _NS, provider: "openai" });

    expect(secrets.has(_byokSecretName("openai"))).toBe(false);
    expect(creds.size).toBe(0);
  });
});
