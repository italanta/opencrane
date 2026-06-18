import { Router } from "express";
import { ModelRoutingScope } from "@opencrane/contracts";
import type { RoutingEvalCase as RoutingEvalCaseDto } from "@opencrane/contracts";
import { Prisma } from "@prisma/client";
import type { PrismaClient, RoutingEvalCase as PrismaRoutingEvalCase } from "@prisma/client";

import { _ClusterTenantScopeGuard } from "../infra/middleware/cluster-tenant-scope.js";
import type { ClusterTenantScopedResource } from "../infra/middleware/cluster-tenant-scope.types.js";
import type { ValidationFailure } from "./routing-eval-cases.types.js";

/**
 * Map an eval case's owning-skill identity to the ClusterTenant-scope guard's resource shape.
 * A team-scoped skill is owned by the ClusterTenant named by its team; an org/global skill is
 * Global (operator-only). Mirrors `skill-model-posture._toScopedResource` (AIR.0b).
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
 * Project a persisted `RoutingEvalCase` row into its read DTO.
 * @param row - The persisted row.
 * @returns The eval-case DTO (timestamps as ISO-8601 strings).
 */
function _toView(row: PrismaRoutingEvalCase): RoutingEvalCaseDto
{
  return {
    id: row.id,
    skillName: row.skillName,
    skillScope: row.skillScope,
    skillTeam: row.skillTeam,
    input: row.input,
    expected: row.expected ?? null,
    qualityBar: row.qualityBar,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate a `RoutingEvalCaseWrite` body. Requires the owning skill identity (`skillName`,
 * `skillScope`) and a usable `input`; `qualityBar`, when present, must be a fraction in [0, 1].
 *
 * @param body - The untrusted request body.
 * @returns A `{ error, code }` payload when invalid; null when valid.
 */
function _validateWrite(body: Record<string, unknown>): ValidationFailure | null
{
  // 1. The eval case is anchored to a skill — its name + scope are required.
  if (typeof body.skillName !== "string" || !body.skillName.trim())
  {
    return { error: "skillName is required.", code: "VALIDATION_ERROR" };
  }
  if (typeof body.skillScope !== "string" || !body.skillScope.trim())
  {
    return { error: "skillScope is required.", code: "VALIDATION_ERROR" };
  }

  // 2. The input is the prompt graded against both models — it must be present.
  if (body.input === undefined || body.input === null)
  {
    return { error: "input is required.", code: "VALIDATION_ERROR" };
  }

  // 3. qualityBar is the per-case acceptance threshold; constrain it to a [0, 1] fraction.
  if (body.qualityBar !== undefined && (typeof body.qualityBar !== "number" || body.qualityBar < 0 || body.qualityBar > 1))
  {
    return { error: "qualityBar must be a number between 0 and 1.", code: "VALIDATION_ERROR" };
  }

  return null;
}

/**
 * Coerce a request value into a Prisma JSON input value (or DbNull for absent/null).
 * @param raw - The untrusted value.
 */
function _toJsonInput(raw: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull
{
  return raw === undefined || raw === null ? Prisma.JsonNull : (raw as Prisma.InputJsonValue);
}

/**
 * CRUD router for routing eval cases (AIR.6) — the per-skill golden suite the shadow measurement
 * grades candidate models against. Mounted under `/api/v1/model-routing/eval-cases`.
 *
 * Reads (`GET /`, `GET /:id`) are open to any authenticated caller. Mutations (POST/PUT/DELETE) are
 * gated by the ClusterTenant scope guard against the owning skill's team (AIR.0b): a team-scoped
 * skill's cases are owned by that ClusterTenant; org/global cases are operator-only.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function routingEvalCasesRouter(prisma: PrismaClient): Router
{
  const router = Router();

  // Mutation guard: resolve the owning skill's team from the body (create/update) or the persisted
  // row (update/delete by id) so the guard can compare it against the caller's ClusterTenant.
  const guard = _ClusterTenantScopeGuard(prisma, async function _resolveResource(req): Promise<ClusterTenantScopedResource | null>
  {
    // 1. A body naming the owning skill (create/update) authoritatively carries the team — an
    //    absent skillTeam means org/global (empty team), which is operator-only, not a fall-through.
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.skillName === "string")
    {
      const bodyTeam = typeof body.skillTeam === "string" ? body.skillTeam : "";
      return _toScopedResource(bodyTeam);
    }

    // 2. Otherwise (id-addressed mutation without a skill body) resolve the owner from the row; a
    //    missing row falls through to null so the handler can emit the canonical 404.
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (id)
    {
      const row = await prisma.routingEvalCase.findUnique({ where: { id }, select: { skillTeam: true } });
      if (row)
      {
        return _toScopedResource(row.skillTeam);
      }
    }
    return null;
  });

  router.post("/", guard);
  router.put("/:id", guard);
  router.delete("/:id", guard);

  /** List eval cases, optionally filtered by the owning skill's compound key. */
  router.get("/", async function _list(req, res, next)
  {
    try
    {
      const skillName = typeof req.query.skillName === "string" ? req.query.skillName : undefined;
      const skillScope = typeof req.query.skillScope === "string" ? req.query.skillScope : undefined;
      const skillTeam = typeof req.query.skillTeam === "string" ? req.query.skillTeam : undefined;
      const rows = await prisma.routingEvalCase.findMany({
        where: { ...(skillName ? { skillName } : {}), ...(skillScope ? { skillScope } : {}), ...(skillTeam !== undefined ? { skillTeam } : {}) },
        orderBy: { createdAt: "desc" },
      });
      res.json(rows.map(_toView));
    }
    catch (err) { next(err); }
  });

  /** Get a single eval case by id. */
  router.get("/:id", async function _get(req, res, next)
  {
    try
    {
      const row = await prisma.routingEvalCase.findUnique({ where: { id: req.params.id } });
      if (!row)
      {
        res.status(404).json({ error: "Eval case not found", code: "NOT_FOUND" });
        return;
      }
      res.json(_toView(row));
    }
    catch (err) { next(err); }
  });

  /** Create an eval case for a skill. */
  router.post("/", async function _create(req, res, next)
  {
    try
    {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const error = _validateWrite(body);
      if (error)
      {
        res.status(400).json(error);
        return;
      }
      const row = await prisma.routingEvalCase.create({
        data: {
          skillName: (body.skillName as string).trim(),
          skillScope: (body.skillScope as string).trim(),
          skillTeam: typeof body.skillTeam === "string" ? body.skillTeam.trim() : "",
          input: _toJsonInput(body.input),
          expected: _toJsonInput(body.expected),
          ...(typeof body.qualityBar === "number" ? { qualityBar: body.qualityBar } : {}),
        },
      });
      res.status(201).json(_toView(row));
    }
    catch (err) { next(err); }
  });

  /** Update an eval case by id (full replace of the mutable fields). */
  router.put("/:id", async function _update(req, res, next)
  {
    try
    {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const error = _validateWrite(body);
      if (error)
      {
        res.status(400).json(error);
        return;
      }
      const existing = await prisma.routingEvalCase.findUnique({ where: { id: req.params.id } });
      if (!existing)
      {
        res.status(404).json({ error: "Eval case not found", code: "NOT_FOUND" });
        return;
      }
      const row = await prisma.routingEvalCase.update({
        where: { id: req.params.id },
        data: {
          skillName: (body.skillName as string).trim(),
          skillScope: (body.skillScope as string).trim(),
          skillTeam: typeof body.skillTeam === "string" ? body.skillTeam.trim() : "",
          input: _toJsonInput(body.input),
          expected: _toJsonInput(body.expected),
          ...(typeof body.qualityBar === "number" ? { qualityBar: body.qualityBar } : {}),
        },
      });
      res.json(_toView(row));
    }
    catch (err) { next(err); }
  });

  /** Delete an eval case by id. */
  router.delete("/:id", async function _delete(req, res, next)
  {
    try
    {
      const existing = await prisma.routingEvalCase.findUnique({ where: { id: req.params.id } });
      if (!existing)
      {
        res.status(404).json({ error: "Eval case not found", code: "NOT_FOUND" });
        return;
      }
      await prisma.routingEvalCase.delete({ where: { id: req.params.id } });
      res.json({ id: req.params.id, status: "deleted" });
    }
    catch (err) { next(err); }
  });

  return router;
}
