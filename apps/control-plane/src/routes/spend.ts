import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { SpendLogic } from "../core/spend/spend.logic.js";

/**
 * Router for tenant spend summaries at /api/spend/:tenantName.
 */
export function spendRouter(prisma: PrismaClient): Router
{
  const router = Router();
  const spendLogic = new SpendLogic(prisma);

  // 1. Entry point — this route serves the dedicated spend endpoint.
  //    It intentionally keeps HTTP concerns here and forwards domain logic to core/spend.
  /** Returns a tenant spend summary sourced from LiteLLM usage APIs. */
  router.get("/:tenantName", async function _getTenantSpend(req, res)
  {
    // 2. Validation guard — fail fast for missing master key so callers get an actionable response.
    const masterKey = process.env.LITELLM_MASTER_KEY ?? "";
    if (!masterKey)
    {
      res.status(503).json({ error: "LITELLM_MASTER_KEY is not configured" });
      return;
    }

    // 3. Domain resolution — core spend logic handles LiteLLM fetch + local fallback behavior.
    const tenantName = req.params.tenantName;

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
  });

  return router;
}