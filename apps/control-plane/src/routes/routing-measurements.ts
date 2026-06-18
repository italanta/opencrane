import { Router } from "express";
import { ModelRoutingScope } from "@opencrane/contracts";
import type { RoutingMeasurement as RoutingMeasurementDto } from "@opencrane/contracts";
import type { PrismaClient, RoutingMeasurement as PrismaRoutingMeasurement } from "@prisma/client";

import { _ClusterTenantScopeGuard } from "../infra/middleware/cluster-tenant-scope.js";
import type { ClusterTenantScopedResource } from "../infra/middleware/cluster-tenant-scope.types.js";
import { _RunShadowMeasurement } from "../core/model-routing/shadow-measure.js";
import type { JudgeClient, ModelRunner } from "../core/model-routing/shadow-measure.types.js";
import type { RunMeasurementBody, ValidationFailure } from "./routing-measurements.types.js";

/** Factory producing the configured shadow-measurement seams; null seams mean "unconfigured". */
export type ShadowSeamsFactory = () => { judge: JudgeClient | null; runner: ModelRunner | null };

/**
 * Project a persisted `RoutingMeasurement` row into its read DTO.
 * @param row - The persisted row.
 * @returns The measurement DTO (timestamp as an ISO-8601 string).
 */
function _toView(row: PrismaRoutingMeasurement): RoutingMeasurementDto
{
  return {
    id: row.id,
    skillName: row.skillName,
    skillScope: row.skillScope,
    skillTeam: row.skillTeam,
    candidateModel: row.candidateModel,
    sampledCalls: row.sampledCalls,
    atBarCheapFraction: row.atBarCheapFraction,
    projectedSavingsPct: row.projectedSavingsPct,
    ciLowPct: row.ciLowPct,
    ciHighPct: row.ciHighPct,
    overheadPct: row.overheadPct,
    runAt: row.runAt.toISOString(),
  };
}

/**
 * Validate a `POST /run` body: the owning skill identity and a candidate model are required.
 * @param body - The untrusted request body.
 * @returns A `{ error, code }` payload when invalid; null when valid.
 */
function _validateRun(body: Record<string, unknown>): ValidationFailure | null
{
  if (typeof body.skillName !== "string" || !body.skillName.trim())
  {
    return { error: "skillName is required.", code: "VALIDATION_ERROR" };
  }
  if (typeof body.skillScope !== "string" || !body.skillScope.trim())
  {
    return { error: "skillScope is required.", code: "VALIDATION_ERROR" };
  }
  if (typeof body.candidateModel !== "string" || !body.candidateModel.trim())
  {
    return { error: "candidateModel is required.", code: "VALIDATION_ERROR" };
  }
  return null;
}

/**
 * Resolve the baseline model for a run: prefer the explicit `currentModel` from the body, else fall
 * back to the skill's persisted `pinnedModel`. Returns null when neither is available (the
 * orchestrator treats a null baseline as unconfigured and no-ops).
 *
 * @param prisma     - Prisma client for the skill lookup.
 * @param body       - The validated run body.
 * @param skillTeam  - The owning skill's team.
 * @returns The baseline model name, or null.
 */
async function _resolveBaseline(prisma: PrismaClient, body: RunMeasurementBody, skillTeam: string): Promise<string | null>
{
  // 1. An explicit baseline from the caller (CLI resolves the precedence chain) always wins.
  if (typeof body.currentModel === "string" && body.currentModel.trim())
  {
    return body.currentModel.trim();
  }

  // 2. Otherwise fall back to the skill's own pinned model, when set.
  const skill = await prisma.skill.findUnique({
    where: { name_scope_team: { name: body.skillName, scope: body.skillScope, team: skillTeam } },
    select: { pinnedModel: true },
  });
  return skill?.pinnedModel ?? null;
}

/**
 * Router for AIR.6 shadow-savings measurements. Mounted under `/api/v1/model-routing/measurements`.
 *
 * Reads (`GET /`, `GET /:id`) are open to any authenticated caller. `POST /run` is operator-gated
 * (Global-scoped guard) and triggers a shadow measurement via the injected seams; it is
 * best-effort — when the seams are unconfigured it returns 200 with a `seams unconfigured` note and
 * records nothing. The run changes no live routing.
 *
 * @param prisma       - Prisma client used for persistence.
 * @param seamsFactory - Builds the judge + runner seams (both null when unconfigured).
 * @returns Configured Express router.
 */
export function routingMeasurementsRouter(prisma: PrismaClient, seamsFactory: ShadowSeamsFactory): Router
{
  const router = Router();

  // POST /run is a platform-wide operation — gate it as a Global-scoped resource (operator-only).
  const operatorGuard = _ClusterTenantScopeGuard(prisma, async function _resolveResource(): Promise<ClusterTenantScopedResource | null>
  {
    return { scope: ModelRoutingScope.Global, clusterTenant: null };
  });
  router.post("/run", operatorGuard);

  /** List measurements, optionally filtered by the owning skill's compound key. */
  router.get("/", async function _list(req, res, next)
  {
    try
    {
      const skillName = typeof req.query.skillName === "string" ? req.query.skillName : undefined;
      const skillScope = typeof req.query.skillScope === "string" ? req.query.skillScope : undefined;
      const skillTeam = typeof req.query.skillTeam === "string" ? req.query.skillTeam : undefined;
      const rows = await prisma.routingMeasurement.findMany({
        where: { ...(skillName ? { skillName } : {}), ...(skillScope ? { skillScope } : {}), ...(skillTeam !== undefined ? { skillTeam } : {}) },
        orderBy: { runAt: "desc" },
      });
      res.json(rows.map(_toView));
    }
    catch (err) { next(err); }
  });

  /** Get a single measurement by id. */
  router.get("/:id", async function _get(req, res, next)
  {
    try
    {
      const row = await prisma.routingMeasurement.findUnique({ where: { id: req.params.id } });
      if (!row)
      {
        res.status(404).json({ error: "Measurement not found", code: "NOT_FOUND" });
        return;
      }
      res.json(_toView(row));
    }
    catch (err) { next(err); }
  });

  /** Trigger a shadow measurement for a skill + candidate (best-effort; operator-gated). */
  router.post("/run", async function _run(req, res, next)
  {
    try
    {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const error = _validateRun(body);
      if (error)
      {
        res.status(400).json(error);
        return;
      }

      const run = body as unknown as RunMeasurementBody;
      const skillTeam = typeof run.skillTeam === "string" ? run.skillTeam.trim() : "";

      // 1. Resolve the seams. Unconfigured (no live LiteLLM/judge) → no-op with a 200 note so the
      //    validatable wiring stays intact without live ML infra.
      const { judge, runner } = seamsFactory();

      // 2. Resolve the baseline model the candidate is measured against.
      const currentModel = await _resolveBaseline(prisma, run, skillTeam);

      // 3. Load the skill's eval cases — the golden suite both models are graded on.
      const evalCases = await prisma.routingEvalCase.findMany({
        where: { skillName: run.skillName, skillScope: run.skillScope, skillTeam },
      });

      // 4. Run the orchestrator (pure savings + persistence). Best-effort: a null seam pair returns
      //    `unconfigured` and records nothing.
      const outcome = await _RunShadowMeasurement(
        prisma,
        { skill: { name: run.skillName, scope: run.skillScope, team: skillTeam }, evalCases, currentModel, candidateModel: run.candidateModel.trim() },
        judge,
        runner,
      );

      if (outcome.kind === "unconfigured")
      {
        res.status(200).json({ status: "unconfigured", note: "Shadow-measurement seams are not configured; nothing was recorded." });
        return;
      }

      // 5. Measured — return the persisted measurement (202 Accepted: a measurement run completed).
      const measurement = await prisma.routingMeasurement.findUnique({ where: { id: outcome.measurementId! } });
      res.status(202).json({ status: "measured", measurement: measurement ? _toView(measurement) : null, proposalId: outcome.proposalId ?? null });
    }
    catch (err) { next(err); }
  });

  return router;
}
