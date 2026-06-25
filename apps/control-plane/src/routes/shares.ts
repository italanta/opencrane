import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { GrantAccess, GrantPayloadType, GrantScope, GrantSubjectType, type PrismaClient } from "@prisma/client";

import { compile } from "../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../core/grants/grant-compiler.types.js";
import { _log } from "../log.js";
import type { CreateShareBody, SharePayloadType, ShareRecipientType, ShareScope } from "./shares.types.js";

/** Payload families a user may share (the entitlement surfaces the runtime contract carries). */
const _PAYLOAD_TYPES: readonly SharePayloadType[] = ["mcp-server", "skill-bundle"];
/** Recipient kinds a share may target. */
const _RECIPIENT_TYPES: readonly ShareRecipientType[] = ["user", "group"];
/** Visibility scopes a share may carry (mirrors GrantScope; defaults to personal). */
const _SCOPES: readonly ShareScope[] = ["org", "department", "project", "personal"];

/** Map the API payload-type string to the compiler enum used by the least-privilege gate. */
const _COMPILER_PAYLOAD_BY_API: Record<SharePayloadType, GrantCompilerPayloadType> = {
  "mcp-server": GrantCompilerPayloadType.McpServer,
  "skill-bundle": GrantCompilerPayloadType.SkillBundle,
};

/** Map the API payload-type string to the Prisma enum written on the Grant row. */
const _PRISMA_PAYLOAD_BY_API: Record<SharePayloadType, GrantPayloadType> = {
  "mcp-server": GrantPayloadType.McpServer,
  "skill-bundle": GrantPayloadType.SkillBundle,
};

/** Map the API scope string to the Prisma GrantScope enum. */
const _PRISMA_SCOPE_BY_API: Record<ShareScope, GrantScope> = {
  org: GrantScope.Org,
  department: GrantScope.Department,
  project: GrantScope.Project,
  personal: GrantScope.Personal,
};

/** The caller's IdP subject (OIDC sub, else verified email), or null when unauthenticated. */
function _CallerSubject(req: Request): string | null
{
  const authUser = req.session?.authUser;
  const sub = typeof authUser?.sub === "string" ? authUser.sub.trim() : "";
  const email = typeof authUser?.email === "string" ? authUser.email.trim().toLowerCase() : "";
  return sub || email || null;
}

/** Shape a Grant row into the API share representation. */
function _ToShare(row: { id: string; payloadType: string; payloadId: string; subjectType: string; subjectId: string; scope: string; note: string | null; sharedBy: string | null; createdAt: Date })
{
  return {
    id: row.id,
    payloadType: row.payloadType,
    payloadId: row.payloadId,
    recipientType: row.subjectType,
    recipientId: row.subjectId,
    scope: row.scope,
    note: row.note ?? undefined,
    sharedBy: row.sharedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Inter-user sharing router (S4). A user shares an entitlement they themselves hold with
 * another user or group; the share is an `Allow` Grant on the recipient, which the
 * recipient's openclaw Tenant then inherits through the contract compiler (S4a). Sharing is
 * **least-privilege bounded**: the caller may only share a payload for which their own
 * compiled grants resolve to `Allow` — there is no privilege escalation. The sharer is
 * recorded (`Grant.sharedBy`) so they can list and revoke only their own shares.
 *
 * @param prisma - Prisma client for grant + payload/recipient lookups.
 * @returns Configured Express router.
 */
export function sharesRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Create a share: grant a held entitlement to another user/group (least-privilege gated). */
  router.post("/", async function _createShare(req: Request, res: Response, next: NextFunction)
  {
    try
    {
      // 1. Resolve the caller; sharing is an authenticated, identity-bound action.
      const caller = _CallerSubject(req);
      if (!caller)
      {
        res.status(401).json({ error: "Authentication required to share.", code: "UNAUTHORIZED" });
        return;
      }

      // 2. Validate the body shape against the closed enum sets before any DB work.
      const body = (req.body ?? {}) as CreateShareBody;
      const payloadType = body.payloadType as SharePayloadType;
      const recipientType = body.recipientType as ShareRecipientType;
      const scope = (body.scope ?? "personal") as ShareScope;
      const payloadId = typeof body.payloadId === "string" ? body.payloadId.trim() : "";
      const recipientId = typeof body.recipientId === "string" ? body.recipientId.trim() : "";
      if (!_PAYLOAD_TYPES.includes(payloadType) || !_RECIPIENT_TYPES.includes(recipientType) || !_SCOPES.includes(scope) || !payloadId || !recipientId)
      {
        res.status(400).json({ error: "payloadType (mcp-server|skill-bundle), payloadId, recipientType (user|group), recipientId are required; scope must be org|department|project|personal.", code: "VALIDATION_ERROR" });
        return;
      }

      // 3. The payload must exist (you cannot share a server/bundle that is gone). Resolved by
      //    family so the share row also carries the cascade-on-delete relation id.
      const payloadExists = payloadType === "mcp-server"
        ? await prisma.mcpServer.findUnique({ where: { id: payloadId }, select: { id: true } })
        : await prisma.skillBundle.findUnique({ where: { id: payloadId }, select: { id: true } });
      if (!payloadExists)
      {
        res.status(404).json({ error: `No ${payloadType} found with id '${payloadId}'.`, code: "NOT_FOUND" });
        return;
      }

      // 4. A group recipient must be a real group; a user recipient is an opaque IdP subject
      //    (users live in Zitadel, not the local DB), so it is accepted as-is.
      if (recipientType === "group")
      {
        const group = await prisma.group.findUnique({ where: { id: recipientId }, select: { id: true } });
        if (!group)
        {
          res.status(404).json({ error: `No group found with id '${recipientId}'.`, code: "NOT_FOUND" });
          return;
        }
      }

      // 5. LEAST-PRIVILEGE GATE: the caller may only share what they themselves hold. Compile
      //    the caller's own effective grants and require an Allow on this payload — a Deny or
      //    an absent grant fails closed (403), so sharing can never escalate privilege.
      const callerDecisions = await compile(caller, _COMPILER_PAYLOAD_BY_API[payloadType], prisma);
      const callerHolds = callerDecisions.some(function _isAllow(d) { return d.payloadId === payloadId && d.access === GrantCompilerAccess.Allow; });
      if (!callerHolds)
      {
        _log.warn({ caller, payloadType, payloadId, recipientType, recipientId }, "share denied: caller does not hold an Allow on the payload (least-privilege gate)");
        res.status(403).json({ error: "You can only share an entitlement you currently hold.", code: "FORBIDDEN" });
        return;
      }

      // 6. Idempotent on (sharedBy, payloadType, payloadId, subjectType, subjectId, scope):
      //    re-sharing the same payload to the same recipient at the same scope returns the
      //    existing grant. A different scope is a distinct share and creates a new row.
      const subjectType = recipientType === "group" ? GrantSubjectType.Group : GrantSubjectType.User;
      const existing = await prisma.grant.findFirst({
        where: { sharedBy: caller, payloadType: _PRISMA_PAYLOAD_BY_API[payloadType], payloadId, subjectType, subjectId: recipientId, scope: _PRISMA_SCOPE_BY_API[scope], access: GrantAccess.Allow },
      });
      if (existing)
      {
        res.status(200).json(_ToShare(existing));
        return;
      }

      // 7. Write the share as an Allow Grant on the recipient, stamping the sharer and the
      //    cascade relation id so the row is reaped if the payload is deleted.
      const created = await prisma.grant.create({
        data: {
          payloadType: _PRISMA_PAYLOAD_BY_API[payloadType],
          payloadId,
          scope: _PRISMA_SCOPE_BY_API[scope],
          subjectType,
          subjectId: recipientId,
          access: GrantAccess.Allow,
          note: body.note,
          sharedBy: caller,
          ...(recipientType === "group" ? { groupId: recipientId } : {}),
          ...(payloadType === "mcp-server" ? { mcpServerId: payloadId } : { skillBundleId: payloadId }),
        },
      });
      _log.info({ caller, payloadType, payloadId, recipientType, recipientId, grantId: created.id }, "share created (inherited by the recipient's tenant on its next contract poll)");
      res.status(201).json(_ToShare(created));
    }
    catch (err)
    {
      next(err);
    }
  });

  /** List the shares the caller has created (never another user's). */
  router.get("/", async function _listShares(req: Request, res: Response, next: NextFunction)
  {
    try
    {
      const caller = _CallerSubject(req);
      if (!caller)
      {
        res.status(401).json({ error: "Authentication required.", code: "UNAUTHORIZED" });
        return;
      }
      const rows = await prisma.grant.findMany({ where: { sharedBy: caller }, orderBy: { createdAt: "desc" } });
      res.json(rows.map(_ToShare));
    }
    catch (err)
    {
      next(err);
    }
  });

  /** Revoke a share — only one the caller created (a sharer holds no power over others' grants). */
  router.delete("/:id", async function _revokeShare(req: Request<{ id: string }>, res: Response, next: NextFunction)
  {
    try
    {
      const caller = _CallerSubject(req);
      if (!caller)
      {
        res.status(401).json({ error: "Authentication required.", code: "UNAUTHORIZED" });
        return;
      }
      const grant = await prisma.grant.findUnique({ where: { id: req.params.id }, select: { id: true, sharedBy: true } });
      // A grant that does not exist, or one the caller did not share (including admin-path grants
      // with a null sharer), is not theirs to revoke — fail closed so sharing confers no extra power.
      if (!grant || grant.sharedBy !== caller)
      {
        res.status(404).json({ error: "Share not found.", code: "NOT_FOUND" });
        return;
      }
      await prisma.grant.delete({ where: { id: req.params.id } });
      _log.info({ caller, grantId: req.params.id }, "share revoked");
      res.json({ id: req.params.id, status: "revoked" });
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
