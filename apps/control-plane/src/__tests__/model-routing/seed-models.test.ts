import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _SeedModels } from "../../core/model-routing/seed-models.js";

/** An in-memory row in either backing store. */
type Row = Record<string, unknown>;

/** A no-op logger satisfying the subset of the pino Logger surface _SeedModels uses. */
function _silentLog(): { info: () => void; warn: () => void; debug: () => void }
{
  return { info: function _i() {}, warn: function _w() {}, debug: function _d() {} };
}

/**
 * Build a Prisma stub over two in-memory maps (model_definitions + model_routing_defaults) with
 * just the methods _SeedModels touches: modelDefinition.findFirst/create and
 * modelRoutingDefault.findFirst/create/update. Keyed for deterministic assertions.
 *
 * @param models   - Pre-seeded model_definitions store (keyed by id).
 * @param defaults - Pre-seeded model_routing_defaults store (keyed by `scope:clusterTenant`).
 * @returns A Prisma-shaped stub plus the two backing maps.
 */
function _mockPrisma(models: Map<string, Row> = new Map(), defaults: Map<string, Row> = new Map()): PrismaClient
{
  let modelSeq = 0;
  let defaultSeq = 0;
  function _key(scope: string, clusterTenant: string | null): string { return `${scope}:${clusterTenant ?? ""}`; }
  return {
    modelDefinition: {
      findFirst: async function _findFirst(args: { where: { scope: string; publicModelName: string } })
      {
        return Array.from(models.values()).find(function _match(r) { return r.scope === args.where.scope && r.publicModelName === args.where.publicModelName; }) ?? null;
      },
      create: async function _create(args: { data: Row })
      {
        const id = `model-${++modelSeq}`;
        const now = new Date("2026-06-19T00:00:00.000Z");
        const row: Row = { id, apiBase: null, isDefault: false, providerCredentialId: null, clusterTenant: null, createdAt: now, updatedAt: now, ...args.data };
        models.set(id, row);
        return row;
      },
    },
    modelRoutingDefault: {
      findFirst: async function _findFirst(args: { where: { scope: string; clusterTenant: string | null } })
      {
        return defaults.get(_key(args.where.scope, args.where.clusterTenant)) ?? null;
      },
      create: async function _create(args: { data: Row })
      {
        const row: Row = { id: `default-${++defaultSeq}`, ...args.data };
        defaults.set(_key(String(row.scope), (row.clusterTenant as string | null) ?? null), row);
        return row;
      },
      update: async function _update(args: { where: { id: string }; data: Row })
      {
        for (const [k, v] of defaults)
        {
          if (v.id === args.where.id)
          {
            const row = { ...v, ...args.data };
            defaults.set(k, row);
            return row;
          }
        }
        return null;
      },
    },
  } as unknown as PrismaClient;
}

describe("_SeedModels", function _suite()
{
  const original = process.env.MODEL_REGISTRY_SEED;

  beforeEach(function _resetEnv()
  {
    delete process.env.MODEL_REGISTRY_SEED;
    delete process.env.LITELLM_ENDPOINT;
    delete process.env.LITELLM_MASTER_KEY;
  });

  afterEach(function _restoreEnv()
  {
    if (original !== undefined) { process.env.MODEL_REGISTRY_SEED = original; } else { delete process.env.MODEL_REGISTRY_SEED; }
    vi.restoreAllMocks();
  });

  it("seeds a new Global model with apiBase passed through and a placeholder id", async function _seedsNew()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "local/llama-3.3-70b", upstreamModel: "openai/llama-3.3-70b", apiKeyEnvRef: "LOCAL_LLM_API_KEY", apiBase: "http://my-vllm.internal:8000/v1" },
    ]);
    const models = new Map<string, Row>();
    await _SeedModels(_mockPrisma(models), _silentLog() as never);

    expect(models.size).toBe(1);
    const row = Array.from(models.values())[0];
    expect(row.scope).toBe("Global");
    expect(row.publicModelName).toBe("local/llama-3.3-70b");
    expect(row.apiBase).toBe("http://my-vllm.internal:8000/v1");
    expect(row.providerCredentialId).toBeNull();
    // Unconfigured LiteLLM → deterministic Global placeholder id.
    expect(row.litellmModelId).toBe("placeholder:global-local-llama-3-3-70b");
  });

  it("registers the api_key as an os.environ reference + the apiBase when LiteLLM is configured", async function _registersLiteLlm()
  {
    process.env.LITELLM_ENDPOINT = "http://litellm:4000";
    process.env.LITELLM_MASTER_KEY = "master-key";
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "openai/gpt-5", upstreamModel: "openai/gpt-5", apiKeyEnvRef: "OPENAI_API_KEY" },
    ]);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async function _json() { return { model_id: "deploy-xyz" }; } });
    vi.stubGlobal("fetch", fetchSpy);

    const models = new Map<string, Row>();
    await _SeedModels(_mockPrisma(models), _silentLog() as never);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.model_name).toBe("openai/gpt-5");
    expect(body.litellm_params.api_key).toBe("os.environ/OPENAI_API_KEY");
    expect(Array.from(models.values())[0].litellmModelId).toBe("deploy-xyz");
  });

  it("skips an entry whose publicModelName already exists at Global scope", async function _skipsExisting()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "openai/gpt-5", upstreamModel: "openai/gpt-5", apiKeyEnvRef: "OPENAI_API_KEY" },
    ]);
    const models = new Map<string, Row>([
      ["existing", { id: "existing", scope: "Global", publicModelName: "openai/gpt-5", upstreamModel: "openai/gpt-5-old", litellmModelId: "x", apiBase: null, isDefault: false, providerCredentialId: null }],
    ]);
    await _SeedModels(_mockPrisma(models), _silentLog() as never);

    // No new row created; the existing one is untouched.
    expect(models.size).toBe(1);
    expect(models.get("existing")!.upstreamModel).toBe("openai/gpt-5-old");
  });

  it("sets the Global ModelRoutingDefault for an isDefault entry", async function _setsDefault()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "anthropic/claude-sonnet-4-6", upstreamModel: "anthropic/claude-sonnet-4-6", apiKeyEnvRef: "ANTHROPIC_API_KEY", isDefault: true },
    ]);
    const defaults = new Map<string, Row>();
    await _SeedModels(_mockPrisma(new Map(), defaults), _silentLog() as never);

    expect(defaults.size).toBe(1);
    const row = defaults.get("Global:");
    expect(row?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("applies last-isDefault-wins when several entries are flagged default", async function _lastDefaultWins()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "a/first", upstreamModel: "a/first", apiKeyEnvRef: "K", isDefault: true },
      { publicModelName: "a/second", upstreamModel: "a/second", apiKeyEnvRef: "K", isDefault: true },
    ]);
    const defaults = new Map<string, Row>();
    await _SeedModels(_mockPrisma(new Map(), defaults), _silentLog() as never);

    expect(defaults.get("Global:")?.defaultModel).toBe("a/second");
  });

  it("no-ops when MODEL_REGISTRY_SEED is unset, blank, or malformed", async function _noOps()
  {
    for (const value of [undefined, "", "   ", "{not json", "{\"not\":\"array\"}"])
    {
      if (value === undefined) { delete process.env.MODEL_REGISTRY_SEED; } else { process.env.MODEL_REGISTRY_SEED = value; }
      const models = new Map<string, Row>();
      const defaults = new Map<string, Row>();
      // Must resolve (never throw) and create nothing.
      await expect(_SeedModels(_mockPrisma(models, defaults), _silentLog() as never)).resolves.toBeUndefined();
      expect(models.size).toBe(0);
      expect(defaults.size).toBe(0);
    }
  });

  it("one bad entry does not abort the rest", async function _badEntryIsolated()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { upstreamModel: "missing/public-name", apiKeyEnvRef: "K" }, // invalid: no publicModelName → coerced out
      { publicModelName: "good/model", upstreamModel: "good/model", apiKeyEnvRef: "K" }, // valid
    ]);
    const models = new Map<string, Row>();
    await _SeedModels(_mockPrisma(models), _silentLog() as never);

    expect(models.size).toBe(1);
    expect(Array.from(models.values())[0].publicModelName).toBe("good/model");
  });

  it("isolates a runtime failure on one entry so siblings still seed", async function _runtimeFailureIsolated()
  {
    process.env.MODEL_REGISTRY_SEED = JSON.stringify([
      { publicModelName: "boom/model", upstreamModel: "boom/model", apiKeyEnvRef: "K" },
      { publicModelName: "ok/model", upstreamModel: "ok/model", apiKeyEnvRef: "K" },
    ]);
    const models = new Map<string, Row>();
    const prisma = _mockPrisma(models);
    // Make the first create throw; the per-entry guard must catch it and continue. The second
    // call (the "ok/model" entry) falls through to the in-memory store.
    const realCreate = prisma.modelDefinition.create.bind(prisma.modelDefinition) as unknown as (args: { data: Row }) => Promise<Row>;
    let calls = 0;
    vi.spyOn(prisma.modelDefinition, "create").mockImplementation((function _create(args: { data: Row }): Promise<Row>
    {
      calls += 1;
      if (calls === 1) { throw new Error("db down"); }
      return realCreate(args);
    }) as never);

    await expect(_SeedModels(prisma, _silentLog() as never)).resolves.toBeUndefined();
    expect(models.size).toBe(1);
    expect(Array.from(models.values())[0].publicModelName).toBe("ok/model");
  });
});
