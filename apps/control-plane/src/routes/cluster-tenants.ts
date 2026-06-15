import { Router } from "express";
import { ClusterTenantPhase, ClusterTenantTierUnavailableCode } from "@opencrane/contracts";
import type { ClusterTenantProvisionerRegistry } from "@opencrane/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { ClusterTenantCreateRequest, ClusterTenantUpdateRequest } from "./cluster-tenants.models.js";
import { _IsIsolationTier, _ToContract, _ToPrismaCompute, _ToPrismaTier, _ValidateCompute, _ValidateResources } from "./cluster-tenants.service.js";

/**
 * CRUD router for the first-class cluster tenant (customer / isolation unit).
 *
 * Over-tier requests — an `isolationTier` no registered provisioner can serve
 * (e.g. `dedicatedCluster` with no external webhook configured) — are rejected
 * with HTTP 422 and the coded error {@link ClusterTenantTierUnavailableCode}.
 *
 * @param prisma   - Prisma client used for persistence (dual-writes the row).
 * @param registry - Provisioner registry used to gate isolation tiers (CT.6).
 * @returns Configured Express router.
 */
export function clusterTenantsRouter(prisma: PrismaClient, registry: ClusterTenantProvisionerRegistry): Router
{
  const router = Router();

  /** List all cluster tenants. */
  router.get("/", async function _listClusterTenants(req, res)
  {
    const rows = await prisma.clusterTenant.findMany({ orderBy: { createdAt: "asc" } });
    res.json(rows.map(_ToContract));
  });

  /** Get a single cluster tenant by name. */
  router.get("/:name", async function _getClusterTenant(req, res)
  {
    const row = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!row)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    res.json(_ToContract(row));
  });

  /** Get just the observed status of a cluster tenant. */
  router.get("/:name/status", async function _getClusterTenantStatus(req, res)
  {
    const row = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!row)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    res.json(_ToContract(row).status);
  });

  /** Create a cluster tenant, gating the requested isolation tier on the registry. */
  router.post("/", async function _createClusterTenant(req, res)
  {
    const body = req.body as ClusterTenantCreateRequest;

    // 1. Validate identity + isolation tier up front so a malformed request never
    //    reaches the database or the tier-availability gate.
    if (!body?.name?.trim() || !body?.displayName?.trim())
    {
      res.status(400).json({ error: "name and displayName are required.", code: "VALIDATION_ERROR" });
      return;
    }
    if (!_IsIsolationTier(body.isolationTier))
    {
      res.status(400).json({ error: "isolationTier must be 'shared', 'dedicatedNodes', or 'dedicatedCluster'.", code: "VALIDATION_ERROR" });
      return;
    }

    // 2. Validate compute placement and resource gating — a dedicated pool needs
    //    a node-pool name, and a quota ceiling must always be supplied.
    const computeError = _ValidateCompute(body.compute);
    if (computeError)
    {
      res.status(400).json({ error: computeError, code: "VALIDATION_ERROR" });
      return;
    }
    const resourcesError = _ValidateResources(body.resources);
    if (resourcesError)
    {
      res.status(400).json({ error: resourcesError, code: "VALIDATION_ERROR" });
      return;
    }

    // 3. Reject an over-tier request: no registered provisioner can serve it, so
    //    persisting it would strand the customer in `pending` forever.
    if (!registry.isTierAvailable(body.isolationTier))
    {
      res.status(422).json({ error: `No provisioner is registered for isolation tier '${body.isolationTier}'.`, code: ClusterTenantTierUnavailableCode });
      return;
    }

    // 4. Dual-write the row in `pending`; the operator reconciles it to `ready`.
    const created = await prisma.clusterTenant.create({
      data: {
        name: body.name.trim(),
        displayName: body.displayName.trim(),
        isolationTier: _ToPrismaTier(body.isolationTier),
        computeMode: _ToPrismaCompute(body.compute.mode),
        nodePool: body.compute.nodePool?.trim() || null,
        quota: (body.resources.quota as Prisma.InputJsonValue),
        phase: ClusterTenantPhase.Pending,
      },
    });
    res.status(201).json(_ToContract(created));
  });

  /** Update a cluster tenant, re-gating the isolation tier when it changes. */
  router.put("/:name", async function _updateClusterTenant(req, res)
  {
    const body = req.body as ClusterTenantUpdateRequest;
    const existing = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!existing)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }

    const data: Prisma.ClusterTenantUpdateInput = {};

    // 1. Apply display-name change when present (non-blank).
    if (body.displayName !== undefined)
    {
      if (!body.displayName.trim())
      {
        res.status(400).json({ error: "displayName must not be blank.", code: "VALIDATION_ERROR" });
        return;
      }
      data.displayName = body.displayName.trim();
    }

    // 2. Re-validate and re-gate the isolation tier when it changes — a customer
    //    must not be moved to a tier no provisioner can serve.
    if (body.isolationTier !== undefined)
    {
      if (!_IsIsolationTier(body.isolationTier))
      {
        res.status(400).json({ error: "isolationTier must be 'shared', 'dedicatedNodes', or 'dedicatedCluster'.", code: "VALIDATION_ERROR" });
        return;
      }
      if (!registry.isTierAvailable(body.isolationTier))
      {
        res.status(422).json({ error: `No provisioner is registered for isolation tier '${body.isolationTier}'.`, code: ClusterTenantTierUnavailableCode });
        return;
      }
      data.isolationTier = _ToPrismaTier(body.isolationTier);
    }

    // 3. Re-validate compute placement when changed (dedicated needs a pool).
    if (body.compute !== undefined)
    {
      const computeError = _ValidateCompute(body.compute);
      if (computeError)
      {
        res.status(400).json({ error: computeError, code: "VALIDATION_ERROR" });
        return;
      }
      data.computeMode = _ToPrismaCompute(body.compute.mode);
      data.nodePool = body.compute.nodePool?.trim() || null;
    }

    // 4. Re-validate the resources block when changed (quota must be present).
    if (body.resources !== undefined)
    {
      const resourcesError = _ValidateResources(body.resources);
      if (resourcesError)
      {
        res.status(400).json({ error: resourcesError, code: "VALIDATION_ERROR" });
        return;
      }
      data.quota = (body.resources.quota as Prisma.InputJsonValue);
    }

    const updated = await prisma.clusterTenant.update({ where: { name: req.params.name }, data });
    res.json(_ToContract(updated));
  });

  /** Delete a cluster tenant. */
  router.delete("/:name", async function _deleteClusterTenant(req, res)
  {
    const existing = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!existing)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    await prisma.clusterTenant.delete({ where: { name: req.params.name } });
    res.json({ name: req.params.name, status: "deleted" });
  });

  return router;
}
