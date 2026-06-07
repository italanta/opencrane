import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { AuditEntry } from "../types.js";

/** Maximum entries per page. */
const MAX_LIMIT = 1000;

/**
 * Creates an Express router that queries the audit log from PostgreSQL.
 * Supports cursor-based keyset pagination via the `cursor` query parameter.
 * @param prisma - Prisma ORM client
 * @returns Configured Express Router
 */
export function auditRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Query audit log entries, optionally filtered by tenant, with cursor pagination. */
  router.get("/", async function _listAuditEntries(req, res)
  {
    const tenant = req.query.tenant as string | undefined;
    const rawLimit = Number(req.query.limit ?? "100");
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100, MAX_LIMIT);
    const cursor = req.query.cursor as string | undefined;

    // Decode the cursor (ISO timestamp) if provided.
    let cursorDate: Date | undefined;
    if (cursor)
    {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const ts = Date.parse(decoded);
      if (!Number.isNaN(ts))
      {
        cursorDate = new Date(ts);
      }
    }

    const entries = await prisma.auditEntry.findMany({
      where: {
        ...(tenant ? { tenant } : {}),
        ...(cursorDate ? { timestamp: { lt: cursorDate } } : {}),
      },
      orderBy: { timestamp: "desc" },
      // Fetch one extra to determine hasMore without a separate COUNT query.
      take: limit + 1,
    });

    const hasMore = entries.length > limit;
    const page = entries.slice(0, limit);

    const data: AuditEntry[] = page.map(function _mapEntry(e)
    {
      return {
        timestamp: e.timestamp.toISOString(),
        tenant: e.tenant ?? undefined,
        action: e.action,
        resource: e.resource,
        message: e.message,
      };
    });

    const lastEntry = page.at(-1);
    const nextCursor = hasMore && lastEntry
      ? Buffer.from(lastEntry.timestamp.toISOString(), "utf8").toString("base64url")
      : undefined;

    res.json({
      data,
      pagination: { limit, hasMore, ...(nextCursor ? { nextCursor } : {}) },
    });
  });

  return router;
}
