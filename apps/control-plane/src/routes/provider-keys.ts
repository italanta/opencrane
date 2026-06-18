import { Router } from "express";
import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

/**
 * Creates router for global provider API key management.
 * 
 * @param prisma - Prisma ORM client
 * @param coreApi - Kubernetes Core V1 API for org secret projection
 * @param namespace - Namespace where the shared org Secret lives
 * @param orgSecretName - Name of the shared org Secret
 * @returns Configured Express router
 */
export function providerKeysRouter(prisma: PrismaClient, coreApi: k8s.CoreV1Api, namespace: string, orgSecretName: string): Router
{
  const router = Router();

  /** Lists provider key status for supported providers. */
  router.get("/", async function _getProviderKeys(req, res)
  {
    const configuredKeys = await prisma.providerApiKey.findMany({ orderBy: { provider: "asc" } });
    const byProvider = new Map(configuredKeys.map(function _mapByProvider(item)
    {
      return [item.provider, item];
    }));

    const providers = ["openai", "claude"] as const;

    res.json(providers.map(function _mapProvider(provider)
    {
      const item = byProvider.get(provider);

      return {
        provider,
        configured: Boolean(item),
        maskedValue: item ? `${item.keyValue.slice(0, 6)}...${item.keyValue.slice(-4)}` : undefined,
        updatedAt: item?.updatedAt.toISOString(),
      };
    }));
  });

  /** Creates or updates provider key by provider name. */
  router.put("/:provider", async function _putProviderKey(req, res)
  {
    const provider = String(req.params.provider ?? "").toLowerCase();
    const keyValue = String(req.body.apiKey ?? "").trim();

    if (!provider || !keyValue)
    {
      res.status(400).json({ error: "Provider and value are required", code: "VALIDATION_ERROR" });
      return;
    }

    await prisma.providerApiKey.upsert({
      where: { provider },
      update: { keyValue },
      create: { provider, keyValue },
    });

    await _upsertOrgProviderSecret(coreApi, namespace, orgSecretName, provider, keyValue);

    res.status(204).send();
  });

  /** Revokes provider key. */
  router.delete("/:provider", async function _deleteProviderKey(req, res)
  {
    const provider = String(req.params.provider ?? "").toLowerCase();

    if (!provider)
    {
      res.status(400).json({ error: "Provider is required", code: "VALIDATION_ERROR" });
      return;
    }

    await prisma.providerApiKey.deleteMany({ where: { provider } });
    await _deleteOrgProviderSecretKey(coreApi, namespace, orgSecretName, provider);

    res.status(204).send();
  });

  return router;
}

/** Map provider name to the org-shared secret key used by tenant envFrom. */
function _providerToSecretKey(provider: string): string
{
  if (provider === "openai")
  {
    return "OPENAI_API_KEY";
  }

  if (provider === "claude")
  {
    return "ANTHROPIC_API_KEY";
  }

  return provider.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Build a plain-text map from Secret data (base64) so keys can be merged safely. */
function _decodeSecretData(secret: k8s.V1Secret): Record<string, string>
{
  const decoded: Record<string, string> = {};
  const data = secret.data ?? {};

  for (const [key, value] of Object.entries(data))
  {
    decoded[key] = Buffer.from(value, "base64").toString("utf8");
  }

  return decoded;
}

/** Returns true when the Kubernetes error indicates a missing resource (HTTP 404). */
function _isNotFoundError(err: unknown): boolean
{
  if (!(err instanceof Error))
  {
    return false;
  }

  const maybeStatus = err as Error & { code?: number; statusCode?: number; body?: { code?: number } | string };
  if (maybeStatus.statusCode === 404 || maybeStatus.code === 404)
  {
    return true;
  }

  if (typeof maybeStatus.body === "object" && maybeStatus.body?.code === 404)
  {
    return true;
  }

  if (typeof maybeStatus.body === "string")
  {
    try
    {
      const parsedBody = JSON.parse(maybeStatus.body) as { code?: number };
      return parsedBody.code === 404;
    }
    catch
    {
      return false;
    }
  }

  return false;
}

/**
 * Upsert the shared org Secret entry for a provider key.
 */
async function _upsertOrgProviderSecret(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  secretName: string,
  provider: string,
  keyValue: string,
): Promise<void>
{
  const secretKey = _providerToSecretKey(provider);

  try
  {
    // 1. Read the existing Secret so we can preserve unrelated provider keys.
    const existing = await coreApi.readNamespacedSecret({ name: secretName, namespace });
    const mergedData = _decodeSecretData(existing);
    mergedData[secretKey] = keyValue;

    // 2. Replace the Secret with merged keys so updates remain atomic per write.
    await coreApi.replaceNamespacedSecret({
      name: secretName,
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: existing.type ?? "Opaque",
        metadata: {
          name: secretName,
          namespace,
          resourceVersion: existing.metadata?.resourceVersion,
          labels: existing.metadata?.labels,
          annotations: existing.metadata?.annotations,
        },
        stringData: mergedData,
      },
    });
  }
  catch (err)
  {
    if (!_isNotFoundError(err))
    {
      throw err;
    }

    // 3. Create the Secret on first write so control-plane ownership is explicit.
    await coreApi.createNamespacedSecret({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: secretName,
          namespace,
        },
        stringData: {
          [secretKey]: keyValue,
        },
      },
    });
  }
}

/**
 * Remove a provider key from the shared org Secret without deleting other keys.
 */
async function _deleteOrgProviderSecretKey(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  secretName: string,
  provider: string,
): Promise<void>
{
  const secretKey = _providerToSecretKey(provider);

  try
  {
    // 1. Read the existing Secret and decode all keys to preserve unrelated entries.
    const existing = await coreApi.readNamespacedSecret({ name: secretName, namespace });
    const mergedData = _decodeSecretData(existing);

    // 2. Remove only this provider key so other provider credentials remain available.
    delete mergedData[secretKey];

    // 3. Replace the Secret with the reduced key set.
    await coreApi.replaceNamespacedSecret({
      name: secretName,
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: existing.type ?? "Opaque",
        metadata: {
          name: secretName,
          namespace,
          resourceVersion: existing.metadata?.resourceVersion,
          labels: existing.metadata?.labels,
          annotations: existing.metadata?.annotations,
        },
        stringData: mergedData,
      },
    });
  }
  catch (err)
  {
    if (!_isNotFoundError(err))
    {
      throw err;
    }
  }
}

