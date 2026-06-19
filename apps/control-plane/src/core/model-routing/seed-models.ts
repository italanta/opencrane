import { ModelRoutingScope } from "@opencrane/contracts";
import type { PrismaClient } from "@prisma/client";

import type { Logger } from "@opencrane/observability";

import { _RegisterLiteLlmModel } from "./litellm-model-registration.js";
import type { ModelSeedEntry } from "./seed-models.types.js";

/**
 * Idempotently seed global {@link import("@opencrane/contracts").ModelDefinition}s from the
 * `MODEL_REGISTRY_SEED` env var (a JSON array of {@link ModelSeedEntry}). Reuses the existing
 * registration path: each new model is persisted at Global scope and best-effort registered in
 * LiteLLM via {@link _RegisterLiteLlmModel}, exactly like the model-registry route.
 *
 * Everything is best-effort and non-fatal — an unset/blank/malformed env var is a no-op, and a
 * single bad entry never aborts the rest. This function NEVER throws, so it cannot block or crash
 * control-plane startup; it logs and returns instead.
 *
 * When an entry has `isDefault: true`, the Global {@link import("@opencrane/contracts").ModelRoutingDefault}
 * is upserted to that slug so inherit-posture skills resolve to it. Only one Global default exists
 * (`@@unique([scope, clusterTenant])`); last-isDefault-wins — the final `isDefault` entry in array
 * order is the one that sticks.
 *
 * @param prisma - Prisma client used for persistence + the default upsert.
 * @param log    - Logger for the best-effort diagnostics.
 */
export async function _SeedModels(prisma: PrismaClient, log: Logger): Promise<void>
{
  // 1. Decode the env var defensively — unset/blank/malformed must no-op, never throw, so a bad
  //    operator value can never block startup.
  const entries = _parseSeed(process.env.MODEL_REGISTRY_SEED, log);
  if (entries.length === 0)
  {
    return;
  }

  log.info({ count: entries.length }, "model-registry seed: processing entries");

  // 2. Process each entry in isolation so one failure cannot abort the rest of the seed.
  let lastDefault: string | null = null;
  for (const entry of entries)
  {
    try
    {
      const seeded = await _seedOne(prisma, log, entry);
      // 2a. Track the last isDefault slug that was successfully seeded (last-isDefault-wins).
      if (seeded && entry.isDefault === true)
      {
        lastDefault = entry.publicModelName.trim();
      }
    }
    catch (err)
    {
      log.warn({ err, publicModelName: entry.publicModelName }, "model-registry seed: entry failed (non-fatal)");
    }
  }

  // 3. Upsert the Global ModelRoutingDefault once, for the last isDefault entry, so inherit-posture
  //    skills resolve to the platform default. Best-effort — a failure here is also non-fatal.
  if (lastDefault)
  {
    await _upsertGlobalDefault(prisma, log, lastDefault);
  }
}

/**
 * Parse and validate the raw `MODEL_REGISTRY_SEED` value into clean seed entries. Returns an empty
 * array for unset/blank input and for malformed JSON (logging a warn in the latter case). Entries
 * missing the required `publicModelName`, `upstreamModel`, or `apiKeyEnvRef` are skipped with a warn.
 *
 * @param raw - The raw env var value (possibly undefined).
 * @param log - Logger for malformed-input + skipped-entry diagnostics.
 * @returns The validated, trimmed seed entries (possibly empty).
 */
function _parseSeed(raw: string | undefined, log: Logger): ModelSeedEntry[]
{
  // 1. Treat unset / blank as an explicit no-op (opt-in: empty default = no seeding).
  const trimmed = raw?.trim() ?? "";
  if (!trimmed)
  {
    return [];
  }

  // 2. Parse defensively — malformed JSON is logged and no-ops rather than throwing.
  let decoded: unknown;
  try
  {
    decoded = JSON.parse(trimmed);
  }
  catch (err)
  {
    log.warn({ err }, "model-registry seed: MODEL_REGISTRY_SEED is not valid JSON; skipping seed");
    return [];
  }

  // 3. The top level must be an array; anything else is a misconfiguration we skip.
  if (!Array.isArray(decoded))
  {
    log.warn("model-registry seed: MODEL_REGISTRY_SEED is not a JSON array; skipping seed");
    return [];
  }

  // 4. Keep only entries carrying the three required string fields; drop the rest with a warn.
  const valid: ModelSeedEntry[] = [];
  for (const candidate of decoded)
  {
    const entry = _coerceEntry(candidate);
    if (!entry)
    {
      log.warn({ candidate }, "model-registry seed: skipping invalid entry (needs publicModelName, upstreamModel, apiKeyEnvRef)");
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

/**
 * Coerce one untrusted array element into a {@link ModelSeedEntry}, or null when it lacks any of
 * the required string fields. Trims strings and normalises the optional `apiBase`/`isDefault`.
 *
 * @param candidate - One untrusted element of the decoded seed array.
 * @returns A clean seed entry, or null when required fields are absent.
 */
function _coerceEntry(candidate: unknown): ModelSeedEntry | null
{
  if (typeof candidate !== "object" || candidate === null)
  {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  const publicModelName = typeof obj.publicModelName === "string" ? obj.publicModelName.trim() : "";
  const upstreamModel = typeof obj.upstreamModel === "string" ? obj.upstreamModel.trim() : "";
  const apiKeyEnvRef = typeof obj.apiKeyEnvRef === "string" ? obj.apiKeyEnvRef.trim() : "";
  if (!publicModelName || !upstreamModel || !apiKeyEnvRef)
  {
    return null;
  }
  const apiBase = typeof obj.apiBase === "string" && obj.apiBase.trim() ? obj.apiBase.trim() : null;
  return { publicModelName, upstreamModel, apiKeyEnvRef, apiBase, isDefault: obj.isDefault === true };
}

/**
 * Seed a single entry idempotently at Global scope. Skips when a Global `ModelDefinition` already
 * owns the slug; otherwise best-effort registers it in LiteLLM and persists the row.
 *
 * @param prisma - Prisma client used for the existence check + create.
 * @param log    - Logger for skip / seed diagnostics.
 * @param entry  - The validated seed entry.
 * @returns True when a new row was created; false when the slug already existed (skipped).
 */
async function _seedOne(prisma: PrismaClient, log: Logger, entry: ModelSeedEntry): Promise<boolean>
{
  const publicModelName = entry.publicModelName.trim();

  // 1. Idempotency: a Global model already owning this slug is left untouched so re-runs are no-ops
  //    and an operator's later edits via the API are never clobbered by the seed.
  const existing = await prisma.modelDefinition.findFirst({ where: { scope: "Global", publicModelName } });
  if (existing)
  {
    log.debug({ publicModelName }, "model-registry seed: slug already present at Global scope; skipping");
    return false;
  }

  // 2. Best-effort LiteLLM registration — api_key is an os.environ/<ref> so the raw key never
  //    transits OpenCrane; returns a deterministic placeholder when LiteLLM is unconfigured.
  const apiBase = entry.apiBase?.trim() || null;
  const litellmModelId = await _RegisterLiteLlmModel({
    publicModelName,
    upstreamModel: entry.upstreamModel.trim(),
    scope: ModelRoutingScope.Global,
    clusterTenant: null,
    apiBase,
    apiKeyEnvRef: entry.apiKeyEnvRef.trim(),
  });

  // 3. Persist the Global row with the resolved deployment id; providerCredentialId stays null
  //    since the seed binds the key purely via the os.environ reference above.
  await prisma.modelDefinition.create({
    data: {
      scope: "Global",
      clusterTenant: null,
      publicModelName,
      litellmModelId,
      upstreamModel: entry.upstreamModel.trim(),
      apiBase,
      isDefault: entry.isDefault === true,
      providerCredentialId: null,
    },
  });
  log.info({ publicModelName, litellmModelId, apiBase }, "model-registry seed: registered Global model");
  return true;
}

/**
 * Upsert the single Global `ModelRoutingDefault` to the given slug so inherit-posture skills
 * resolve to it. Best-effort — logs and swallows any failure so it cannot block startup.
 *
 * @param prisma       - Prisma client used for the upsert.
 * @param log          - Logger for the diagnostic.
 * @param defaultModel - The `publicModelName` to set as the Global default.
 */
async function _upsertGlobalDefault(prisma: PrismaClient, log: Logger, defaultModel: string): Promise<void>
{
  try
  {
    // Resolve-then-branch keeps only one Global default. Prisma's compound-unique selector cannot
    // express a null clusterTenant (Global scope), so findFirst + update/create as the route does.
    const existing = await prisma.modelRoutingDefault.findFirst({ where: { scope: "Global", clusterTenant: null } });
    if (existing)
    {
      await prisma.modelRoutingDefault.update({ where: { id: existing.id }, data: { defaultModel } });
    }
    else
    {
      await prisma.modelRoutingDefault.create({ data: { scope: "Global", clusterTenant: null, defaultModel } });
    }
    log.info({ defaultModel }, "model-registry seed: set Global ModelRoutingDefault");
  }
  catch (err)
  {
    log.warn({ err, defaultModel }, "model-registry seed: failed to set Global ModelRoutingDefault (non-fatal)");
  }
}
