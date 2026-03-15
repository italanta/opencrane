import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { CreatePolicyRequest } from "../types.js";

/** Kubernetes API group for OpenCrane custom resources. */
const API_GROUP = "opencrane.io";

/** Kubernetes API version for OpenCrane custom resources. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the AccessPolicy CRD. */
const PLURAL = "accesspolicies";

/**
 * Creates an Express router that exposes CRUD operations
 * for AccessPolicy custom resources.
 * Dual-writes to both K8s CRDs and PostgreSQL via Prisma.
 * @param customApi - Kubernetes custom objects API client
 * @param prisma - Prisma ORM client
 * @returns Configured Express Router
 */
export function policiesRouter(customApi: k8s.CustomObjectsApi, prisma: PrismaClient): Router
{
  const router = Router();
  const namespace = process.env.NAMESPACE ?? "default";

  /** List all access policies from the database. */
  router.get("/", async function _listPolicies(req, res)
  {
    const policies = await prisma.accessPolicy.findMany({
      orderBy: { createdAt: "desc" },
    });

    res.json(policies.map(function _mapPolicy(p)
    {
      return {
        name: p.name,
        description: p.description,
        tenantSelector: p.tenantSelector,
        domains: p.domains,
        egressRules: p.egressRules,
        mcpServers: p.mcpServers,
      };
    }));
  });

  /** Get a single policy by name. */
  router.get("/:name", async function _getPolicy(req, res)
  {
    const policy = await prisma.accessPolicy.findUnique({
      where: { name: req.params.name },
    });

    if (!policy)
    {
      res.status(404).json({ error: "Policy not found" });
      return;
    }

    res.json({
      name: policy.name,
      description: policy.description,
      tenantSelector: policy.tenantSelector,
      domains: policy.domains,
      egressRules: policy.egressRules,
      mcpServers: policy.mcpServers,
    });
  });

  /** Create a new access policy (dual-write: K8s CRD + database). */
  router.post("/", async function _createPolicy(req, res)
  {
    const body = req.body as CreatePolicyRequest;

    const policyCr = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: "AccessPolicy",
      metadata: { name: body.name, namespace },
      spec: {
        description: body.description,
        tenantSelector: body.tenantSelector,
        domains: body.domains,
        egressRules: body.egressRules,
        mcpServers: body.mcpServers,
      },
    };

    await customApi.createNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      body: policyCr,
    });

    await prisma.accessPolicy.create({
      data: {
        name: body.name,
        description: body.description,
        tenantSelector: body.tenantSelector ?? undefined,
        domains: body.domains ?? undefined,
        egressRules: body.egressRules ?? undefined,
        mcpServers: body.mcpServers ?? undefined,
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: "Created",
        resource: `AccessPolicy/${body.name}`,
        message: `Access policy ${body.name} created`,
      },
    });

    res.status(201).json({ name: body.name, status: "created" });
  });

  /** Update a policy (dual-write: K8s CRD + database). */
  router.put("/:name", async function _updatePolicy(req, res)
  {
    const name = req.params.name;
    const body = req.body as Partial<CreatePolicyRequest>;

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: { spec: body },
    });

    await prisma.accessPolicy.update({
      where: { name },
      data: {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.tenantSelector !== undefined ? { tenantSelector: body.tenantSelector } : {}),
        ...(body.domains !== undefined ? { domains: body.domains } : {}),
        ...(body.egressRules !== undefined ? { egressRules: body.egressRules } : {}),
        ...(body.mcpServers !== undefined ? { mcpServers: body.mcpServers } : {}),
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: "Updated",
        resource: `AccessPolicy/${name}`,
        message: `Access policy ${name} updated`,
      },
    });

    res.json({ name, status: "updated" });
  });

  /** Delete a policy (dual-write: K8s CRD + database). */
  router.delete("/:name", async function _deletePolicy(req, res)
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
        action: "Deleted",
        resource: `AccessPolicy/${name}`,
        message: `Access policy ${name} deleted`,
      },
    });

    await prisma.accessPolicy.delete({ where: { name } });

    res.json({ name, status: "deleted" });
  });

  return router;
}
