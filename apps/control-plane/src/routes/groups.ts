import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { GroupGrantInput, GroupWriteRequest } from "./groups.types.js";

/**
 * CRUD router for Phase 4 groups and awareness-linked grants.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function groupsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all groups with member counts and attached awareness grants. */
  router.get("/", async function _listGroups(req, res)
  {
    const groups = await (prisma as unknown as {
      group: {
        findMany: (args: { orderBy: { createdAt: "desc" }; include: { grants: true } }) => Promise<Array<{
          id: string;
          name: string;
          scope: string;
          description: string | null;
          members: unknown;
          grants: Array<{ id: string; scope: string; subjectType: string; subjectId: string; access: string; note: string | null }>;
        }>>;
      };
    }).group.findMany({
      orderBy: { createdAt: "desc" },
      include: { grants: true },
    });

    res.json(groups.map(function _mapGroup(group)
    {
      return {
        id: group.id,
        name: group.name,
        scope: _NormalizeScope(group.scope),
        description: group.description ?? undefined,
        members: _NormalizeMembers(group.members),
        memberCount: _NormalizeMembers(group.members).length,
        grants: group.grants.map(function _mapGrant(grant)
        {
          return _MapGrantResponse(grant);
        }),
      };
    }));
  });

  /** Get a single group by identifier. */
  router.get("/:id", async function _getGroup(req, res)
  {
    const group = await (prisma as unknown as {
      group: {
        findUnique: (args: { where: { id: string }; include: { grants: true } }) => Promise<{
          id: string;
          name: string;
          scope: string;
          description: string | null;
          members: unknown;
          grants: Array<{ id: string; scope: string; subjectType: string; subjectId: string; access: string; note: string | null }>;
        } | null>;
      };
    }).group.findUnique({
      where: { id: req.params.id },
      include: { grants: true },
    });

    if (!group)
    {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    const members = _NormalizeMembers(group.members);
    res.json({
      id: group.id,
      name: group.name,
      scope: _NormalizeScope(group.scope),
      description: group.description ?? undefined,
      members,
      memberCount: members.length,
      grants: group.grants.map(function _mapGrant(grant)
      {
        return _MapGrantResponse(grant);
      }),
    });
  });

  /** Create a new group and optional awareness grants. */
  router.post("/", async function _createGroup(req, res)
  {
    const body = req.body as GroupWriteRequest;
    const members = _NormalizeMembers(body.members);
    const createdGroup = await (prisma as unknown as {
      group: {
        create: (args: { data: { name: string; scope: string; description?: string; members: string[] } }) => Promise<{
          id: string;
          name: string;
          scope: string;
          description: string | null;
          members: unknown;
        }>;
      };
      grant: {
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).group.create({
      data: {
        name: body.name,
        scope: body.scope,
        ...(body.description ? { description: body.description } : {}),
        members,
      },
    });

    if (body.grants && body.grants.length > 0)
    {
      await (prisma as unknown as {
        grant: {
          createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
        };
      }).grant.createMany({
        data: body.grants.map(function _mapGrant(grant)
        {
          return {
            payloadType: "awareness",
            payloadId: grant.payloadId ?? "awareness/default",
            scope: grant.scope,
            subjectType: grant.subjectType,
            subjectId: _ResolveGrantSubjectId(grant),
            access: grant.access,
            priority: grant.priority ?? 0,
            note: grant.note,
            groupId: createdGroup.id,
          };
        }),
      });
    }

    await (prisma as unknown as {
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).auditEntry.create({
      data: {
        action: "Created",
        resource: `Group/${createdGroup.id}`,
        message: `Group ${createdGroup.name} created`,
      },
    });

    res.status(201).json({ id: createdGroup.id, status: "created" });
  });

  /** Update a group and fully replace attached awareness grants. */
  router.put("/:id", async function _updateGroup(req, res)
  {
    const body = req.body as Partial<GroupWriteRequest>;
    const members = body.members ? _NormalizeMembers(body.members) : undefined;

    await (prisma as unknown as {
      group: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
      grant: {
        deleteMany: (args: { where: { groupId: string; payloadType: "awareness" } }) => Promise<unknown>;
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).group.update({
      where: { id: req.params.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(members ? { members } : {}),
      },
    });

    await (prisma as unknown as {
      grant: {
        deleteMany: (args: { where: { groupId: string; payloadType: "awareness" } }) => Promise<unknown>;
        createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
      };
    }).grant.deleteMany({
      where: { groupId: req.params.id, payloadType: "awareness" },
    });

    if (body.grants && body.grants.length > 0)
    {
      await (prisma as unknown as {
        grant: {
          createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
        };
      }).grant.createMany({
        data: body.grants.map(function _mapGrant(grant)
        {
          return {
            payloadType: "awareness",
            payloadId: grant.payloadId ?? "awareness/default",
            scope: grant.scope,
            subjectType: grant.subjectType,
            subjectId: _ResolveGrantSubjectId(grant),
            access: grant.access,
            priority: grant.priority ?? 0,
            note: grant.note,
            groupId: req.params.id,
          };
        }),
      });
    }

    await (prisma as unknown as {
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).auditEntry.create({
      data: {
        action: "Updated",
        resource: `Group/${req.params.id}`,
        message: `Group ${req.params.id} updated`,
      },
    });

    res.json({ id: req.params.id, status: "updated" });
  });

  /** Delete a group and any awareness grants linked to it. */
  router.delete("/:id", async function _deleteGroup(req, res)
  {
    await (prisma as unknown as {
      grant: {
        deleteMany: (args: { where: { groupId: string; payloadType: "awareness" } }) => Promise<unknown>;
      };
      group: {
        delete: (args: { where: { id: string } }) => Promise<unknown>;
      };
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).grant.deleteMany({
      where: { groupId: req.params.id, payloadType: "awareness" },
    });
    await (prisma as unknown as {
      group: {
        delete: (args: { where: { id: string } }) => Promise<unknown>;
      };
    }).group.delete({ where: { id: req.params.id } });
    await (prisma as unknown as {
      auditEntry: {
        create: (args: { data: { action: string; resource: string; message: string } }) => Promise<unknown>;
      };
    }).auditEntry.create({
      data: {
        action: "Deleted",
        resource: `Group/${req.params.id}`,
        message: `Group ${req.params.id} deleted`,
      },
    });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}

/**
 * Normalize raw membership JSON into a unique string array.
 *
 * @param members - Raw request or database membership value.
 * @returns Normalized principal identifier list.
 */
function _NormalizeMembers(members: unknown): string[]
{
  if (!Array.isArray(members))
  {
    return [];
  }

  const normalizedMembers = members.map(function _mapMember(member)
  {
    return typeof member === "string" ? member.trim() : "";
  }).filter(function _isNonEmpty(member)
  {
    return member.length > 0;
  });

  return Array.from(new Set(normalizedMembers)).sort();
}

/**
 * Normalize Prisma enum casing for JSON responses.
 *
 * @param scope - Raw scope string from persistence.
 * @returns Lowercase route scope.
 */
function _NormalizeScope(scope: string): string
{
  return scope.toLowerCase();
}

/**
 * Map a persisted grant into the UI-friendly response shape.
 *
 * @param grant - Raw persisted grant record.
 * @returns JSON response grant payload.
 */
function _MapGrantResponse(grant: { id: string; scope: string; subjectType: string; subjectId: string; access: string; note: string | null }): Record<string, unknown>
{
  return {
    id: grant.id,
    scope: grant.scope.toLowerCase(),
    subjectType: grant.subjectType.toLowerCase(),
    subjectId: grant.subjectId,
    subjectName: grant.subjectId,
    access: grant.access.toLowerCase(),
    ...(grant.note ? { note: grant.note } : {}),
  };
}

/**
 * Resolve the compiler-facing subject identifier from route input.
 *
 * @param grant - Raw route grant payload.
 * @returns Stable subject identifier.
 */
function _ResolveGrantSubjectId(grant: GroupGrantInput): string
{
  return grant.subjectId ?? grant.subjectName;
}
