import { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

/**
 * Creates and returns a configured PrismaClient instance.
 * @param log - Logger for query and error output
 * @returns A connected PrismaClient
 */
export function createPrismaClient(log: Logger): PrismaClient
{
  const prisma = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });

  prisma.$on("error", (e) => {
    log.error({ message: e.message, target: e.target }, "prisma error");
  });

  prisma.$on("warn", (e) => {
    log.warn({ message: e.message, target: e.target }, "prisma warning");
  });

  return prisma;
}

/**
 * Checks database connectivity by running a trivial query.
 * @param prisma - The PrismaClient instance to check
 * @returns True if the database is reachable
 */
export async function checkDbHealth(prisma: PrismaClient): Promise<boolean>
{
  try
  {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  }
  catch
  {
    return false;
  }
}
