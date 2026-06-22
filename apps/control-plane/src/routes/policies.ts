import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _log } from "../log.js";
import type { CreatePolicyRequest } from "../types.js";
import { _PropagatePolicyToCognee, _ResolvePolicyAffectedTenants } from "../core/grants/cognee-awareness-sync.js";
import { _DetectPolicyProjectionDrift } from "./internal/projection-drift.js";
import { _RepairPolicyProjection } from "./internal/projection-repair.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, POLICY_CRD_PLURAL } from "../shared/crd-constants.js";

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
   * Best-effort propagation of an AccessPolicy change to Cognee awareness grants
   * (P4B.2). Resolves the affected tenants and re-syncs their compiled grants so
   * Cognee's retrieval ACL converges. Never throws: a Cognee outage must not fail
   * the policy write, since PostgreSQL is the source of truth and the next change
   * (or a tenant contract re-pull) reconciles. Pass pre-resolved tenants on delete.
   *
   * @param policyName    - The changed policy.
   * @param tenants       - Affected tenants (resolve before delete; null → resolve now).
   * @param authorization - Inbound authorization header (string or array form).
   */
  async function _propagateToCognee(policyName: string, tenants: string[] | null, authorization: string | string[] | undefined): Promise<void>
  {
    try
    {
      const auth = typeof authorization === "string" ? authorization : undefined;
      const affected = tenants ?? await _ResolvePolicyAffectedTenants(prisma, policyName);
      if (affected.length === 0)
      {
        return;
      }
      const result = await _PropagatePolicyToCognee(prisma, policyName, affected, auth);
      if (result.failures > 0)
      {
        _log.warn({ policyName, failures: result.failures, affected: affected.length }, "cognee awareness propagation had tenant failures");
      }
    }
    catch (err)
    {
      _log.warn({ policyName, err }, "cognee awareness propagation errored");
    }
  }

  /**
   * Report detect-only drift between AccessPolicy CRDs and PostgreSQL projection rows.
   */
  router.get("/drift", async function _getPolicyProjectionDrift(req, res)
  {
    const report = await _DetectPolicyProjectionDrift(customApi, prisma, namespace);
    res.json(report);
  });

  /**
   * Repair AccessPolicy projection rows from CRD source of truth.
   * Defaults to dry-run; pass ?dryRun=false to apply writes.
   */
  router.post("/repair", async function _postPolicyProjectionRepair(req, res)
  {
    const dryRun = req.query["dryRun"] !== "false";
    const report = await _RepairPolicyProjection(customApi, prisma, namespace, dryRun);
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
      res.status(404).json({ error: "Policy not found", code: "POLICY_NOT_FOUND" });
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

    // 1. Build the AccessPolicy CR — the K8s side of the dual-write that the
    //    operator reconciles against tenant pods.
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

    // 2. Create the CRD so cluster-side reconciliation sees the new policy.
    await customApi.createNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
      body: policyCr,
    });

    // 3. Persist the PostgreSQL projection — the API/UI source of truth.
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

    // 4. Audit the change so policy mutations are attributable.
    await prisma.auditEntry.create({
      data: {
        action: "Created",
        resource: `AccessPolicy/${body.name}`,
        message: `Access policy ${body.name} created`,
      },
    });

    // 5. Propagate to Cognee awareness grants for affected tenants (best-effort).
    await _propagateToCognee(body.name, null, req.headers.authorization);

    res.status(201).json({ name: body.name, status: "created" });
  });

  /** Update a policy (dual-write: K8s CRD + database). */
  router.put("/:name", async function _updatePolicy(req, res)
  {
    const name = req.params.name;
    const body = req.body as Partial<CreatePolicyRequest>;

    // 1. Patch the CRD so the cluster-side policy matches the new spec.
    await customApi.patchNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
      name,
      body: { spec: body },
    }, k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch));

    // 2. Update the PostgreSQL projection (only the fields the request supplied).
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

    // 3. Audit the change.
    await prisma.auditEntry.create({
      data: {
        action: "Updated",
        resource: `AccessPolicy/${name}`,
        message: `Access policy ${name} updated`,
      },
    });

    // 4. Propagate to Cognee awareness grants for affected tenants (best-effort).
    await _propagateToCognee(name, null, req.headers.authorization);

    res.json({ name, status: "updated" });
  });

  /** Delete a policy (dual-write: K8s CRD + database). */
  router.delete("/:name", async function _deletePolicy(req, res)
  {
    const name = req.params.name;

    // 1. Resolve affected tenants BEFORE deleting — the selector is needed to
    //    resolve them, and after delete the row (and its selector) is gone. Best-effort:
    //    a resolution hiccup must not block the delete (propagation is downstream).
    const affectedTenants = await _ResolvePolicyAffectedTenants(prisma, name).catch(function _onResolveErr(err)
    {
      _log.warn({ policyName: name, err }, "could not resolve affected tenants before policy delete");
      return [] as string[];
    });

    // 2. Delete the CRD so cluster-side reconciliation drops the policy.
    await customApi.deleteNamespacedCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      namespace,
      plural: POLICY_CRD_PLURAL,
      name,
    });

    // 3. Audit the deletion.
    await prisma.auditEntry.create({
      data: {
        action: "Deleted",
        resource: `AccessPolicy/${name}`,
        message: `Access policy ${name} deleted`,
      },
    });

    // 4. Delete the PostgreSQL projection row.
    await prisma.accessPolicy.delete({ where: { name } });

    // 5. Propagate removal to Cognee awareness grants for the pre-resolved tenants
    //    (their compiled grants now reflect the policy's absence). Best-effort.
    await _propagateToCognee(name, affectedTenants, req.headers.authorization);

    res.json({ name, status: "deleted" });
  });

  return router;
}
