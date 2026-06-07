import { Router } from "express";
import type { Grant, SkillBundle, SkillPromotion } from "@opencrane/contracts";
import type { PrismaClient } from "@prisma/client";

import type { SkillBundleWriteRequest, SkillEntitlementInput } from "./skill-catalog.types.js";

/**
 * CRUD router for the registry-backed Phase 4 skill catalog.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function skillCatalogRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all skill bundles with entitlements and promotion history. */
  router.get("/", async function _listSkillBundles(req, res)
  {
    const bundles = await (prisma as unknown as {
      skillBundle: {
        findMany: (args: { orderBy: { createdAt: "desc" }; include: { entitlements: true; promotions: true; source: true } }) => Promise<Array<Record<string, unknown>>>;
      };
    }).skillBundle.findMany({
      orderBy: { createdAt: "desc" },
      include: { entitlements: true, promotions: true, source: true },
    });

    res.json(bundles.map(function _mapBundle(bundle)
    {
      return _MapSkillBundle(bundle);
    }));
  });

  /** Get a single skill bundle by identifier. */
  router.get("/:id", async function _getSkillBundle(req, res)
  {
    const bundle = await (prisma as unknown as {
      skillBundle: {
        findUnique: (args: { where: { id: string }; include: { entitlements: true; promotions: true; source: true } }) => Promise<Record<string, unknown> | null>;
      };
    }).skillBundle.findUnique({
      where: { id: req.params.id },
      include: { entitlements: true, promotions: true, source: true },
    });

    if (!bundle)
    {
      res.status(404).json({ error: "Skill bundle not found", code: "SKILL_BUNDLE_NOT_FOUND" });
      return;
    }

    res.json(_MapSkillBundle(bundle));
  });

  /** Create a new skill bundle plus generic entitlement grant rows. */
  router.post("/", async function _createSkillBundle(req, res)
  {
    const body = req.body as SkillBundleWriteRequest;
    const createdBundle = await (prisma as unknown as {
      skillBundle: {
        create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; name: string }>;
      };
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).skillBundle.create({
      data: {
        name: body.name,
        description: body.description ?? "",
        version: body.version,
        digest: body.digest,
        scope: body.scope,
        status: body.status ?? "draft",
        tags: _NormalizeStringArray(body.tags),
        ...(body.sourceId ? { sourceId: body.sourceId } : {}),
        ...(body.publishedAt ? { publishedAt: new Date(body.publishedAt) } : {}),
      },
    });

    await _WriteSkillBundleChildren(prisma, createdBundle.id, body);
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Created",
        resource: `SkillBundle/${createdBundle.id}`,
        message: `Skill bundle ${createdBundle.name} created`,
      },
    });

    res.status(201).json({ id: createdBundle.id, status: "created" });
  });

  /** Update a skill bundle and fully replace entitlements and promotion history. */
  router.put("/:id", async function _updateSkillBundle(req, res)
  {
    const body = req.body as Partial<SkillBundleWriteRequest>;
    await (prisma as unknown as {
      skillBundle: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).skillBundle.update({
      where: { id: req.params.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? "" } : {}),
        ...(body.version ? { version: body.version } : {}),
        ...(body.digest ? { digest: body.digest } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.tags ? { tags: _NormalizeStringArray(body.tags) } : {}),
        ...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
        ...(body.publishedAt !== undefined ? { publishedAt: body.publishedAt ? new Date(body.publishedAt) : null } : {}),
      },
    });

    await _DeleteSkillBundleChildren(prisma, req.params.id);
    await _WriteSkillBundleChildren(prisma, req.params.id, body);
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Updated",
        resource: `SkillBundle/${req.params.id}`,
        message: `Skill bundle ${req.params.id} updated`,
      },
    });

    res.json({ id: req.params.id, status: "updated" });
  });

  /** Delete a skill bundle and its linked entitlement grants. */
  router.delete("/:id", async function _deleteSkillBundle(req, res)
  {
    await _DeleteSkillBundleChildren(prisma, req.params.id);
    await (prisma as unknown as {
      skillBundle: { delete: (args: { where: { id: string } }) => Promise<unknown> };
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).skillBundle.delete({ where: { id: req.params.id } });
    await (prisma as unknown as {
      auditEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).auditEntry.create({
      data: {
        action: "Deleted",
        resource: `SkillBundle/${req.params.id}`,
        message: `Skill bundle ${req.params.id} deleted`,
      },
    });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}

/**
 * Write child entitlement and promotion rows for a skill bundle.
 *
 * @param prisma - Prisma client used for persistence.
 * @param bundleId - Skill bundle identifier.
 * @param body - Route payload containing entitlements and promotions.
 */
async function _WriteSkillBundleChildren(prisma: PrismaClient, bundleId: string, body: Partial<SkillBundleWriteRequest>): Promise<void>
{
  if (body.promotions && body.promotions.length > 0)
  {
    await (prisma as unknown as {
      skillPromotion: { createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown> };
    }).skillPromotion.createMany({
      data: body.promotions.map(function _mapPromotion(promotion)
      {
        return {
          skillBundleId: bundleId,
          fromScope: promotion.fromScope,
          toScope: promotion.toScope,
          promotedBy: promotion.promotedBy,
          status: promotion.status ?? "proposed",
          notes: promotion.notes,
        };
      }),
    });
  }

  if (!body.grants || body.grants.length === 0)
  {
    return;
  }

  const entitlementRows: Array<Record<string, unknown>> = [];
  for (const grant of body.grants)
  {
    const genericGrant = await (prisma as unknown as {
      grant: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
    }).grant.create({
      data: {
        payloadType: "skill-bundle",
        payloadId: bundleId,
        scope: grant.scope,
        subjectType: grant.subjectType,
        subjectId: _ResolveGrantSubjectId(grant),
        access: grant.access,
        priority: grant.priority ?? 0,
        note: grant.note,
        ...(grant.subjectType === "group" ? { groupId: _ResolveGrantSubjectId(grant) } : {}),
        skillBundleId: bundleId,
      },
    });
    entitlementRows.push({
      skillBundleId: bundleId,
      grantId: genericGrant.id,
      scope: grant.scope,
      subjectType: grant.subjectType,
      subjectId: _ResolveGrantSubjectId(grant),
      access: grant.access,
      priority: grant.priority ?? 0,
      note: grant.note,
      ...(grant.subjectType === "group" ? { groupId: _ResolveGrantSubjectId(grant) } : {}),
    });
  }

  await (prisma as unknown as {
    skillEntitlement: { createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown> };
  }).skillEntitlement.createMany({ data: entitlementRows });
}

/**
 * Delete child entitlement and promotion rows for a skill bundle.
 *
 * @param prisma - Prisma client used for persistence.
 * @param bundleId - Skill bundle identifier.
 */
async function _DeleteSkillBundleChildren(prisma: PrismaClient, bundleId: string): Promise<void>
{
  await (prisma as unknown as {
    skillEntitlement: { deleteMany: (args: { where: { skillBundleId: string } }) => Promise<unknown> };
    skillPromotion: { deleteMany: (args: { where: { skillBundleId: string } }) => Promise<unknown> };
    grant: { deleteMany: (args: { where: { skillBundleId: string; payloadType: "skill-bundle" } }) => Promise<unknown> };
  }).skillEntitlement.deleteMany({ where: { skillBundleId: bundleId } });
  await (prisma as unknown as {
    skillPromotion: { deleteMany: (args: { where: { skillBundleId: string } }) => Promise<unknown> };
  }).skillPromotion.deleteMany({ where: { skillBundleId: bundleId } });
  await (prisma as unknown as {
    grant: { deleteMany: (args: { where: { skillBundleId: string; payloadType: "skill-bundle" } }) => Promise<unknown> };
  }).grant.deleteMany({ where: { skillBundleId: bundleId, payloadType: "skill-bundle" } });
}

/**
 * Map a raw skill bundle record to the UI response shape.
 *
 * @param bundle - Raw persisted bundle record.
 * @returns JSON response payload.
 */
function _MapSkillBundle(bundle: Record<string, unknown>): SkillBundle
{
  const source = bundle.source as { name?: string } | null | undefined;
  const entitlements = Array.isArray(bundle.entitlements) ? bundle.entitlements as Array<Record<string, unknown>> : [];
  const promotions = Array.isArray(bundle.promotions) ? bundle.promotions as Array<Record<string, unknown>> : [];

  return {
    id: String(bundle.id),
    name: String(bundle.name),
    description: String(bundle.description),
    version: String(bundle.version),
    digest: String(bundle.digest),
    scope: String(bundle.scope).toLowerCase() as SkillBundle["scope"],
    status: String(bundle.status).toLowerCase() as SkillBundle["status"],
    tags: Array.isArray(bundle.tags) ? bundle.tags : [],
    sourceName: source?.name,
    publishedAt: bundle.publishedAt instanceof Date ? bundle.publishedAt.toISOString() : undefined,
    grants: entitlements.map(function _mapGrant(grant): Grant
    {
      return {
        id: String(grant.id),
        scope: String(grant.scope).toLowerCase() as Grant["scope"],
        subjectType: String(grant.subjectType).toLowerCase() as Grant["subjectType"],
        subjectId: String(grant.subjectId),
        subjectName: String(grant.subjectId),
        access: String(grant.access).toLowerCase() as Grant["access"],
        note: typeof grant.note === "string" ? grant.note : undefined,
      };
    }),
    promotions: promotions.map(function _mapPromotion(promotion): SkillPromotion
    {
      return {
        id: String(promotion.id),
        fromScope: String(promotion.fromScope).toLowerCase() as SkillPromotion["fromScope"],
        toScope: String(promotion.toScope).toLowerCase() as SkillPromotion["toScope"],
        promotedBy: String(promotion.promotedBy),
        status: String(promotion.status).toLowerCase() as SkillPromotion["status"],
        notes: typeof promotion.notes === "string" ? promotion.notes : undefined,
      };
    }),
  };
}

/**
 * Normalize tags into a unique trimmed string array.
 *
 * @param values - Raw request values.
 * @returns Normalized string array.
 */
function _NormalizeStringArray(values: string[] | undefined): string[]
{
  if (!values)
  {
    return [];
  }

  return Array.from(new Set(values.map(function _trim(value)
  {
    return value.trim();
  }).filter(function _isNonEmpty(value)
  {
    return value.length > 0;
  })));
}

/**
 * Resolve the compiler-facing subject identifier from route input.
 *
 * @param grant - Raw entitlement payload.
 * @returns Stable subject identifier.
 */
function _ResolveGrantSubjectId(grant: SkillEntitlementInput): string
{
  return grant.subjectId ?? grant.subjectName;
}
