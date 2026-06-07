import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { createGroup, deleteGroup, getGroup, listGroups, updateGroup } from "../features/groups/groups.logic.js";
import type { GroupWriteRequest } from "./groups.types.js";

/**
 * CRUD router for domain access groups and awareness-linked grants.
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
    res.json(await listGroups(prisma));
  });

  /** Get a single group by identifier. */
  router.get("/:id", async function _getGroup(req, res)
  {
    const group = await getGroup(prisma, req.params.id);
    if (!group)
    {
      res.status(404).json({ error: "Group not found", code: "GROUP_NOT_FOUND" });
      return;
    }

    res.json(group);
  });

  /** Create a new group and optional awareness grants. */
  router.post("/", async function _createGroup(req, res)
  {
    const body = req.body as GroupWriteRequest;
    res.status(201).json(await createGroup(prisma, body));
  });

  /** Update a group and fully replace attached awareness grants. */
  router.put("/:id", async function _updateGroup(req, res)
  {
    const body = req.body as Partial<GroupWriteRequest>;
    res.json(await updateGroup(prisma, req.params.id, body));
  });

  /** Delete a group and any awareness grants linked to it. */
  router.delete("/:id", async function _deleteGroup(req, res)
  {
    res.json(await deleteGroup(prisma, req.params.id));
  });

  return router;
}
