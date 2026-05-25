import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { CreateTenantRequest, TenantDatasetsResponse, TenantResponse, UpdateTenantDatasetsRequest } from "../types.js";
import { _DetectTenantProjectionDrift } from "./internal/projection-drift.js";
import { _RepairTenantProjection } from "./internal/projection-repair.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "./internal/crd-constants.js";

/** Tenant CR appearance SLO constants. */
const TENANT_CR_APPEARANCE_TIMEOUT_MS = 30_000;
const TENANT_CR_APPEARANCE_POLL_INTERVAL_MS = 500;
const DEFAULT_COGNEE_PERMISSIONS_TIMEOUT_MS = 5000;

/**
 * Creates an Express router that exposes CRUD operations and
 * suspend/resume actions for Tenant custom resources.
 * Dual-writes to both K8s CRDs and PostgreSQL via Prisma.
 * @param customApi - Kubernetes custom objects API client
 * @param prisma - Prisma ORM client
 * @returns Configured Express Router
 */
export function tenantsRouter(customApi: k8s.CustomObjectsApi, prisma: PrismaClient): Router
{
  const router = Router();
  const namespace = process.env.NAMESPACE ?? "default";

  /**
   * Report detect-only drift between Tenant CRDs and PostgreSQL projection rows.
   */
  router.get("/drift", async function _getTenantProjectionDrift(req, res)
  {
    const report = await _DetectTenantProjectionDrift(customApi, prisma, namespace);
    res.json(report);
  });

  /**
   * Repair Tenant projection rows from CRD source of truth.
   * Defaults to dry-run; pass ?dryRun=false to apply writes.
   */
  router.post("/repair", async function _postTenantProjectionRepair(req, res)
  {
    const dryRun = req.query["dryRun"] !== "false";
    const report = await _RepairTenantProjection(customApi, prisma, namespace, dryRun);
    res.json(report);
  });

  /** List all tenants from the database. */
  router.get("/", async function _listTenants(req, res)
  {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
    });

    const response: TenantResponse[] = tenants.map(function _mapTenant(t)
    {
      return {
        name: t.name,
        displayName: t.displayName,
        email: t.email,
        team: t.team ?? undefined,
        phase: t.phase,
        ingressHost: t.ingressHost ?? undefined,
        createdAt: t.createdAt.toISOString(),
      };
    });

    res.json(response);
  });

  /** Get dataset memberships for a tenant from SQL projection storage. */
  router.get("/:name/datasets", async function _getTenantDatasets(req, res)
  {
    try
    {
      const tenant = await prisma.tenant.findUnique({
        where: { name: req.params.name },
        select: { name: true },
      });

      if (!tenant)
      {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }

      const memberships = await prisma.tenantDatasetMembership.findMany({
        where: { tenant: req.params.name },
        select: {
          scope: true,
          subject: true,
        },
      });
      const response: TenantDatasetsResponse = _BuildTenantDatasetMembershipResponse(memberships);
      res.json(response);
    }
    catch
    {
      res.status(502).json({ error: "Failed to load tenant datasets" });
    }
  });

  /** Update dataset memberships for a tenant and persist them in SQL projection storage. */
  router.put("/:name/datasets", async function _putTenantDatasets(req, res)
  {
    // 1. Validate body shape early so malformed requests never reach persistence mutation paths.
    const name = req.params.name;
    const body = req.body as Partial<UpdateTenantDatasetsRequest>;
    const membership = _ValidateTenantDatasetUpdate(body);

    if (!membership)
    {
      res.status(400).json({ error: "org, team, project, and personal must all be string arrays, and org may only contain 'default'" });
      return;
    }

    // 2. Ensure tenant exists before writing membership rows.
    try
    {
      const tenant = await prisma.tenant.findUnique({
        where: { name },
        select: { name: true },
      });
      if (!tenant)
      {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
    }
    catch
    {
      res.status(502).json({ error: "Failed to load tenant datasets" });
      return;
    }

    // 3. Push tenant scope-subject bindings to Cognee where IAM enforcement lives.
    try
    {
      await _ApplyTenantDatasetMembershipToCognee(name, membership, req.headers.authorization);
    }
    catch
    {
      res.status(502).json({ error: "Failed to apply tenant datasets in Cognee" });
      return;
    }

    // 4. Persist normalized dataset memberships in SQL projection storage.
    try
    {
      const projectionRows = _BuildTenantDatasetMembershipRows(name, membership);
      await prisma.$transaction([
        prisma.tenantDatasetMembership.deleteMany({ where: { tenant: name } }),
        prisma.tenantDatasetMembership.createMany({
          data: projectionRows,
          skipDuplicates: true,
        }),
      ]);
    }
    catch
    {
      res.status(502).json({ error: "Failed to persist tenant datasets" });
      return;
    }

    // 5. Write audit metadata as best effort because the authoritative apply already succeeded.
    try
    {
      await prisma.auditEntry.create({
        data: {
          tenant: name,
          action: "DatasetsUpdated",
          resource: `Tenant/${name}`,
          message: `Dataset memberships updated for tenant ${name}`,
          metadata: membership as unknown as Prisma.InputJsonValue,
        },
      });
    }
    catch
    {
      // Best-effort audit write: dataset membership changes are already persisted in SQL.
    }

    res.json(membership);
  });

  /** Get a single tenant by name. */
  router.get("/:name", async function _getTenant(req, res)
  {
    const tenant = await prisma.tenant.findUnique({
      where: { name: req.params.name },
    });

    if (!tenant)
    {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const response: TenantResponse = {
      name: tenant.name,
      displayName: tenant.displayName,
      email: tenant.email,
      team: tenant.team ?? undefined,
      phase: tenant.phase,
      ingressHost: tenant.ingressHost ?? undefined,
      createdAt: tenant.createdAt.toISOString(),
    };

    res.json(response);
  });

  /** Create a new tenant (dual-write: K8s CRD + database). */
  router.post("/", async function _createTenant(req, res)
  {
    const body = req.body as CreateTenantRequest;

    const tenantCr = {
      apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
      kind: "Tenant",
      metadata: { name: body.name, namespace },
      spec: {
        displayName: body.displayName,
        email: body.email,
        team: body.team,
        monthlyBudgetUsd: body.monthlyBudgetUsd,
        resources: body.resources,
        skills: body.skills,
        policyRef: body.policyRef,
      },
    };

    await customApi.createNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: TENANT_CRD_PLURAL,
      body: tenantCr,
    });

    let tenantAppeared = false;
    try
    {
      tenantAppeared = await _WaitForTenantCrAppearance(
        customApi,
        body.name,
        namespace,
        _ReadPositiveIntEnv("TENANT_CR_APPEARANCE_TIMEOUT_MS", TENANT_CR_APPEARANCE_TIMEOUT_MS),
        _ReadPositiveIntEnv("TENANT_CR_APPEARANCE_POLL_INTERVAL_MS", TENANT_CR_APPEARANCE_POLL_INTERVAL_MS),
      );
    }
    catch
    {
      res.status(502).json({ error: "Failed to validate Tenant CR appearance in Kubernetes" });
      return;
    }

    if (!tenantAppeared)
    {
      res.status(504).json({ error: "Tenant CR did not appear in Kubernetes within 30 seconds" });
      return;
    }

    await prisma.tenant.create({
      data: {
        name: body.name,
        displayName: body.displayName,
        email: body.email,
        team: body.team,
      },
    });

    await prisma.auditEntry.create({
      data: {
        tenant: body.name,
        action: "Created",
        resource: `Tenant/${body.name}`,
        message: `Tenant ${body.name} created`,
      },
    });

    res.status(201).json({ name: body.name, status: "created" });
  });

  /** Update a tenant (dual-write: K8s CRD + database). */
  router.put("/:name", async function _updateTenant(req, res)
  {
    const name = req.params.name;
    const body = req.body as Partial<CreateTenantRequest>;

    const patch = {
      spec: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.team ? { team: body.team } : {}),
        ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: body.monthlyBudgetUsd } : {}),
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.skills ? { skills: body.skills } : {}),
        ...(body.policyRef ? { policyRef: body.policyRef } : {}),
      },
    };

    await customApi.patchNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: TENANT_CRD_PLURAL,
      name,
      body: patch,
    });

    await prisma.tenant.update({
      where: { name },
      data: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.team ? { team: body.team } : {}),
      },
    });

    await prisma.auditEntry.create({
      data: {
        tenant: name,
        action: "Updated",
        resource: `Tenant/${name}`,
        message: `Tenant ${name} updated`,
      },
    });

    res.json({ name, status: "updated" });
  });

  /** Delete a tenant (dual-write: K8s CRD + database). */
  router.delete("/:name", async function _deleteTenant(req, res)
  {
    const name = req.params.name;

    await customApi.deleteNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: TENANT_CRD_PLURAL,
      name,
    });

    await prisma.auditEntry.create({
      data: {
        tenant: name,
        action: "Deleted",
        resource: `Tenant/${name}`,
        message: `Tenant ${name} deleted`,
      },
    });

    await prisma.tenant.delete({ where: { name } });

    res.json({ name, status: "deleted" });
  });

  /** Suspend a tenant (scale deployment to zero). */
  router.post("/:name/suspend", async function _suspendTenant(req, res)
  {
    const name = req.params.name;

    await customApi.patchNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: TENANT_CRD_PLURAL,
      name,
      body: { spec: { suspended: true } },
    });

    await prisma.tenant.update({
      where: { name },
      data: { phase: "Suspended" },
    });

    await prisma.auditEntry.create({
      data: {
        tenant: name,
        action: "Suspended",
        resource: `Tenant/${name}`,
        message: `Tenant ${name} suspended`,
      },
    });

    res.json({ name, status: "suspended" });
  });

  /** Resume a suspended tenant. */
  router.post("/:name/resume", async function _resumeTenant(req, res)
  {
    const name = req.params.name;

    await customApi.patchNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: TENANT_CRD_PLURAL,
      name,
      body: { spec: { suspended: false } },
    });

    await prisma.tenant.update({
      where: { name },
      data: { phase: "Running" },
    });

    await prisma.auditEntry.create({
      data: {
        tenant: name,
        action: "Resumed",
        resource: `Tenant/${name}`,
        message: `Tenant ${name} resumed`,
      },
    });

    res.json({ name, status: "resumed" });
  });

  return router;
}

/**
 * Validate and normalize a tenant dataset membership update payload.
 * @param body - Raw request body.
 */
function _ValidateTenantDatasetUpdate(body: Partial<UpdateTenantDatasetsRequest>): UpdateTenantDatasetsRequest | null
{
  if (!Array.isArray(body.org) || !Array.isArray(body.team) || !Array.isArray(body.project) || !Array.isArray(body.personal))
  {
    return null;
  }

  if (!_IsStringArray(body.org) || !_IsStringArray(body.team) || !_IsStringArray(body.project) || !_IsStringArray(body.personal))
  {
    return null;
  }

  const org = _NormalizeSubjectList(body.org);
  if (org.length > 0 && (org.length !== 1 || org[0] !== "default"))
  {
    return null;
  }

  return {
    org: ["default"],
    team: _NormalizeSubjectList(body.team),
    project: _NormalizeSubjectList(body.project),
    personal: _NormalizeSubjectList(body.personal),
  };
}

/**
 * Check whether every element in the provided array is a string.
 * @param value - Candidate value.
 */
function _IsStringArray(value: unknown[]): value is string[]
{
  return value.every(function _isString(entry)
  {
    return typeof entry === "string";
  });
}

/**
 * Check whether an unknown Kubernetes client error represents a not-found response.
 * @param error - Unknown thrown error from Kubernetes client calls.
 */
function _IsKubernetesNotFoundError(error: unknown): boolean
{
  if (typeof error !== "object" || error === null)
  {
    return false;
  }

  const errorObject = error as {
    statusCode?: number;
    response?: { statusCode?: number };
    body?: { code?: number };
  };
  const statusCode = errorObject.statusCode ?? errorObject.response?.statusCode ?? errorObject.body?.code;
  return statusCode === 404;
}

/**
 * Wait until a newly-created tenant becomes observable as a Tenant CR.
 * @param customApi - Kubernetes custom objects API client.
 * @param tenantName - Tenant resource name.
 * @param namespace - Kubernetes namespace.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param pollIntervalMs - Polling interval in milliseconds.
 */
async function _WaitForTenantCrAppearance(
  customApi: k8s.CustomObjectsApi,
  tenantName: string,
  namespace: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean>
{
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline)
  {
    try
    {
      await customApi.getNamespacedCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        namespace,
        plural: TENANT_CRD_PLURAL,
        name: tenantName,
      });

      return true;
    }
    catch (error)
    {
      if (!_IsKubernetesNotFoundError(error))
      {
        throw error;
      }
    }

    await _Sleep(pollIntervalMs);
  }

  return false;
}

/**
 * Parse positive integer env vars with fallback values.
 * @param key - Environment variable name.
 * @param fallback - Fallback value.
 */
function _ReadPositiveIntEnv(key: string, fallback: number): number
{
  const raw = process.env[key];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Sleep for the provided duration.
 * @param durationMs - Duration in milliseconds.
 */
async function _Sleep(durationMs: number): Promise<void>
{
  await new Promise(function _resolveAfterSleep(resolve)
  {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Default dataset membership used when a tenant has no explicit SQL row yet.
 */
function _DefaultTenantDatasetMembership(): TenantDatasetsResponse
{
  return {
    org: ["default"],
    team: [],
    project: [],
    personal: [],
  };
}

/**
 * Normalize subject values by trimming empties and removing duplicates.
 * @param values - Raw subject values from API payloads.
 */
function _NormalizeSubjectList(values: string[]): string[]
{
  const normalized = values.map(function _trim(value)
  {
    return value.trim();
  }).filter(function _isNonEmpty(value)
  {
    return value.length > 0;
  });
  return Array.from(new Set(normalized)).sort();
}

/**
 * Build SQL projection rows from API membership payloads.
 * @param tenant - Tenant name.
 * @param membership - Normalized membership payload.
 */
function _BuildTenantDatasetMembershipRows(tenant: string, membership: TenantDatasetsResponse): Array<{
  tenant: string;
  scope: "Org" | "Team" | "Project" | "Personal";
  subject: string;
}>
{
  return [
    ...membership.org.map(function _mapOrg(subject)
    {
      return { tenant, scope: "Org" as const, subject };
    }),
    ...membership.team.map(function _mapTeam(subject)
    {
      return { tenant, scope: "Team" as const, subject };
    }),
    ...membership.project.map(function _mapProject(subject)
    {
      return { tenant, scope: "Project" as const, subject };
    }),
    ...membership.personal.map(function _mapPersonal(subject)
    {
      return { tenant, scope: "Personal" as const, subject };
    }),
  ];
}

/**
 * Build API dataset response shape from SQL projection rows.
 * @param memberships - SQL projection rows for a tenant.
 */
function _BuildTenantDatasetMembershipResponse(memberships: Array<{
  scope: "Org" | "Team" | "Project" | "Personal";
  subject: string;
}>): TenantDatasetsResponse
{
  const response = _DefaultTenantDatasetMembership();

  for (const membership of memberships)
  {
    if (membership.scope === "Org")
    {
      response.org = ["default"];
    }
    else if (membership.scope === "Team")
    {
      response.team.push(membership.subject);
    }
    else if (membership.scope === "Project")
    {
      response.project.push(membership.subject);
    }
    else
    {
      response.personal.push(membership.subject);
    }
  }

  response.team = _NormalizeSubjectList(response.team);
  response.project = _NormalizeSubjectList(response.project);
  response.personal = _NormalizeSubjectList(response.personal);
  return response;
}

/**
 * Apply tenant subject memberships to Cognee so IAM enforcement remains centralized there.
 * @param tenant - Tenant name.
 * @param membership - Normalized membership payload.
 * @param authorization - Optional inbound authorization header.
 */
async function _ApplyTenantDatasetMembershipToCognee(
  tenant: string,
  membership: TenantDatasetsResponse,
  authorization: string | string[] | undefined,
): Promise<void>
{
  const timeoutMs = _ReadPositiveIntEnv("COGNEE_PERMISSIONS_TIMEOUT_MS", DEFAULT_COGNEE_PERMISSIONS_TIMEOUT_MS);
  const response = await fetch(_BuildCogneePermissionsUrl(`/v1/permissions/tenants/${encodeURIComponent(tenant)}/subjects`), {
    method: "PUT",
    headers: _BuildCogneePermissionsHeaders(tenant, authorization),
    body: JSON.stringify({
      subjects: [
        ...membership.org.map(function _mapOrg(subject)
        {
          return { scope: "org", subject };
        }),
        ...membership.team.map(function _mapTeam(subject)
        {
          return { scope: "team", subject };
        }),
        ...membership.project.map(function _mapProject(subject)
        {
          return { scope: "project", subject };
        }),
        ...membership.personal.map(function _mapPersonal(subject)
        {
          return { scope: "personal", subject };
        }),
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok)
  {
    throw new Error(`Cognee permission sync failed with status ${response.status}`);
  }
}

/**
 * Build Cognee permissions endpoint URL.
 * @param path - API path suffix.
 */
function _BuildCogneePermissionsUrl(path: string): string
{
  const endpoint = process.env.COGNEE_ENDPOINT?.trim();
  if (!endpoint)
  {
    throw new Error("COGNEE_ENDPOINT is required for Cognee permissions sync");
  }
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}

/**
 * Build headers for Cognee permission sync calls.
 * @param tenant - Tenant being synchronized.
 * @param authorization - Optional incoming authorization header value.
 */
function _BuildCogneePermissionsHeaders(
  tenant: string,
  authorization: string | string[] | undefined,
): Record<string, string>
{
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cognee-tenant-id": tenant,
    "x-opencrane-sync-source": "control-plane",
  };
  if (typeof authorization === "string" && authorization.length > 0)
  {
    headers.authorization = authorization;
  }
  return headers;
}
