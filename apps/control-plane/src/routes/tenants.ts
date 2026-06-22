import { createHash } from "node:crypto";

import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";

import { compile } from "../core/grants/grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "../core/grants/grant-compiler.types.js";
import { _CutTenant } from "../core/connections/cut-tenant.js";
import type { OpenClawGatewayAdmin } from "../core/connections/gateway-admin.types.js";

import type { CreateTenantRequest, TenantDatasetsResponse, TenantResponse, UpdateTenantDatasetsRequest } from "../types.js";
import type { EffectiveContractResponse } from "./tenants.types.js";
import { _DetectTenantProjectionDrift } from "./internal/projection-drift.js";
import { _RepairTenantProjection } from "./internal/projection-repair.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "../shared/crd-constants.js";

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
 * @param coreApi - Kubernetes Core V1 API client (pod force-disconnect for the kill-switch)
 * @param gatewayAdmin - OpenClaw gateway revoke client for the connection kill-switch (CONN.5)
 * @returns Configured Express Router
 */
export function tenantsRouter(customApi: k8s.CustomObjectsApi, prisma: PrismaClient, coreApi: k8s.CoreV1Api, gatewayAdmin: OpenClawGatewayAdmin): Router
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

  /**
   * List all tenants from the database, optionally narrowed to a single parent
   * ClusterTenant via `?clusterTenantRef=<name>` so a federated frontend filters
   * server-side instead of mapping `team` → ref and filtering client-side.
   */
  router.get("/", async function _listTenants(req, res)
  {
    const clusterTenantRef = typeof req.query.clusterTenantRef === "string" ? req.query.clusterTenantRef.trim() : "";

    const tenants = await prisma.tenant.findMany({
      ...(clusterTenantRef ? { where: { clusterTenantRef } } : {}),
      orderBy: { createdAt: "desc" },
    });

    const response: TenantResponse[] = tenants.map(function _mapTenant(t)
    {
      return {
        name: t.name,
        displayName: t.displayName,
        email: t.email,
        team: t.team ?? undefined,
        clusterTenantRef: t.clusterTenantRef ?? undefined,
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
        res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
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
      res.status(502).json({ error: "Failed to load tenant datasets", code: "UPSTREAM_ERROR" });
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
      res.status(400).json({ error: "org, team, project, and personal must all be string arrays, and org may only contain 'default'", code: "VALIDATION_ERROR" });
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
        res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
        return;
      }
    }
    catch
    {
      res.status(502).json({ error: "Failed to load tenant datasets", code: "UPSTREAM_ERROR" });
      return;
    }

    // 3. Push tenant scope-subject bindings to Cognee where IAM enforcement lives.
    try
    {
      await _ApplyTenantDatasetMembershipToCognee(name, membership, req.headers.authorization);
    }
    catch
    {
      res.status(502).json({ error: "Failed to apply tenant datasets in Cognee", code: "UPSTREAM_ERROR" });
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
      res.status(502).json({ error: "Failed to persist tenant datasets", code: "UPSTREAM_ERROR" });
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

  /** Compile the effective awareness, MCP, and skill contract for a tenant. */
  router.get("/:name/effective-contract", async function _getEffectiveContract(req, res)
  {
    const tenant = await prisma.tenant.findUnique({
      where: { name: req.params.name },
      select: {
        name: true,
        team: true,
      },
    });

    if (!tenant)
    {
      res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
      return;
    }

    const memberships = await prisma.tenantDatasetMembership.findMany({
      where: { tenant: req.params.name },
      select: {
        scope: true,
        subject: true,
      },
    });
    const awarenessMemberships = _BuildTenantDatasetMembershipResponse(memberships);
    const awarenessDecisions = await compile(req.params.name, GrantCompilerPayloadType.Awareness, prisma);
    const mcpDecisions = await compile(req.params.name, GrantCompilerPayloadType.McpServer, prisma);
    const allowedMcpIds = mcpDecisions.filter(function _isAllowed(decision)
    {
      return decision.access === GrantCompilerAccess.Allow;
    }).map(function _mapDecision(decision)
    {
      return decision.payloadId;
    });
    const allowedSkillIds = (await compile(req.params.name, GrantCompilerPayloadType.SkillBundle, prisma)).filter(function _isAllowed(decision)
    {
      return decision.access === GrantCompilerAccess.Allow;
    }).map(function _mapDecision(decision)
    {
      return decision.payloadId;
    });
    const mcpServers = allowedMcpIds.length > 0
      ? await (prisma as unknown as {
          mcpServer: {
            findMany: (args: { where: { id: { in: string[] } }; orderBy: { name: "asc" } }) => Promise<Array<{
              id: string;
              name: string;
              endpoint: string;
              transport: string;
            }>>;
          };
        }).mcpServer.findMany({
          where: { id: { in: allowedMcpIds } },
          orderBy: { name: "asc" },
        })
      : [];
    const skillBundles = allowedSkillIds.length > 0
      ? await (prisma as unknown as {
          skillBundle: {
            findMany: (args: { where: { id: { in: string[] } }; orderBy: { name: "asc" } }) => Promise<Array<{
              id: string;
              name: string;
              scope: string;
              version: string;
              digest: string;
            }>>;
          };
        }).skillBundle.findMany({
          where: { id: { in: allowedSkillIds } },
          orderBy: { name: "asc" },
        })
      : [];
    const contractWithoutId: Omit<EffectiveContractResponse, "contractId"> = {
      contractVersion: "4.0.0",
      tenant: {
        name: tenant.name,
        team: tenant.team ?? null,
        policyRef: null,
      },
      awareness: {
        citationFormat: "inline",
        memberships: awarenessMemberships,
        grants: awarenessDecisions.map(function _mapDecision(decision)
        {
          return {
            payloadId: decision.payloadId,
            access: decision.access,
          };
        }),
      },
      mcp: {
        gateway: process.env.MCP_GATEWAY_URL ?? "http://obot-gateway.opencrane-system.svc:8080",
        servers: mcpServers.map(function _mapServer(server)
        {
          return {
            id: server.id,
            name: server.name,
            transport: _NormalizeTransport(server.transport),
            endpoint: server.endpoint,
          };
        }),
      },
      skills: {
        registry: process.env.SKILL_REGISTRY_URL ?? "http://skill-registry.opencrane-system.svc:5000",
        entitled: skillBundles.map(function _mapBundle(bundle)
        {
          return {
            id: bundle.id,
            name: bundle.name,
            scope: String(bundle.scope).toLowerCase(),
            version: bundle.version,
            digest: bundle.digest,
          };
        }),
      },
    };
    const contractId = createHash("sha256").update(_StableStringify(contractWithoutId)).digest("hex");
    const response: EffectiveContractResponse = {
      ...contractWithoutId,
      contractId,
    };

    res.json(response);
  });

  /** Get a single tenant by name. */
  router.get("/:name", async function _getTenant(req, res)
  {
    const tenant = await prisma.tenant.findUnique({
      where: { name: req.params.name },
    });

    if (!tenant)
    {
      res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
      return;
    }

    const response: TenantResponse = {
      name: tenant.name,
      displayName: tenant.displayName,
      email: tenant.email,
      team: tenant.team ?? undefined,
      clusterTenantRef: tenant.clusterTenantRef ?? undefined,
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
        clusterTenantRef: body.clusterTenantRef,
        monthlyBudgetUsd: body.monthlyBudgetUsd,
        resources: body.resources,
        skillAllowlist: body.skillAllowlist,
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
      res.status(502).json({ error: "Failed to validate Tenant CR appearance in Kubernetes", code: "UPSTREAM_ERROR" });
      return;
    }

    if (!tenantAppeared)
    {
      res.status(504).json({ error: "Tenant CR did not appear in Kubernetes within 30 seconds", code: "TIMEOUT" });
      return;
    }

    await prisma.tenant.create({
      data: {
        name: body.name,
        displayName: body.displayName,
        email: body.email,
        team: body.team,
        clusterTenantRef: body.clusterTenantRef,
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

    // Normalise the parent ClusterTenant ref so a present-but-empty value clears
    // it (stored null, field deleted from the CRD spec via merge-patch), mirroring
    // how vanityDomain is cleared on cluster-tenants. Absent → field left untouched.
    const clusterTenantRefProvided = body.clusterTenantRef !== undefined;
    const normalizedClusterTenantRef = clusterTenantRefProvided && body.clusterTenantRef!.trim() ? body.clusterTenantRef!.trim() : null;

    const patch = {
      spec: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.team ? { team: body.team } : {}),
        ...(clusterTenantRefProvided ? { clusterTenantRef: normalizedClusterTenantRef } : {}),
        ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: body.monthlyBudgetUsd } : {}),
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.skillAllowlist ? { skillAllowlist: body.skillAllowlist } : {}),
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
    }, k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch));

    await prisma.tenant.update({
      where: { name },
      data: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.team ? { team: body.team } : {}),
        ...(clusterTenantRefProvided ? { clusterTenantRef: normalizedClusterTenantRef } : {}),
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
    }, k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch));

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
    }, k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch));

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

  /**
   * Set a tenant's OpenClaw gateway URL override (CONN.3).
   *
   * The provisioner (or an admin) writes the pod's `wss://` gateway URL into
   * `configOverrides.openclaw`; `_ResolveOpenClawPairing` reads it back when the
   * browser brokers a connection (otherwise the URL is derived from the ingress
   * host). Under trusted-proxy gateway auth (CONN.4) the gateway needs no bootstrap
   * token, so none is accepted or stored — only the connection URL.
   *
   * Security: only ever stores a `wss://` gateway URL (never downgrades the transport).
   */
  router.put("/:name/pairing", async function _setTenantPairing(req, res, next)
  {
    try
    {
      const name = req.params.name;
      const gatewayUrl = typeof req.body?.gatewayUrl === "string" ? req.body.gatewayUrl.trim() : "";

      // 1. Validate inputs — a `wss://` gateway URL is required so we never persist
      //    a transport downgrade (trusted-proxy auth needs no bootstrap token).
      if (gatewayUrl.length === 0)
      {
        res.status(400).json({ error: "gatewayUrl is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (!gatewayUrl.startsWith("wss://"))
      {
        res.status(400).json({ error: "gatewayUrl must be a wss:// URL", code: "VALIDATION_ERROR" });
        return;
      }

      // 2. Merge into the existing configOverrides.openclaw block so unrelated
      //    overrides are preserved.
      const tenant = await prisma.tenant.findUnique({ where: { name }, select: { configOverrides: true } });
      if (!tenant)
      {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
        return;
      }

      const existing = (tenant.configOverrides ?? {}) as Record<string, unknown>;
      const existingOpenclaw = (typeof existing.openclaw === "object" && existing.openclaw !== null ? { ...existing.openclaw } : {}) as Record<string, unknown>;
      const mergedOpenclaw: Record<string, unknown> = { ...existingOpenclaw, gatewayUrl };

      // 3. Persist the gateway URL and audit the change.
      await prisma.tenant.update({
        where: { name },
        data: { configOverrides: { ...existing, openclaw: mergedOpenclaw } as Prisma.InputJsonValue },
      });

      await prisma.auditEntry.create({
        data: {
          tenant: name,
          action: "GatewayUrlSet",
          resource: `Tenant/${name}`,
          message: `OpenClaw gateway URL set for ${name} (${gatewayUrl})`,
        },
      });

      res.json({ name, gatewayUrl });
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Cut a tenant — the admin connection kill-switch (CONN.5).
   *
   * Revokes every brokered OpenClaw connection for the tenant (gateway revoke +
   * registry mark) and force-deletes the pod so live WebSockets are severed
   * immediately. Distinct from suspend: suspend scales to zero for cost/idle,
   * cut is a security action that also blocks re-auth of the cut credentials.
   */
  router.post("/:name/cut", async function _cutTenant(req, res, next)
  {
    try
    {
      const name = req.params.name;
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

      // 1. Run the kill-switch: gateway revoke (best-effort) + registry revoke +
      //    pod force-delete. No subject → full-tenant cut.
      const result = await _CutTenant(coreApi, prisma, gatewayAdmin, { tenant: name, namespace, reason });

      // 2. Audit the security action so the cut is attributable after the fact.
      await prisma.auditEntry.create({
        data: {
          tenant: name,
          action: "Cut",
          resource: `Tenant/${name}`,
          message: `Tenant ${name} cut: ${result.revokedDevices} connection(s) revoked, pod force-deleted=${result.podForceDeleted}${reason ? ` (${reason})` : ""}`,
        },
      });

      res.json({ name, status: "cut", ...result });
    }
    catch (err)
    {
      next(err);
    }
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

/**
 * Normalize Prisma transport enum output into the contract wire format.
 * @param transport - Raw transport enum value.
 */
function _NormalizeTransport(transport: string): string
{
  return transport
    .replace("StreamableHttp", "streamable-http")
    .replace("ServerSentEvents", "sse")
    .replace("WebSocket", "websocket")
    .toLowerCase();
}

/**
 * Produce a stable JSON string so contract hashes remain deterministic.
 * @param value - Arbitrary contract payload.
 */
function _StableStringify(value: unknown): string
{
  return JSON.stringify(_SortJsonValue(value));
}

/**
 * Recursively sort JSON objects and arrays for deterministic hashing.
 * @param value - Arbitrary JSON-like value.
 */
function _SortJsonValue(value: unknown): unknown
{
  if (Array.isArray(value))
  {
    return value.map(function _mapValue(entry)
    {
      return _SortJsonValue(entry);
    });
  }

  if (typeof value !== "object" || value === null)
  {
    return value;
  }

  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>(function _reduce(sorted, key)
  {
    sorted[key] = _SortJsonValue((value as Record<string, unknown>)[key]);
    return sorted;
  }, {});
}
