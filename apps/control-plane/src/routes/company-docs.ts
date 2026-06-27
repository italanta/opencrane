import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { DocProposalStatus, type PrismaClient } from "@prisma/client";

import { _FindL0Directives } from "../core/personalisation/l0-guard.js";
import type { DocMergeReconciler } from "../core/personalisation/reconciler.types.js";
import { _GetCompanyDoc, _GetCompanyDocVersion, _ListCompanyDocVersions, _PublishCompanyDocVersion } from "../core/company-docs/company-docs.logic.js";
import { _DecideProposal, _ListProposals, _ReconcileTenantDoc } from "../core/company-docs/reconciliation.logic.js";

/**
 * Resolve the acting identity from the session, falling back to `system` for
 * token-authenticated (non-session) callers. Recorded on publishes/decisions.
 *
 * @param req - The incoming request.
 */
function _resolveActor(req: Request): string
{
  const authUser = req.session?.authUser;
  return authUser?.sub || authUser?.email || "system";
}

/**
 * Map a `?status=` query value to the proposal-status enum, or undefined.
 * @param raw - The raw query value.
 */
function _parseStatusFilter(raw: unknown): DocProposalStatus | undefined
{
  switch (raw)
  {
    case "pending": return DocProposalStatus.Pending;
    case "approved": return DocProposalStatus.Approved;
    case "rejected": return DocProposalStatus.Rejected;
    default: return undefined;
  }
}

/**
 * CRUD + reconciliation router for L1 company personalisation docs (P4C.3–P4C.5).
 *
 * Mounted under `/api/v1/org/workspace-docs` behind `___AuthMiddleware`. Company
 * docs are versioned immutably (P4C.3); per-tenant reconciliation produces
 * pending proposals (P4C.4) that, once approved, deliver into the pod workspace
 * via the contract re-pull loop (P4C.5).
 *
 * @param prisma     - Prisma client for persistence.
 * @param reconciler - The company→tenant merge engine.
 * @returns Configured Express router.
 */
export function companyDocsRouter(prisma: PrismaClient, reconciler: DocMergeReconciler): Router
{
  const router = Router();

  /** Get a company doc's current state and latest content. */
  router.get("/:name", async function _getDoc(req, res, next)
  {
    try
    {
      const doc = await _GetCompanyDoc(prisma, req.params.name);
      if (!doc)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
      res.json(doc);
    }
    catch (err) { next(err); }
  });

  /** Publish a new immutable version of a company doc. */
  router.put("/:name", async function _publishDoc(req, res, next)
  {
    try
    {
      const content = typeof req.body?.content === "string" ? req.body.content : "";

      // 1. Reject empty content and content carrying L0 directives before any
      //    write — surface the matched directives so the author can fix them.
      if (content.trim().length === 0)
      {
        res.status(400).json({ error: "content is required", code: "VALIDATION_ERROR" });
        return;
      }
      const l0 = _FindL0Directives(content);
      if (l0.length > 0)
      {
        res.status(422).json({ error: `Company docs may not assert L0 platform mechanics: ${l0.join(", ")}`, code: "L0_DIRECTIVE_REJECTED" });
        return;
      }

      // 2. Publish — appends an immutable version and bumps currentVersion.
      const result = await _PublishCompanyDocVersion(prisma, req.params.name, content, _resolveActor(req));
      res.status(201).json(result);
    }
    catch (err) { next(err); }
  });

  /** List a company doc's published versions, newest first. */
  router.get("/:name/versions", async function _listVersions(req, res, next)
  {
    try
    {
      const versions = await _ListCompanyDocVersions(prisma, req.params.name);
      if (!versions)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
      res.json({ name: req.params.name, versions });
    }
    catch (err) { next(err); }
  });

  /** Retrieve a specific immutable version by number. */
  router.get("/:name/versions/:version", async function _getVersion(req, res, next)
  {
    try
    {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1)
      {
        res.status(400).json({ error: "version must be a positive integer", code: "VALIDATION_ERROR" });
        return;
      }
      const row = await _GetCompanyDocVersion(prisma, req.params.name, version);
      if (!row)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
      res.json(row);
    }
    catch (err) { next(err); }
  });

  /** Generate a reconciliation proposal for a tenant against the current version. */
  router.post("/:name/reconcile", async function _reconcile(req, res, next)
  {
    try
    {
      const tenant = typeof req.body?.tenant === "string" ? req.body.tenant.trim() : "";
      if (tenant.length === 0)
      {
        res.status(400).json({ error: "tenant is required", code: "VALIDATION_ERROR" });
        return;
      }

      const outcome = await _ReconcileTenantDoc(prisma, reconciler, req.params.name, tenant);
      switch (outcome.kind)
      {
        case "no-company-version":
          res.status(409).json({ error: "No company version published for this doc", code: "NO_COMPANY_VERSION" });
          return;
        case "no-tenant":
          res.status(404).json({ error: "Tenant not found", code: "NOT_FOUND" });
          return;
        case "up-to-date":
          res.status(200).json({ status: "up-to-date", version: outcome.version });
          return;
        case "proposed":
          res.status(201).json(outcome.proposal);
          return;
      }
    }
    catch (err)
    {
      // The reconciler is sandboxed to L1/L2; an L0 breach in its output is a
      // merge fault, surfaced as 422 rather than a 500.
      if (err instanceof Error && err.message.includes("L0 system-mechanic"))
      {
        res.status(422).json({ error: err.message, code: "L0_DIRECTIVE_REJECTED" });
        return;
      }
      next(err);
    }
  });

  /** List reconciliation proposals for a doc (optional tenant/status filters). */
  router.get("/:name/proposals", async function _listProposals(req, res, next)
  {
    try
    {
      const tenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
      const status = _parseStatusFilter(req.query.status);
      res.json({ name: req.params.name, proposals: await _ListProposals(prisma, req.params.name, { tenant, status }) });
    }
    catch (err) { next(err); }
  });

  /** Approve a proposal — delivers the merged doc into the tenant workspace. */
  router.post("/:name/proposals/:id/approve", async function _approve(req, res, next)
  {
    await _decide(req.params.name, req.params.id, "approve", _resolveActor(req), res, next);
  });

  /** Reject a proposal — leaves the tenant doc untouched. */
  router.post("/:name/proposals/:id/reject", async function _reject(req, res, next)
  {
    await _decide(req.params.name, req.params.id, "reject", _resolveActor(req), res, next);
  });

  /**
   * Shared approve/reject handler.
   * @param name     - Company doc name (must match the proposal).
   * @param id       - Proposal identifier.
   * @param decision - The decision to apply.
   * @param actor    - Identity making the decision.
   * @param res      - Express response.
   * @param next     - Express next callback.
   */
  async function _decide(name: string, id: string, decision: "approve" | "reject", actor: string, res: Response, next: NextFunction): Promise<void>
  {
    try
    {
      const result = await _DecideProposal(prisma, name, id, decision, actor);
      if (!result)
      {
        res.status(404).json({ error: "Proposal not found", code: "NOT_FOUND" });
        return;
      }
      res.json(result);
    }
    catch (err)
    {
      // _DecideProposal throws when the proposal is no longer pending.
      if (err instanceof Error && err.message.includes("already"))
      {
        res.status(409).json({ error: err.message, code: "PROPOSAL_ALREADY_DECIDED" });
        return;
      }
      next(err);
    }
  }

  return router;
}
