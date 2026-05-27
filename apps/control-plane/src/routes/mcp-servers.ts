import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, updateMcpServer } from "../features/mcp-servers/mcp-servers.logic.js";
import type { McpServerWriteRequest } from "./mcp-servers.types.js";

/**
 * CRUD router for the MCP server catalog.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function mcpServersRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all MCP servers with grants and credentials. */
  router.get("/", async function _listMcpServers(req, res)
  {
    res.json(await listMcpServers(prisma));
  });

  /** Get a single MCP server by identifier. */
  router.get("/:id", async function _getMcpServer(req, res)
  {
    const server = await getMcpServer(prisma, req.params.id);
    if (!server)
    {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    res.json(server);
  });

  /** Create a new MCP server plus generic grant rows for the compiler. */
  router.post("/", async function _createMcpServer(req, res)
  {
    const body = req.body as McpServerWriteRequest;
    res.status(201).json(await createMcpServer(prisma, body));
  });

  /** Update an MCP server and fully replace grants and credentials. */
  router.put("/:id", async function _updateMcpServer(req, res)
  {
    const body = req.body as Partial<McpServerWriteRequest>;
    res.json(await updateMcpServer(prisma, req.params.id, body));
  });

  /** Delete an MCP server and its linked grant rows. */
  router.delete("/:id", async function _deleteMcpServer(req, res)
  {
    res.json(await deleteMcpServer(prisma, req.params.id));
  });

  return router;
}
