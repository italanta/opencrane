import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { CreateTenantRequest, TenantResponse } from "../types.js";

/** Kubernetes API group for OpenCrane custom resources. */
const API_GROUP = "opencrane.io";

/** Kubernetes API version for OpenCrane custom resources. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

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
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: "Tenant",
      metadata: { name: body.name, namespace },
      spec: {
        displayName: body.displayName,
        email: body.email,
        team: body.team,
        resources: body.resources,
        skills: body.skills,
        policyRef: body.policyRef,
      },
    };

    await customApi.createNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
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
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.skills ? { skills: body.skills } : {}),
        ...(body.policyRef ? { policyRef: body.policyRef } : {}),
      },
    };

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
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
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
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
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
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
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
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
