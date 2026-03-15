import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { AuditEntry } from "../types.js";

/**
 * Creates an Express router that queries the audit log from PostgreSQL.
 * Replaces the previous K8s Events-based approach with a Prisma-backed store.
 * @param prisma - Prisma ORM client
 * @returns Configured Express Router
 */
export function auditRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Query audit log entries, optionally filtered by tenant. */
  router.get("/", async function _listAuditEntries(req, res)
  {
    const tenant = req.query.tenant as string | undefined;
    const limit = Number(req.query.limit ?? "100");

    const entries = await prisma.auditEntry.findMany({
      where: tenant ? { tenant } : undefined,
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    const response: AuditEntry[] = entries.map(function _mapEntry(e)
    {
      return {
        timestamp: e.timestamp.toISOString(),
        tenant: e.tenant ?? undefined,
        action: e.action,
        resource: e.resource,
        message: e.message,
      };
    });

    res.json(response);
  });

  return router;
}
