import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

/**
 * Creates router for global provider API key management.
 * 
 * @param prisma - Prisma ORM client
 * @returns Configured Express router
 */
export function providerKeysRouter(prisma: PrismaClient): Router
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
    const keyValue = String(req.body.value ?? "").trim();

    if (!provider || !keyValue)
    {
      res.status(400).json({ error: "Provider and value are required" });
      return;
    }

    await prisma.providerApiKey.upsert({
      where: { provider },
      update: { keyValue },
      create: { provider, keyValue },
    });

    res.status(204).send();
  });

  /** Revokes provider key. */
  router.delete("/:provider", async function _deleteProviderKey(req, res)
  {
    const provider = String(req.params.provider ?? "").toLowerCase();

    if (!provider)
    {
      res.status(400).json({ error: "Provider is required" });
      return;
    }

    await prisma.providerApiKey.deleteMany({ where: { provider } });

    res.status(204).send();
  });

  return router;
}
