import { Buffer } from "node:buffer";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";
import { ModelRoutingScope } from "@opencrane/contracts";
import type { PrismaClient, ProviderCredential as PrismaProviderCredential } from "@prisma/client";

import { _DeleteLiteLlmCredential, _UpsertLiteLlmCredential } from "./litellm-credential-registration.js";
import { _RegisterLiteLlmModel } from "./litellm-model-registration.js";
import { _BYOK_PROVIDER_CATALOG } from "./byok-default-models.js";
import type { ByokProviderCatalog } from "./byok-default-models.js";

/**
 * Reusable core for setting/removing a silo's BYOK provider key — the work behind both the HTTP
 * route (`providerByokRouter`) and the boot-time bootstrap. Writing it here (not in `routes/`) keeps
 * the provisioning logic out of the HTTP layer so the operator boot path can call it directly.
 *
 * A set: write the raw key to a k8s Secret (durable source of truth) → push to LiteLLM's
 * `/credentials` dynamic path (best-effort) → upsert the Global ProviderCredential row → seed a
 * default model bound to it. A key is Global-scoped (silo-wide), never per openclaw tenant.
 */

/** Outcome of {@link _ProvisionByokKey}. */
export interface ProvisionByokKeyResult
{
  /** True when LiteLLM's `/credentials` accepted the key (false ⇒ Secret-only / env baseline). */
  litellmRegistered: boolean;
  /** The upserted Global ProviderCredential row. */
  row: PrismaProviderCredential;
}

/** Name of the k8s Secret carrying a provider's raw BYOK key, in the operator's own namespace. */
export function _byokSecretName(provider: string): string
{
  return `byok-provider-key-${provider}`;
}

/** Name of the LiteLLM `/credentials` entry for a provider's BYOK key. */
export function _byokCredentialName(provider: string): string
{
  return `byok-${provider}`;
}

/**
 * Provision (set or refresh) a silo's raw BYOK key for a provider: persist the Secret, register the
 * LiteLLM credential, record the ProviderCredential row, and seed a default model bound to it.
 *
 * @param opts.prisma            - Prisma client for the credential + model rows.
 * @param opts.coreApi           - Kubernetes Core V1 API for the Secret write.
 * @param opts.operatorNamespace - The operator's own namespace (where the silo's keys live).
 * @param opts.provider          - The provider the key is for (e.g. `openai`).
 * @param opts.apiKey            - The raw upstream key (never logged or echoed).
 * @param opts.log               - Scoped logger for the best-effort model-seed warning.
 * @returns Whether LiteLLM accepted the key, and the upserted credential row.
 */
export async function _ProvisionByokKey(opts: {
  prisma: PrismaClient;
  coreApi: k8s.CoreV1Api;
  operatorNamespace: string;
  provider: string;
  apiKey: string;
  log: Logger;
}): Promise<ProvisionByokKeyResult>
{
  const { prisma, coreApi, operatorNamespace, provider, apiKey, log } = opts;
  const catalog = _BYOK_PROVIDER_CATALOG[provider];

  // 1. Persist the raw key to its k8s Secret first — the durable source of truth.
  await _applyProviderKeySecret(coreApi, operatorNamespace, provider, apiKey);

  // 2. Best-effort push to LiteLLM's /credentials dynamic path; Secret-only when unconfigured/down.
  //    custom_llm_provider is the catalog's litellmProvider (glm ⇒ zai), falling back to the key.
  const credentialName = _byokCredentialName(provider);
  const litellmRegistered = await _UpsertLiteLlmCredential({ credentialName, provider: catalog?.litellmProvider ?? provider, apiKey });

  // 3. Record the credential reference (litellmCredentialName set only when LiteLLM accepted it).
  const secretRef = _byokSecretName(provider);
  const litellmCredentialName = litellmRegistered ? credentialName : null;
  const row = await _upsertCredentialRow(prisma, provider, secretRef, litellmCredentialName);

  // 4. Best-effort: register EVERY model class for the provider, all bound to this one credential,
  //    so LiteLLM can switch across tiers on the single key. Never fail the set if this trips.
  try
  {
    await _ensureProviderModels(prisma, catalog, row.id, litellmCredentialName);
  }
  catch (err)
  {
    log.warn({ provider, err }, "byok model seed failed; key is set but its models were not seeded");
  }

  return { litellmRegistered, row };
}

/**
 * Remove a silo's BYOK key for a provider: delete the Secret, the LiteLLM credential, and the row.
 *
 * @param opts.prisma            - Prisma client.
 * @param opts.coreApi           - Kubernetes Core V1 API.
 * @param opts.operatorNamespace - The operator's own namespace.
 * @param opts.provider          - The provider whose key to remove.
 */
export async function _DeprovisionByokKey(opts: {
  prisma: PrismaClient;
  coreApi: k8s.CoreV1Api;
  operatorNamespace: string;
  provider: string;
}): Promise<void>
{
  await _deleteProviderKeySecret(opts.coreApi, opts.operatorNamespace, opts.provider);
  await _DeleteLiteLlmCredential(_byokCredentialName(opts.provider));
  await opts.prisma.providerCredential.deleteMany({ where: { scope: "Global", clusterTenant: null, provider: opts.provider } });
}

/**
 * Write (create-or-replace) the provider's raw key into a k8s Secret in the operator's namespace.
 * Reads first to carry `resourceVersion` on replace (PUT requires it); a 404 read falls through to
 * a create. The Secret is the durable source of truth — it survives a LiteLLM DB reset.
 */
async function _applyProviderKeySecret(coreApi: k8s.CoreV1Api, namespace: string, provider: string, apiKey: string): Promise<void>
{
  const name = _byokSecretName(provider);
  const body: k8s.V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "clustertenant-operator",
        "opencrane.io/byok-provider": provider,
      },
    },
    type: "Opaque",
    data: { apiKey: Buffer.from(apiKey).toString("base64") },
  };

  try
  {
    const existing = await coreApi.readNamespacedSecret({ name, namespace });
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await coreApi.replaceNamespacedSecret({ name, namespace, body });
  }
  catch (err)
  {
    if (_k8sStatus(err) !== 404)
    {
      throw err;
    }
    await coreApi.createNamespacedSecret({ namespace, body });
  }
}

/** Best-effort delete of the provider's key Secret, treating 404 (already gone) as success. */
async function _deleteProviderKeySecret(coreApi: k8s.CoreV1Api, namespace: string, provider: string): Promise<void>
{
  try
  {
    await coreApi.deleteNamespacedSecret({ name: _byokSecretName(provider), namespace });
  }
  catch (err)
  {
    if (_k8sStatus(err) !== 404)
    {
      throw err;
    }
  }
}

/** Extract a Kubernetes API status code from the common client error shapes. */
function _k8sStatus(err: unknown): number | undefined
{
  if (typeof err !== "object" || err === null)
  {
    return undefined;
  }
  const e = err as { statusCode?: unknown; code?: unknown; body?: { code?: unknown } };
  if (typeof e.statusCode === "number") { return e.statusCode; }
  if (typeof e.code === "number") { return e.code; }
  if (e.body && typeof e.body.code === "number") { return e.body.code; }
  return undefined;
}

/**
 * Upsert the Global-scoped {@link PrismaProviderCredential} row for a provider. findFirst →
 * update | create (not Prisma `upsert`) because the compound unique `[scope, clusterTenant, provider]`
 * carries a null `clusterTenant`. A concurrent create trips P2002 on the second writer; that is
 * caught and converged into an update so two simultaneous sets never 500.
 */
async function _upsertCredentialRow(prisma: PrismaClient, provider: string, secretRef: string, litellmCredentialName: string | null): Promise<PrismaProviderCredential>
{
  const where = { scope: "Global" as const, clusterTenant: null, provider };
  const existing = await prisma.providerCredential.findFirst({ where });
  if (existing)
  {
    return prisma.providerCredential.update({ where: { id: existing.id }, data: { secretRef, litellmCredentialName } });
  }
  try
  {
    return await prisma.providerCredential.create({ data: { ...where, secretRef, litellmCredentialName } });
  }
  catch (err)
  {
    // A concurrent create won the race — converge by updating the row it inserted.
    if ((err as { code?: unknown }).code !== "P2002")
    {
      throw err;
    }
    const raced = await prisma.providerCredential.findFirst({ where });
    if (!raced)
    {
      throw err;
    }
    return prisma.providerCredential.update({ where: { id: raced.id }, data: { secretRef, litellmCredentialName } });
  }
}

/**
 * Best-effort: register EVERY model class in a provider's catalog, all Global-scoped and bound to
 * the provider's SINGLE credential, so the pod's `main` agent resolves to a `litellm-proxy` model
 * and LiteLLM can switch across the provider's tiers on the one key. The rows are surfaced by the
 * tenant-models endpoint into the pod config.
 *
 * Non-destructive: an existing Global row for a slug is reused (re-bound to this credential rather
 * than duplicated). The silo default is claimed by the catalog's `defaultClass` model only when no
 * Global model is default yet — the first provider configured wins, and an existing default (here
 * or a higher-precedence routing default) is never stolen.
 *
 * @param prisma                - Prisma client.
 * @param catalog               - The provider's catalog, or undefined (provider not catalogued ⇒ no-op).
 * @param providerCredentialId  - The single ProviderCredential id every class binds to.
 * @param litellmCredentialName - The LiteLLM credential name (null ⇒ Secret-only; models register
 *                                without a key binding and reconcile when LiteLLM is reachable).
 */
async function _ensureProviderModels(prisma: PrismaClient, catalog: ByokProviderCatalog | undefined, providerCredentialId: string, litellmCredentialName: string | null): Promise<void>
{
  if (!catalog)
  {
    return;
  }

  // 1. Find or register each class's Global model deployment, all bound to the ONE credential.
  let defaultModelId: string | null = null;
  for (const entry of catalog.models)
  {
    let model = await prisma.modelDefinition.findFirst({ where: { scope: "Global", clusterTenant: null, publicModelName: entry.slug } });
    if (model)
    {
      if (model.providerCredentialId !== providerCredentialId)
      {
        model = await prisma.modelDefinition.update({ where: { id: model.id }, data: { providerCredentialId } });
      }
    }
    else
    {
      const litellmModelId = await _RegisterLiteLlmModel({
        publicModelName: entry.slug,
        upstreamModel: entry.slug,
        scope: ModelRoutingScope.Global,
        clusterTenant: null,
        apiBase: null,
        apiKeyEnvRef: null,
        litellmCredentialName,
      });
      model = await prisma.modelDefinition.create({
        data: { scope: "Global", clusterTenant: null, publicModelName: entry.slug, litellmModelId, upstreamModel: entry.slug, apiBase: null, isDefault: false, providerCredentialId },
      });
    }
    if (entry.className === catalog.defaultClass)
    {
      defaultModelId = model.id;
    }
  }

  // 2. Claim the silo default with the provider's default-class model, only when nothing is default
  //    yet — first provider configured wins; never steal an existing default.
  if (defaultModelId)
  {
    const hasDefault = await prisma.modelDefinition.findFirst({ where: { scope: "Global", clusterTenant: null, isDefault: true } });
    if (!hasDefault)
    {
      await prisma.modelDefinition.update({ where: { id: defaultModelId }, data: { isDefault: true } });
    }
  }
}
