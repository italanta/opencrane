import { Router } from "express";
import type { ThirdPartySource, ThirdPartySourceItem } from "@opencrane/contracts";
import type { PrismaClient } from "@prisma/client";

import type { ThirdPartySourceWriteRequest } from "./third-party-sources.types.js";

/**
 * CRUD router for third-party source inventory and discovery results.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function thirdPartySourcesRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all configured third-party sources with discovered item counts. */
  router.get("/", async function _listThirdPartySources(req, res)
  {
    const sources = await (prisma as unknown as {
      thirdPartySource: {
        findMany: (args: { orderBy: { createdAt: "desc" }; include: { items: true } }) => Promise<Array<Record<string, unknown>>>;
      };
    }).thirdPartySource.findMany({
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });

    res.json(sources.map(function _mapSource(source)
    {
      return _MapThirdPartySource(source);
    }));
  });

  /** Get a single third-party source and its discovered items. */
  router.get("/:id", async function _getThirdPartySource(req, res)
  {
    const source = await (prisma as unknown as {
      thirdPartySource: {
        findUnique: (args: { where: { id: string }; include: { items: true } }) => Promise<Record<string, unknown> | null>;
      };
    }).thirdPartySource.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!source)
    {
      res.status(404).json({ error: "Third-party source not found", code: "THIRD_PARTY_SOURCE_NOT_FOUND" });
      return;
    }

    res.json(_MapThirdPartySource(source));
  });

  /** Create a new third-party source and its discovered item inventory. */
  router.post("/", async function _createThirdPartySource(req, res)
  {
    const body = req.body as ThirdPartySourceWriteRequest;
    const createdSource = await (prisma as unknown as {
      thirdPartySource: {
        create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; name: string }>;
      };
      thirdPartySourceItem: {
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).thirdPartySource.create({
      data: {
        name: body.name,
        kind: body.kind,
        status: body.status ?? "pending-approval",
        originUrl: body.originUrl,
        syncMode: body.syncMode,
        ...(body.lastSyncedAt ? { lastSyncedAt: new Date(body.lastSyncedAt) } : {}),
        ...(body.nextRunAt ? { nextRunAt: new Date(body.nextRunAt) } : {}),
        ...(body.notes ? { notes: body.notes } : {}),
      },
    });

    if (body.items && body.items.length > 0)
    {
      await (prisma as unknown as {
        thirdPartySourceItem: {
          createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
        };
      }).thirdPartySourceItem.createMany({
        data: body.items.map(function _mapItem(item)
        {
          return {
            sourceId: createdSource.id,
            kind: item.kind,
            name: item.name,
            upstreamId: item.upstreamId,
            version: item.version,
            digest: item.digest,
            metadata: item.metadata,
          };
        }),
      });
    }

    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Created",
        resource: `ThirdPartySource/${createdSource.id}`,
        message: `Third-party source ${createdSource.name} created`,
      },
    });

    res.status(201).json({ id: createdSource.id, status: "created" });
  });

  /** Update a third-party source and fully replace its discovered item inventory. */
  router.put("/:id", async function _updateThirdPartySource(req, res)
  {
    const body = req.body as Partial<ThirdPartySourceWriteRequest>;
    await (prisma as unknown as {
      thirdPartySource: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
      thirdPartySourceItem: {
        deleteMany: (args: { where: { sourceId: string } }) => Promise<unknown>;
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).thirdPartySource.update({
      where: { id: req.params.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.originUrl ? { originUrl: body.originUrl } : {}),
        ...(body.syncMode ? { syncMode: body.syncMode } : {}),
        ...(body.lastSyncedAt !== undefined ? { lastSyncedAt: body.lastSyncedAt ? new Date(body.lastSyncedAt) : null } : {}),
        ...(body.nextRunAt !== undefined ? { nextRunAt: body.nextRunAt ? new Date(body.nextRunAt) : null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
    });

    await (prisma as unknown as {
      thirdPartySourceItem: {
        deleteMany: (args: { where: { sourceId: string } }) => Promise<unknown>;
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
    }).thirdPartySourceItem.deleteMany({ where: { sourceId: req.params.id } });

    if (body.items && body.items.length > 0)
    {
      await (prisma as unknown as {
        thirdPartySourceItem: {
          createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
        };
      }).thirdPartySourceItem.createMany({
        data: body.items.map(function _mapItem(item)
        {
          return {
            sourceId: req.params.id,
            kind: item.kind,
            name: item.name,
            upstreamId: item.upstreamId,
            version: item.version,
            digest: item.digest,
            metadata: item.metadata,
          };
        }),
      });
    }

    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Updated",
        resource: `ThirdPartySource/${req.params.id}`,
        message: `Third-party source ${req.params.id} updated`,
      },
    });

    res.json({ id: req.params.id, status: "updated" });
  });

  /** Delete a third-party source and its discovered items. */
  router.delete("/:id", async function _deleteThirdPartySource(req, res)
  {
    await (prisma as unknown as {
      thirdPartySourceItem: { deleteMany: (args: { where: { sourceId: string } }) => Promise<unknown> };
      thirdPartySource: { delete: (args: { where: { id: string } }) => Promise<unknown> };
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).thirdPartySourceItem.deleteMany({ where: { sourceId: req.params.id } });
    await (prisma as unknown as {
      thirdPartySource: { delete: (args: { where: { id: string } }) => Promise<unknown> };
    }).thirdPartySource.delete({ where: { id: req.params.id } });
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Deleted",
        resource: `ThirdPartySource/${req.params.id}`,
        message: `Third-party source ${req.params.id} deleted`,
      },
    });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}

/**
 * Map a raw third-party source record to the UI response shape.
 *
 * @param source - Raw persisted source record.
 * @returns JSON response payload.
 */
function _MapThirdPartySource(source: Record<string, unknown>): ThirdPartySource
{
  const items = Array.isArray(source.items) ? source.items as Array<Record<string, unknown>> : [];

  return {
    id: String(source.id),
    name: String(source.name),
    kind: String(source.kind).replace("McpRegistry", "mcp-registry").replace("AnthropicSkills", "anthropic-skills").replace("GitRepository", "git-repository").replace("ManualUpload", "manual-upload").toLowerCase() as ThirdPartySource["kind"],
    status: String(source.status).replace("PendingApproval", "pending-approval").toLowerCase() as ThirdPartySource["status"],
    originUrl: String(source.originUrl),
    syncMode: String(source.syncMode) as ThirdPartySource["syncMode"],
    managedItemCount: items.length,
    lastSyncedAt: source.lastSyncedAt instanceof Date ? source.lastSyncedAt.toISOString() : undefined,
    nextRunAt: source.nextRunAt instanceof Date ? source.nextRunAt.toISOString() : undefined,
    notes: typeof source.notes === "string" ? source.notes : undefined,
    items: items.map(function _mapItem(item): ThirdPartySourceItem
    {
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        kind: String(item.kind).replace("McpServer", "mcp-server").replace("SkillBundle", "skill-bundle").toLowerCase() as ThirdPartySourceItem["kind"],
        name: String(item.name),
        upstreamId: String(item.upstreamId),
        version: typeof item.version === "string" ? item.version : undefined,
        digest: typeof item.digest === "string" ? item.digest : undefined,
        metadata: typeof item.metadata === "object" && item.metadata !== null ? item.metadata as Record<string, unknown> : undefined,
      };
    }),
  };
}
