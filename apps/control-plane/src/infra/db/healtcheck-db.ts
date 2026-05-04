import express from "express";
import { PrismaClient } from "@prisma/client";

import { _CheckDbHealth } from "./db.js";

/**
 * Checks DB Health
 * 
 * @param res    - Response object to send the health status
 * @param prisma - DB connection
 */
export async function _healthCheck(_: any, res: express.Response, prisma: PrismaClient)
{
  const dbHealthy = await _CheckDbHealth(prisma);
  const status = dbHealthy ? "ok" : "degraded";
  const statusCode = dbHealthy ? 200 : 503;

  res.status(statusCode).json({ status, db: dbHealthy });
}