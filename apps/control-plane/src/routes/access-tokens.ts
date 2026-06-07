import { createHash, randomBytes } from "node:crypto";

import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

/**
 * Creates router for personal access token management.
 * @param prisma - Prisma ORM client
 * @returns Configured Express router
 */
export function accessTokensRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Lists all issued access tokens. */
  router.get("/", async function _getTokens(req, res)
  {
    const tokens = await prisma.accessToken.findMany({
      orderBy: { createdAt: "desc" },
    });

    res.json(tokens.map(function _mapToken(item)
    {
      return {
        id: item.id,
        name: item.name,
        owner: item.owner,
        createdAt: item.createdAt.toISOString(),
        expiresAt: item.expiresAt?.toISOString(),
        lastUsedAt: item.lastUsedAt?.toISOString(),
      };
    }));
  });

  /** Creates a new access token and returns the full token only once. */
  router.post("/", async function _createToken(req, res)
  {
    const name = String(req.body.name ?? "default").trim() || "default";
    const owner = String(req.body.owner ?? "unknown").trim() || "unknown";
    const rawExpiresAt = req.body.expiresAt ? String(req.body.expiresAt) : undefined;
    const expiresAt = rawExpiresAt ? new Date(rawExpiresAt) : null;
    const plainTextToken = `ocp_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(plainTextToken).digest("hex");

    const created = await prisma.accessToken.create({
      data: {
        name,
        owner,
        tokenHash,
        expiresAt,
      },
    });

    res.status(201).json({
      id: created.id,
      plainTextToken,
    });
  });

  /** Deletes an existing access token. */
  router.delete("/:id", async function _deleteToken(req, res)
  {
    const id = req.params.id;
    const existing = await prisma.accessToken.findUnique({ where: { id } });

    if (!existing)
    {
      res.status(404).json({ error: "Token not found", code: "TOKEN_NOT_FOUND" });
      return;
    }

    await prisma.accessToken.delete({ where: { id } });

    res.status(204).send();
  });

  return router;
}
