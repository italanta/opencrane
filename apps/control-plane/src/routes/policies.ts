import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { CreatePolicyRequest } from "../types.js";
import { _DetectPolicyProjectionDrift } from "./internal/projection-drift.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, POLICY_CRD_PLURAL } from "./internal/crd-constants.js";

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

  /**
   * Report detect-only drift between AccessPolicy CRDs and PostgreSQL projection rows.
   */
  router.get("/drift", async function _getPolicyProjectionDrift(req, res)
  {
    const report = await _DetectPolicyProjectionDrift(customApi, prisma, namespace);
    res.json(report);
  });

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
      apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
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
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
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
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
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
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
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
