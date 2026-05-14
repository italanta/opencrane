import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { CreateTenantRequest, TenantResponse } from "../types.js";
import { _DetectTenantProjectionDrift } from "./internal/projection-drift.js";
import { _RepairTenantProjection } from "./internal/projection-repair.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "./internal/crd-constants.js";

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
