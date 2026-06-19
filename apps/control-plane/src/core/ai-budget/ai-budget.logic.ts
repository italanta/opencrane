import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";

import { _log } from "../../log.js";
import { SpendLogic } from "../spend/spend.logic.js";

/** AI-budget controller dependencies. */
interface AiBudgetLogicDeps
{
  /** Kubernetes core API client for reading/deleting secrets. */
  coreApi: k8s.CoreV1Api;

  /** Prisma ORM client. */
  prisma: PrismaClient;

  /** Namespace where tenant resources are stored. */
  namespace: string;
}

/** Returns global monthly spend ceiling. */
export async function _GetGlobalBudget(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const item = await deps.prisma.globalBudgetSetting.findUnique({ where: { id: 1 } });

  if (!item)
  {
    res.json({ currency: "USD", ceilingAmount: 0 });
    return;
  }

  res.json({ currency: item.currency, ceilingAmount: Number(item.ceilingAmount) });
}

/** Updates the global monthly spend ceiling. */
export async function _PutGlobalBudget(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const currency = String(req.body.currency ?? "USD").toUpperCase();
  const ceilingAmount = Number(req.body.ceilingAmount ?? 0);

  await deps.prisma.globalBudgetSetting.upsert({
    where: { id: 1 },
    update: { currency, ceilingAmount },
    create: { id: 1, currency, ceilingAmount },
  });

  res.status(204).send();
}

/** Returns all per-account monthly spend ceilings. */
export async function _GetAccountBudgets(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const accounts = await deps.prisma.accountBudgetSetting.findMany({ orderBy: { userId: "asc" } });

  res.json(accounts.map(function _mapAccount(item)
  {
    return {
      userId: item.userId,
      currency: item.currency,
      ceilingAmount: Number(item.ceilingAmount),
    };
  }));
}

/** Creates or updates the budget ceiling for a specific account. */
export async function _PutAccountBudget(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const currency = String(req.body.currency ?? "USD").toUpperCase();
  const ceilingAmount = Number(req.body.ceilingAmount ?? 0);

  await deps.prisma.accountBudgetSetting.upsert({
    where: { userId },
    update: { currency, ceilingAmount },
    create: { userId, currency, ceilingAmount },
  });

  res.status(204).send();
}

/** Deletes a per-account spend ceiling. */
export async function _DeleteAccountBudget(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  await deps.prisma.accountBudgetSetting.deleteMany({ where: { userId } });
  res.status(204).send();
}

/** Returns a tenant spend summary sourced from LiteLLM usage APIs. */
export async function _GetTenantSpend(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const tenantName = Array.isArray(req.params.tenantName) ? req.params.tenantName[0] : req.params.tenantName;
  const masterKey = process.env.LITELLM_MASTER_KEY ?? "";

  if (!masterKey)
  {
    res.status(503).json({ error: "LITELLM_MASTER_KEY is not configured" });
    return;
  }

  const spendLogic = new SpendLogic(deps.prisma);

  try
  {
    const payload = await spendLogic.getTenantSpend(tenantName);
    res.json(payload);
  }
  catch (err)
  {
    if (err instanceof Error && err.message === "TENANT_NOT_FOUND")
    {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    throw err;
  }
}

/** Returns persisted or syncable LiteLLM key metadata for a tenant. */
export async function _GetLiteLlmKey(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const tenantName = Array.isArray(req.params.tenantName) ? req.params.tenantName[0] : req.params.tenantName;
  const tenant = await deps.prisma.tenant.findUnique({ where: { name: tenantName } });

  if (!tenant)
  {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const secret = await _readLiteLlmKeySecret(deps.coreApi, tenantName, deps.namespace);
  if (secret)
  {
    await _syncLiteLlmKeyMetadata(deps.prisma, tenantName, secret);
  }

  const key = await deps.prisma.tenantLiteLlmKey.findFirst({
    where: { tenant: tenantName },
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
  });

  if (!key)
  {
    res.status(404).json({ error: "LiteLLM key metadata not found" });
    return;
  }

  res.json({
    tenant: key.tenant,
    keyAlias: key.keyAlias,
    secretName: key.secretName,
    monthlyBudgetUsd: key.monthlyBudgetUsd !== null ? Number(key.monthlyBudgetUsd) : null,
    issuedAt: key.issuedAt.toISOString(),
    revokedAt: key.revokedAt?.toISOString() ?? null,
  });
}

/** Revokes the active LiteLLM key for a tenant by deleting the mounted Secret and auditing the action. */
export async function _RevokeLiteLlmKey(req: Request, res: Response, deps: AiBudgetLogicDeps): Promise<void>
{
  const tenantName = Array.isArray(req.params.tenantName) ? req.params.tenantName[0] : req.params.tenantName;
  const tenant = await deps.prisma.tenant.findUnique({ where: { name: tenantName } });

  if (!tenant)
  {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const secret = await _readLiteLlmKeySecret(deps.coreApi, tenantName, deps.namespace);
  if (secret)
  {
    await _syncLiteLlmKeyMetadata(deps.prisma, tenantName, secret);
  }

  // 1. Resolve the active key's alias so the upstream LiteLLM key can be deleted by alias. The
  //    Secret annotation is the freshest source; fall back to the persisted metadata row.
  const annotatedAlias = secret?.metadata?.annotations?.["opencrane.io/litellm-key-alias"];
  const activeKey = await deps.prisma.tenantLiteLlmKey.findFirst({
    where: { tenant: tenantName, revokedAt: null },
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
  });
  const keyAlias = annotatedAlias ?? activeKey?.keyAlias ?? null;

  // 2. Best-effort delete of the upstream LiteLLM virtual key. Non-fatal: a flaky/absent LiteLLM
  //    must not block local revocation (the mounted Secret delete below is what stops the pod from
  //    using the key). The outcome is recorded in the audit metadata for the change log.
  const litellmDeleteResult = await _deleteLiteLlmKey(keyAlias);

  // 3. Delete the mounted Secret so the tenant pod loses the key on its next mount/refresh.
  const secretName = _buildLiteLlmSecretName(tenantName);
  let secretDeleted = false;

  try
  {
    await deps.coreApi.deleteNamespacedSecret({ name: secretName, namespace: deps.namespace });
    secretDeleted = true;
    _log.info({ tenant: tenantName, secretName, namespace: deps.namespace }, "litellm key secret deleted");
  }
  catch (err)
  {
    // Absent secret is the common case (already revoked / never issued); log at debug so a real
    // RBAC/API failure is still visible without spamming on the benign 404.
    secretDeleted = false;
    _log.debug({ tenant: tenantName, secretName, namespace: deps.namespace, err }, "litellm key secret not deleted");
  }

  await deps.prisma.tenantLiteLlmKey.updateMany({
    where: { tenant: tenantName, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await deps.prisma.auditEntry.create({
    data: {
      tenant: tenantName,
      action: "LiteLLMKeyRevoked",
      resource: `Tenant/${tenantName}`,
      message: `LiteLLM key revoked for tenant ${tenantName}`,
      metadata: { secretDeleted, secretName, litellmKeyDeleted: litellmDeleteResult.deleted, litellmKeyAlias: keyAlias },
    },
  });

  res.json({ name: tenantName, status: "revoked", secretDeleted, litellmKeyDeleted: litellmDeleteResult.deleted });
}

/**
 * Best-effort deletion of a tenant's upstream LiteLLM virtual key via `POST /key/delete`
 * (master-key auth, from `LITELLM_ENDPOINT` + `LITELLM_MASTER_KEY`). Deletes by `key_aliases`
 * since OpenCrane never persists the raw key, only its alias.
 *
 * Returns `{ deleted: false }` — never throws — when LiteLLM is unconfigured, no alias is known,
 * or the call fails, so a revoke is never blocked on the upstream. Mirrors the resilient-fetch
 * posture used for model registration.
 *
 * @param keyAlias - The active key's alias, or null when none is known.
 * @returns `{ deleted: true }` only on a confirmed 2xx delete; `{ deleted: false }` otherwise.
 */
async function _deleteLiteLlmKey(keyAlias: string | null): Promise<{ deleted: boolean }>
{
  const endpoint = process.env.LITELLM_ENDPOINT?.trim() ?? "";
  const masterKey = process.env.LITELLM_MASTER_KEY?.trim() ?? "";

  // 1. Unconfigured or no alias to target → nothing to delete upstream.
  if (!endpoint || !masterKey || !keyAlias)
  {
    _log.debug(
      { endpointConfigured: Boolean(endpoint), masterKeyConfigured: Boolean(masterKey), keyAlias },
      "litellm key delete skipped (unconfigured or no alias)",
    );
    return { deleted: false };
  }

  try
  {
    // 2. Delete by alias — the raw key is never stored by OpenCrane, only the alias.
    const response = await fetch(`${endpoint}/key/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({ key_aliases: [keyAlias] }),
    });
    _log.info({ keyAlias, deleted: response.ok, status: response.status }, "litellm key delete attempted");
    return { deleted: response.ok };
  }
  catch (err)
  {
    // 3. Network / parse failure is non-fatal — the Secret delete still revokes access locally.
    _log.warn({ keyAlias, err }, "litellm key delete errored; relying on local secret delete");
    return { deleted: false };
  }
}

/** Build the canonical Secret name for a tenant LiteLLM key. */
function _buildLiteLlmSecretName(tenantName: string): string
{
  return `openclaw-${tenantName}-litellm-key`;
}

/** Read the tenant LiteLLM key Secret if it exists. */
async function _readLiteLlmKeySecret(coreApi: k8s.CoreV1Api, tenantName: string, namespace: string): Promise<k8s.V1Secret | null>
{
  try
  {
    const response = await coreApi.readNamespacedSecret({ name: _buildLiteLlmSecretName(tenantName), namespace });
    return response;
  }
  catch
  {
    return null;
  }
}

/** Sync Secret annotations into the TenantLiteLlmKey metadata table. */
async function _syncLiteLlmKeyMetadata(prisma: PrismaClient, tenantName: string, secret: k8s.V1Secret): Promise<void>
{
  const annotations = secret.metadata?.annotations ?? {};
  const keyAlias = annotations["opencrane.io/litellm-key-alias"];
  const issuedAtRaw = annotations["opencrane.io/litellm-issued-at"];
  const budgetRaw = annotations["opencrane.io/litellm-monthly-budget-usd"];
  const secretName = secret.metadata?.name;

  if (!keyAlias || !issuedAtRaw || !secretName)
  {
    return;
  }

  const issuedAt = new Date(issuedAtRaw);
  if (Number.isNaN(issuedAt.getTime()))
  {
    return;
  }

  const existing = await prisma.tenantLiteLlmKey.findFirst({
    where: {
      tenant: tenantName,
      keyAlias,
      secretName,
      issuedAt,
    },
  });

  if (existing)
  {
    return;
  }

  await prisma.tenantLiteLlmKey.create({
    data: {
      tenant: tenantName,
      keyAlias,
      secretName,
      issuedAt,
      monthlyBudgetUsd: budgetRaw !== undefined ? Number(budgetRaw) : undefined,
    },
  });
}
