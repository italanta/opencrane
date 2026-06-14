import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _BuildFleetParticipationReport } from "../core/awareness/participation.js";

/**
 * Fleet participation monitoring router (P4B.5).
 *
 * Reports per-tenant participation, version drift, and policy-violation severity
 * across the fleet (the locked `violation=page / drift=warn` model). CLI-first:
 * `oc awareness participation` and the WeOwnAI frontend are both clients.
 * Mounted under `/api/v1/awareness/participation` behind `___AuthMiddleware`.
 *
 * @param prisma - Prisma client.
 * @returns Configured Express router.
 */
export function awarenessParticipationRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /**
   * Fleet participation report. `?severity=critical|warning` filters the tenant
   * list (the aggregate counts always reflect the whole fleet).
   */
  router.get("/", async function _getParticipation(req, res, next)
  {
    try
    {
      // Inject the wall clock once so staleness is computed against a single instant.
      const report = await _BuildFleetParticipationReport(prisma, Date.now());

      const severity = req.query.severity;
      if (severity === "critical" || severity === "warning")
      {
        res.json({ ...report, tenants: report.tenants.filter(function _bySeverity(t) { return t.severity === severity; }) });
        return;
      }
      res.json(report);
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
