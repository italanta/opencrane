import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { ModelRoutingScope, RoutingProposalStatus } from "@opencrane/contracts";
import type { RoutingProposal as RoutingProposalDto } from "@opencrane/contracts";
import { RoutingProposalStatus as PrismaRoutingProposalStatus } from "@prisma/client";
import type { PrismaClient, RoutingProposal as PrismaRoutingProposal } from "@prisma/client";

import { _ClusterTenantScopeGuard } from "../infra/middleware/cluster-tenant-scope.js";
import type { ClusterTenantScopedResource } from "../infra/middleware/cluster-tenant-scope.types.js";
import type { DecideProposalResult } from "./routing-proposals.types.js";

/**
 * Map an eval/proposal's owning-skill team to the ClusterTenant-scope guard's resource shape.
 * Team-scoped → owned by that ClusterTenant; org/global → Global (operator-only). Mirrors
 * `skill-model-posture._toScopedResource` (AIR.0b).
 *
 * @param skillTeam - The owning skill's team (empty string when not team-scoped).
 * @returns The scope + owning clusterTenant the guard compares against.
 */
function _toScopedResource(skillTeam: string): ClusterTenantScopedResource
{
  const owningTeam = typeof skillTeam === "string" ? skillTeam.trim() : "";
  if (owningTeam)
  {
    return { scope: ModelRoutingScope.ClusterTenant, clusterTenant: owningTeam };
  }
  return { scope: ModelRoutingScope.Global, clusterTenant: null };
}

/**
 * Project a persisted `RoutingProposal` row into its read DTO.
 * @param row - The persisted row.
 * @returns The proposal DTO (timestamps as ISO-8601 strings; status lower-cased to the contract enum).
 */
function _toView(row: PrismaRoutingProposal): RoutingProposalDto
{
  return {
    id: row.id,
    skillName: row.skillName,
    skillScope: row.skillScope,
    skillTeam: row.skillTeam,
    fromModel: row.fromModel,
    proposedModel: row.proposedModel,
    projectedSavingsPct: row.projectedSavingsPct,
    ciLowPct: row.ciLowPct,
    ciHighPct: row.ciHighPct,
    measurementId: row.measurementId,
    status: row.status.toLowerCase() as RoutingProposalDto["status"],
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Map a `?status=` query value to the Prisma proposal-status enum, or undefined.
 * @param raw - The raw query value.
 */
function _parseStatusFilter(raw: unknown): PrismaRoutingProposalStatus | undefined
{
  switch (raw)
  {
    case RoutingProposalStatus.Pending: return PrismaRoutingProposalStatus.Pending;
    case RoutingProposalStatus.Approved: return PrismaRoutingProposalStatus.Approved;
    case RoutingProposalStatus.Rejected: return PrismaRoutingProposalStatus.Rejected;
    case RoutingProposalStatus.Applied: return PrismaRoutingProposalStatus.Applied;
    default: return undefined;
  }
}

/**
 * Resolve the acting identity from the session, falling back to `system` for token-authenticated
 * (non-session) callers. Recorded on the proposal decision + audit entry.
 *
 * @param req - The incoming request.
 */
function _resolveActor(req: Request): string
{
  const authUser = req.session?.authUser;
  return authUser?.sub || authUser?.email || "system";
}

/**
 * Router for AIR.7 routing-change proposals. Mounted under `/api/v1/model-routing/proposals`.
 *
 * Reads (`GET /`, `GET /:id`) are open. `POST /:id/approve` and `POST /:id/reject` are gated by the
 * ClusterTenant scope guard against the proposal's owning skill team (AIR.0b). **Apply happens only
 * on approve** — approve pins the skill to `proposedModel` (the same `Skill` write AIR.3 uses) and
 * flips the proposal to Applied; reject only flips the status. Both write an AuditEntry.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function routingProposalsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  // Decision guard: resolve the owning skill's team from the persisted proposal so the guard can
  // compare it against the caller's ClusterTenant (a missing proposal falls through to the 404).
  const guard = _ClusterTenantScopeGuard(prisma, async function _resolveResource(req): Promise<ClusterTenantScopedResource | null>
  {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id)
    {
      return null;
    }
    const row = await prisma.routingProposal.findUnique({ where: { id }, select: { skillTeam: true } });
    return row ? _toScopedResource(row.skillTeam) : null;
  });
  router.post("/:id/approve", guard);
  router.post("/:id/reject", guard);

  /** List proposals, optionally filtered by `?status=`. */
  router.get("/", async function _list(req, res, next)
  {
    try
    {
      const status = _parseStatusFilter(req.query.status);
      const rows = await prisma.routingProposal.findMany({
        where: { ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
      });
      res.json(rows.map(_toView));
    }
    catch (err) { next(err); }
  });

  /** Get a single proposal by id. */
  router.get("/:id", async function _get(req, res, next)
  {
    try
    {
      const row = await prisma.routingProposal.findUnique({ where: { id: req.params.id } });
      if (!row)
      {
        res.status(404).json({ error: "Proposal not found", code: "NOT_FOUND" });
        return;
      }
      res.json(_toView(row));
    }
    catch (err) { next(err); }
  });

  /** Approve a proposal — pin the skill to `proposedModel` and flip status to Applied. */
  router.post("/:id/approve", async function _approve(req, res, next)
  {
    await _decide(prisma, req.params.id, "approve", _resolveActor(req), res, next);
  });

  /** Reject a proposal — flip status to Rejected; the skill posture is left untouched. */
  router.post("/:id/reject", async function _reject(req, res, next)
  {
    await _decide(prisma, req.params.id, "reject", _resolveActor(req), res, next);
  });

  return router;
}

/**
 * Shared approve/reject handler for a routing proposal.
 *
 * Approve applies the change — atomically pins the skill (`modelMode=Pinned`,
 * `pinnedModel=proposedModel`) and flips the proposal to Applied — then audits. Reject flips the
 * status only and audits. A non-pending proposal is a 409 (double-apply guard); a missing proposal
 * or a missing skill is a 404.
 *
 * @param prisma   - Prisma client.
 * @param id       - Proposal id.
 * @param decision - `"approve"` or `"reject"`.
 * @param actor    - Identity making the decision (for audit + decidedBy).
 * @param res      - Express response.
 * @param next     - Express next callback.
 */
async function _decide(prisma: PrismaClient, id: string, decision: "approve" | "reject", actor: string, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    // 1. Load the proposal; it must exist to be decided.
    const proposal = await prisma.routingProposal.findUnique({ where: { id } });
    if (!proposal)
    {
      res.status(404).json({ error: "Proposal not found", code: "NOT_FOUND" });
      return;
    }

    // 2. Only a Pending proposal can be decided — guard against re-applying an already-decided one.
    if (proposal.status !== PrismaRoutingProposalStatus.Pending)
    {
      res.status(409).json({ error: `proposal ${id} is already ${proposal.status.toLowerCase()}`, code: "PROPOSAL_ALREADY_DECIDED" });
      return;
    }

    // 3. Reject — flip status only; the skill's posture stays as it was.
    if (decision === "reject")
    {
      await prisma.routingProposal.update({ where: { id }, data: { status: PrismaRoutingProposalStatus.Rejected, decidedBy: actor, decidedAt: new Date() } });
      await prisma.auditEntry.create({
        data: { action: "RoutingProposalRejected", resource: `RoutingProposal/${id}`, message: `Routing proposal ${id} (${proposal.skillName}) rejected by ${actor}` },
      });
      res.json({ id, status: "rejected", appliedModel: null } satisfies DecideProposalResult);
      return;
    }

    // 4. Approve — the locked rule's only apply point. The target skill must still exist.
    const skill = await prisma.skill.findUnique({ where: { name_scope_team: { name: proposal.skillName, scope: proposal.skillScope, team: proposal.skillTeam } } });
    if (!skill)
    {
      res.status(404).json({ error: "Target skill not found", code: "SKILL_NOT_FOUND" });
      return;
    }

    // 5. Atomically pin the skill to the proposed model (the same Skill write AIR.3 uses) and flip
    //    the proposal to Applied, so the next contract re-pull serves the cheaper model.
    await prisma.$transaction(async function _apply(tx): Promise<void>
    {
      await tx.skill.update({
        where: { name_scope_team: { name: proposal.skillName, scope: proposal.skillScope, team: proposal.skillTeam } },
        data: { modelMode: "Pinned", pinnedModel: proposal.proposedModel },
      });
      await tx.routingProposal.update({ where: { id }, data: { status: PrismaRoutingProposalStatus.Applied, decidedBy: actor, decidedAt: new Date() } });
    });

    // 6. Audit the applied change so the routing mutation is attributable.
    await prisma.auditEntry.create({
      data: { action: "RoutingProposalApplied", resource: `RoutingProposal/${id}`, message: `Routing proposal ${id} approved by ${actor}: ${proposal.skillName} pinned to ${proposal.proposedModel}` },
    });

    res.json({ id, status: "applied", appliedModel: proposal.proposedModel } satisfies DecideProposalResult);
  }
  catch (err) { next(err); }
}
