import type { RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";

/**
 * Creates a health-check handler that verifies database connectivity.
 * @param prisma - The PrismaClient instance to check
 * @returns Express handler for the `/healthz` endpoint
 */
export function _CheckDbHealth(prisma: PrismaClient): RequestHandler
{
  return async function _checkDbHealth(req, res)
  {
    try
    {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: "ok", db: true });
    }
    catch
    {
      res.status(503).json({ status: "degraded", db: false });
    }
  };
}