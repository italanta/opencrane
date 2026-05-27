import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { McpServerGrantInput, McpServerWriteRequest } from "./mcp-servers.types.js";

/**
 * CRUD router for the Phase 4 MCP server catalog.
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
    const servers = await (prisma as unknown as {
      mcpServer: {
        findMany: (args: { orderBy: { createdAt: "desc" }; include: { scopedGrants: true; credentials: true; source: true } }) => Promise<Array<Record<string, unknown>>>;
      };
    }).mcpServer.findMany({
      orderBy: { createdAt: "desc" },
      include: { scopedGrants: true, credentials: true, source: true },
    });

    res.json(servers.map(function _mapServer(server)
    {
      return _MapMcpServer(server);
    }));
  });

  /** Get a single MCP server by identifier. */
  router.get("/:id", async function _getMcpServer(req, res)
  {
    const server = await (prisma as unknown as {
      mcpServer: {
        findUnique: (args: { where: { id: string }; include: { scopedGrants: true; credentials: true; source: true } }) => Promise<Record<string, unknown> | null>;
      };
    }).mcpServer.findUnique({
      where: { id: req.params.id },
      include: { scopedGrants: true, credentials: true, source: true },
    });

    if (!server)
    {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    res.json(_MapMcpServer(server));
  });

  /** Create a new MCP server plus generic grant rows for the compiler. */
  router.post("/", async function _createMcpServer(req, res)
  {
    const body = req.body as McpServerWriteRequest;
    const createdServer = await (prisma as unknown as {
      mcpServer: {
        create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; name: string }>;
      };
      mcpServerCredential: {
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      grant: {
        create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
      };
      mcpServerGrant: {
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).mcpServer.create({
      data: {
        name: body.name,
        description: body.description ?? "",
        endpoint: body.endpoint,
        scope: body.scope,
        transport: body.transport,
        status: body.status ?? "draft",
        capabilities: _NormalizeStringArray(body.capabilities),
        ...(body.sourceId ? { sourceId: body.sourceId } : {}),
        ...(body.lastSyncedAt ? { lastSyncedAt: new Date(body.lastSyncedAt) } : {}),
      },
    });

    await _WriteMcpServerChildren(prisma, createdServer.id, body);
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Created",
        resource: `McpServer/${createdServer.id}`,
        message: `MCP server ${createdServer.name} created`,
      },
    });

    res.status(201).json({ id: createdServer.id, status: "created" });
  });

  /** Update an MCP server and fully replace grants/credentials. */
  router.put("/:id", async function _updateMcpServer(req, res)
  {
    const body = req.body as Partial<McpServerWriteRequest>;
    await (prisma as unknown as {
      mcpServer: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
      mcpServerGrant: {
        deleteMany: (args: { where: { mcpServerId: string } }) => Promise<unknown>;
      };
      mcpServerCredential: {
        deleteMany: (args: { where: { mcpServerId: string } }) => Promise<unknown>;
      };
      grant: {
        deleteMany: (args: { where: { mcpServerId: string; payloadType: "mcp-server" } }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).mcpServer.update({
      where: { id: req.params.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? "" } : {}),
        ...(body.endpoint ? { endpoint: body.endpoint } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.transport ? { transport: body.transport } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.capabilities ? { capabilities: _NormalizeStringArray(body.capabilities) } : {}),
        ...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
        ...(body.lastSyncedAt !== undefined ? { lastSyncedAt: body.lastSyncedAt ? new Date(body.lastSyncedAt) : null } : {}),
      },
    });

    await _DeleteMcpServerChildren(prisma, req.params.id);
    await _WriteMcpServerChildren(prisma, req.params.id, body);
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Updated",
        resource: `McpServer/${req.params.id}`,
        message: `MCP server ${req.params.id} updated`,
      },
    });

    res.json({ id: req.params.id, status: "updated" });
  });

  /** Delete an MCP server and its linked grant rows. */
  router.delete("/:id", async function _deleteMcpServer(req, res)
  {
    await _DeleteMcpServerChildren(prisma, req.params.id);
    await (prisma as unknown as {
      mcpServer: { delete: (args: { where: { id: string } }) => Promise<unknown> };
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).mcpServer.delete({ where: { id: req.params.id } });
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Deleted",
        resource: `McpServer/${req.params.id}`,
        message: `MCP server ${req.params.id} deleted`,
      },
    });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}

/**
 * Write child credentials and grant rows for an MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - MCP server identifier.
 * @param body - Route payload containing grants and credentials.
 */
async function _WriteMcpServerChildren(prisma: PrismaClient, serverId: string, body: Partial<McpServerWriteRequest>): Promise<void>
{
  if (body.credentials && body.credentials.length > 0)
  {
    await (prisma as unknown as {
      mcpServerCredential: { createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown> };
    }).mcpServerCredential.createMany({
      data: body.credentials.map(function _mapCredential(credential)
      {
        return {
          mcpServerId: serverId,
          displayName: credential.displayName,
          secretRef: credential.secretRef,
        };
      }),
    });
  }

  if (!body.grants || body.grants.length === 0)
  {
    return;
  }

  const scopedGrantRows: Array<Record<string, unknown>> = [];
  for (const grant of body.grants)
  {
    const genericGrant = await (prisma as unknown as {
      grant: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
    }).grant.create({
      data: {
        payloadType: "mcp-server",
        payloadId: serverId,
        scope: grant.scope,
        subjectType: grant.subjectType,
        subjectId: _ResolveGrantSubjectId(grant),
        access: grant.access,
        priority: grant.priority ?? 0,
        note: grant.note,
        ...(grant.subjectType === "group" ? { groupId: _ResolveGrantSubjectId(grant) } : {}),
        mcpServerId: serverId,
      },
    });
    scopedGrantRows.push({
      mcpServerId: serverId,
      grantId: genericGrant.id,
      scope: grant.scope,
      subjectType: grant.subjectType,
      subjectId: _ResolveGrantSubjectId(grant),
      access: grant.access,
      priority: grant.priority ?? 0,
      note: grant.note,
      ...(grant.subjectType === "group" ? { groupId: _ResolveGrantSubjectId(grant) } : {}),
    });
  }

  await (prisma as unknown as {
    mcpServerGrant: { createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown> };
  }).mcpServerGrant.createMany({ data: scopedGrantRows });
}

/**
 * Delete child credentials and grant rows for an MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - MCP server identifier.
 */
async function _DeleteMcpServerChildren(prisma: PrismaClient, serverId: string): Promise<void>
{
  await (prisma as unknown as {
    mcpServerGrant: { deleteMany: (args: { where: { mcpServerId: string } }) => Promise<unknown> };
    mcpServerCredential: { deleteMany: (args: { where: { mcpServerId: string } }) => Promise<unknown> };
    grant: { deleteMany: (args: { where: { mcpServerId: string; payloadType: "mcp-server" } }) => Promise<unknown> };
  }).mcpServerGrant.deleteMany({ where: { mcpServerId: serverId } });
  await (prisma as unknown as {
    mcpServerCredential: { deleteMany: (args: { where: { mcpServerId: string } }) => Promise<unknown> };
  }).mcpServerCredential.deleteMany({ where: { mcpServerId: serverId } });
  await (prisma as unknown as {
    grant: { deleteMany: (args: { where: { mcpServerId: string; payloadType: "mcp-server" } }) => Promise<unknown> };
  }).grant.deleteMany({ where: { mcpServerId: serverId, payloadType: "mcp-server" } });
}

/**
 * Map a raw MCP server record to the UI response shape.
 *
 * @param server - Raw persisted server record.
 * @returns JSON response payload.
 */
function _MapMcpServer(server: Record<string, unknown>): Record<string, unknown>
{
  const source = server.source as { name?: string } | null | undefined;
  const scopedGrants = Array.isArray(server.scopedGrants) ? server.scopedGrants as Array<Record<string, unknown>> : [];
  const credentials = Array.isArray(server.credentials) ? server.credentials as Array<Record<string, unknown>> : [];

  return {
    id: server.id,
    name: server.name,
    description: server.description,
    endpoint: server.endpoint,
    scope: String(server.scope).toLowerCase(),
    transport: String(server.transport).replace("ServerSentEvents", "sse").replace("StreamableHttp", "streamable-http").replace("WebSocket", "websocket").toLowerCase(),
    status: String(server.status).toLowerCase(),
    capabilities: Array.isArray(server.capabilities) ? server.capabilities : [],
    sourceName: source?.name,
    lastSyncedAt: server.lastSyncedAt instanceof Date ? server.lastSyncedAt.toISOString() : undefined,
    grants: scopedGrants.map(function _mapGrant(grant)
    {
      return {
        id: grant.id,
        scope: String(grant.scope).toLowerCase(),
        subjectType: String(grant.subjectType).toLowerCase(),
        subjectId: grant.subjectId,
        subjectName: grant.subjectId,
        access: String(grant.access).toLowerCase(),
        note: grant.note ?? undefined,
      };
    }),
    credentials: credentials.map(function _mapCredential(credential)
    {
      return {
        id: credential.id,
        displayName: credential.displayName,
        secretRef: credential.secretRef,
      };
    }),
  };
}

/**
 * Normalize capability labels into a unique trimmed string array.
 *
 * @param values - Raw request values.
 * @returns Normalized string array.
 */
function _NormalizeStringArray(values: string[] | undefined): string[]
{
  if (!values)
  {
    return [];
  }

  return Array.from(new Set(values.map(function _trim(value)
  {
    return value.trim();
  }).filter(function _isNonEmpty(value)
  {
    return value.length > 0;
  })));
}

/**
 * Resolve the compiler-facing subject identifier from route input.
 *
 * @param grant - Raw grant payload.
 * @returns Stable subject identifier.
 */
function _ResolveGrantSubjectId(grant: McpServerGrantInput): string
{
  return grant.subjectId ?? grant.subjectName;
}
