import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

/**
 * Obot /v0.1/servers registry format — the shape Obot consumes when polling
 * OBOT_SERVER_PROVIDER_REGISTRIES to sync the MCP server catalog.
 */
interface ObotRegistryItem
{
  id: string;
  name: string;
  description: string;
  remotes?: Array<{ name: string; url: string }>;
  configurationRequired?: boolean;
  configurationMessage?: string;
}

interface ObotRegistryResponse
{
  items: ObotRegistryItem[];
  cursor: string | null;
}

/**
 * Internal router that exposes the OpenCrane MCP catalog in Obot's
 * /v0.1/servers registry format.
 *
 * Obot is configured via OBOT_SERVER_PROVIDER_REGISTRIES to poll this endpoint
 * and sync the McpServer rows from the control-plane database into its own registry.
 *
 * This route is NOT behind the bearer-token auth middleware — it is internal-only,
 * protected by Kubernetes NetworkPolicy (reachable only from the Obot pod).
 *
 * @param prisma - Prisma client for database access.
 * @returns Configured Express router.
 */
export function obotRegistryRouter(prisma: PrismaClient): Router
{
  const router = Router();

  router.get("/v0.1/servers", async function _listObotServers(req, res)
  {
    const servers = await prisma.mcpServer.findMany({
      where: { status: "Active" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        endpoint: true,
        transport: true,
      },
    });

    const items: ObotRegistryItem[] = servers.map(function _mapServer(server)
    {
      return {
        id: server.id,
        name: server.name,
        description: server.description,
        remotes: [{ name: server.name, url: server.endpoint }],
      };
    });

    const response: ObotRegistryResponse = { items, cursor: null };
    res.json(response);
  });

  return router;
}
