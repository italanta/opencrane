import { Router } from "express";
import type { Request } from "express";
import { GrantScope, type PrismaClient } from "@prisma/client";

import { _log } from "../log.js";

/** Resource kinds a user can directly share (a file or a chat/conversation). */
const _RESOURCE_TYPES = ["file", "chat", "dataset"] as const;
type _ResourceTypeStr = typeof _RESOURCE_TYPES[number];

/** Request body for sharing a resource with another user. */
interface _ResourceShareBody
{
  resourceType?: string;
  resourceId?: string;
  recipientSubject?: string;
}

/** The caller's IdP subject (OIDC sub, else verified email), or null when unauthenticated. */
function _CallerSubject(req: Request): string | null
{
  const authUser = req.session?.authUser;
  const sub = typeof authUser?.sub === "string" ? authUser.sub.trim() : "";
  const email = typeof authUser?.email === "string" ? authUser.email.trim().toLowerCase() : "";
  return sub || email || null;
}

/** Deterministic, unique group name for a shared resource — one share-group per resource. */
function _ResourceGroupName(resourceType: _ResourceTypeStr, resourceId: string): string
{
  return `resource:${resourceType}:${resourceId}`;
}

/** Read a group's `members` JSON as a string list (the canonical stored shape). */
function _MemberList(members: unknown): string[]
{
  return Array.isArray(members) ? members.filter(function _isString(m): m is string { return typeof m === "string"; }) : [];
}

/** Shape a resource share-group into the API representation. */
function _ToResourceShare(row: { id: string; name: string; members: unknown })
{
  // Group name is `resource:<type>:<id>` — split back into the resource coordinates.
  const [, resourceType = "", ...idParts] = row.name.split(":");
  return { groupId: row.id, resourceType, resourceId: idParts.join(":"), members: _MemberList(row.members) };
}

/**
 * Inter-user RESOURCE sharing (S4c) — distinct from `/shares` (which shares tool/skill
 * entitlements). In the unified model a direct share of a file/chat materialises a
 * **resource-scoped, Personal-tier Group** whose members are everyone the resource is shared
 * with; the recipient's openclaw Tenant then inherits read access through the derived dataset
 * membership → Cognee (S4c.2). The sharer must already be a member of the resource's group
 * (its owner on first share) to add others — no sharing a resource you don't hold.
 *
 * @param prisma - Prisma client for the group mirror.
 * @returns Configured Express router.
 */
export function resourceSharesRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Share a resource with a user — create the resource group (first share) or add the recipient. */
  router.post("/", async function _shareResource(req: Request, res)
  {
    const caller = _CallerSubject(req);
    if (!caller)
    {
      res.status(401).json({ error: "Authentication required to share.", code: "UNAUTHORIZED" });
      return;
    }

    const body = (req.body ?? {}) as _ResourceShareBody;
    const resourceType = body.resourceType as _ResourceTypeStr;
    const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
    const recipient = typeof body.recipientSubject === "string" ? body.recipientSubject.trim() : "";
    if (!_RESOURCE_TYPES.includes(resourceType) || !resourceId || !recipient)
    {
      res.status(400).json({ error: "resourceType (file|chat|dataset), resourceId, and recipientSubject are required.", code: "VALIDATION_ERROR" });
      return;
    }

    const groupName = _ResourceGroupName(resourceType, resourceId);
    const existing = await prisma.group.findUnique({ where: { name: groupName }, select: { id: true, name: true, members: true } });

    // First share → the caller creates the resource group and is its founding member (owner).
    if (!existing)
    {
      const created = await prisma.group.create({
        data: {
          name: groupName,
          scope: GrantScope.Personal,
          description: `Direct share of ${resourceType} ${resourceId}`,
          members: Array.from(new Set([caller, recipient])),
        },
        select: { id: true, name: true, members: true },
      });
      _log.info({ caller, resourceType, resourceId, recipient, groupId: created.id }, "resource share-group created");
      res.status(201).json(_ToResourceShare(created));
      return;
    }

    // Subsequent share → least-privilege: only a current member may add others (you cannot share
    // a resource you do not have access to). Then add the recipient if not already present.
    const members = _MemberList(existing.members);
    if (!members.includes(caller))
    {
      _log.warn({ caller, resourceType, resourceId }, "resource share denied: caller is not a member of the resource group (least-privilege gate)");
      res.status(403).json({ error: "You can only share a resource you have access to.", code: "FORBIDDEN" });
      return;
    }
    if (members.includes(recipient))
    {
      res.status(200).json(_ToResourceShare(existing));
      return;
    }
    const updated = await prisma.group.update({
      where: { name: groupName },
      data: { members: [...members, recipient] },
      select: { id: true, name: true, members: true },
    });
    _log.info({ caller, resourceType, resourceId, recipient, groupId: updated.id }, "recipient added to resource share-group");
    res.status(200).json(_ToResourceShare(updated));
  });

  /** List the resource share-groups the caller is a member of. */
  router.get("/", async function _listResourceShares(req: Request, res)
  {
    const caller = _CallerSubject(req);
    if (!caller)
    {
      res.status(401).json({ error: "Authentication required.", code: "UNAUTHORIZED" });
      return;
    }
    // Resource groups are the Personal-scoped groups named `resource:*`; filter to the caller's.
    const groups = await prisma.group.findMany({ where: { scope: GrantScope.Personal, name: { startsWith: "resource:" } }, select: { id: true, name: true, members: true } });
    res.json(groups.filter(function _mine(g) { return _MemberList(g.members).includes(caller); }).map(_ToResourceShare));
  });

  /** Revoke a recipient from a resource share — only a current member may unshare. */
  router.delete("/:groupId/recipients/:subject", async function _unshareResource(req: Request<{ groupId: string; subject: string }>, res)
  {
    const caller = _CallerSubject(req);
    if (!caller)
    {
      res.status(401).json({ error: "Authentication required.", code: "UNAUTHORIZED" });
      return;
    }
    const group = await prisma.group.findUnique({ where: { id: req.params.groupId }, select: { id: true, name: true, members: true } });
    // Not a resource group, or one the caller is not in, is not theirs to modify — fail closed.
    if (!group || !group.name.startsWith("resource:") || !_MemberList(group.members).includes(caller))
    {
      res.status(404).json({ error: "Resource share not found.", code: "NOT_FOUND" });
      return;
    }
    const remaining = _MemberList(group.members).filter(function _notTarget(m) { return m !== req.params.subject; });
    const updated = await prisma.group.update({ where: { id: req.params.groupId }, data: { members: remaining }, select: { id: true, name: true, members: true } });
    _log.info({ caller, groupId: req.params.groupId, removed: req.params.subject }, "recipient revoked from resource share-group");
    res.json(_ToResourceShare(updated));
  });

  return router;
}
