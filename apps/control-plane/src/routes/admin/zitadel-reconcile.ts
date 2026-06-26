import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _RequirePlatformOperator } from "../../infra/middleware/require-platform-operator.js";
import { _DeriveOrgRedirectUri, _DeriveVanityRedirectUri } from "../../infra/zitadel/zitadel-client.js";
import type { ZitadelManagementClient } from "../../infra/zitadel/zitadel-client.types.js";
import { _log } from "../../log.js";
import type { ZitadelReconcileRequest, ZitadelReconcileSummary } from "./zitadel-reconcile.types.js";

/** A `cluster_tenants` row as returned by Prisma `findMany`/`findUnique`. */
type ClusterTenantRow = NonNullable<Awaited<ReturnType<PrismaClient["clusterTenant"]["findUnique"]>>>;

/**
 * Whether a ClusterTenant row has a COMPLETE Zitadel provisioning — all four ids present.
 * A row missing any of orgId / clientId / appId / projectId is a reconcile candidate (it was
 * created before Zitadel was configured, or a provision half-failed). The reconcile is
 * idempotent off this predicate: a complete row makes no Zitadel call.
 *
 * @param row - The ClusterTenant row to inspect.
 * @returns True when every Zitadel id column is populated.
 */
function _IsZitadelComplete(row: ClusterTenantRow): boolean
{
  return Boolean(row.zitadelOrgId && row.zitadelClientId && row.zitadelAppId && row.zitadelProjectId);
}

/**
 * Re-provision a single ClusterTenant's Zitadel org and persist the ids in ONE transaction
 * (the external Zitadel call is the LAST fallible step, per the standing rule: a Prisma write
 * plus an external call go in one `$transaction` with the external call last, so a Zitadel
 * failure rolls the persist back and the DB never drifts).
 *
 * The org's master subject is the CT's `Owner` membership. When no Owner membership exists the
 * caller has already decided to skip the CT, so this helper assumes a non-empty `masterSubject`.
 *
 * @param prisma        - Prisma client (the persist runs inside its `$transaction`).
 * @param zitadelClient - The live Zitadel management client.
 * @param row           - The ClusterTenant row being reconciled.
 * @param masterSubject - The Owner subject granted `admin` on the (re-)provisioned org.
 * @param baseDomain    - Platform base domain used to derive the canonical redirect URI.
 */
async function _ReconcileOne(prisma: PrismaClient, zitadelClient: ZitadelManagementClient,
                             row: ClusterTenantRow, masterSubject: string, baseDomain: string): Promise<void>
{
  await prisma.$transaction(async function _persistAfterProvision(tx)
  {
    // The Zitadel call is the LAST fallible step: derive the redirect URIs as the create
    // handler does (canonical apex + the vanity callback when the org carries a vanity
    // domain) and re-provision. `provisionOrg` self-compensates on a mid-flight failure.
    const zitadel = await zitadelClient.provisionOrg({
      orgName: row.name,
      displayName: row.displayName,
      redirectUri: _DeriveOrgRedirectUri(row.name, baseDomain),
      ...(row.vanityDomain ? { vanityRedirectUri: _DeriveVanityRedirectUri(row.vanityDomain) } : {}),
      masterSubject,
    });
    await tx.clusterTenant.update({
      where: { name: row.name },
      data: { zitadelOrgId: zitadel.orgId, zitadelProjectId: zitadel.projectId, zitadelAppId: zitadel.appId, zitadelClientId: zitadel.clientId, zitadelRedirectUri: zitadel.redirectUri },
    });
  });
}

/**
 * Superadmin-gated router for the idempotent Zitadel reconcile/backfill (S3d).
 *
 * For every ClusterTenant whose Zitadel ids are incomplete (missing orgId OR clientId OR appId
 * OR projectId), it re-runs `provisionOrg` (master subject = the CT's `Owner` membership) and
 * persists the ids transactionally (external call LAST). It is **idempotent**: a fully-provisioned
 * CT is skipped with no Zitadel call, and re-running it on an already-healed fleet is a no-op.
 *
 * Failure isolation: a per-CT failure (no Owner → `skipped: no-owner`; a `provisionOrg`/persist
 * throw → `failed`) NEVER aborts the run — each outcome is collected and the scan continues, and
 * the route always returns 200 with the full summary. Every skip/fail is structured-logged.
 *
 * Mounted at `/api/v1/admin/zitadel` (sibling of the SA-key router), behind
 * {@link _RequirePlatformOperator}. Only the multi-tenant path constructs the Zitadel client,
 * so it is mounted only there (see `routes.ts`).
 *
 * @param prisma        - Prisma client used to read the fleet + persist the reconciled ids.
 * @param zitadelClient - The live Zitadel management client used to (re-)provision orgs.
 * @returns Configured Express router.
 */
export function zitadelReconcileRouter(prisma: PrismaClient, zitadelClient: ZitadelManagementClient): Router
{
  const router = Router();

  router.use(_RequirePlatformOperator());

  /**
   * Reconcile incomplete Zitadel orgs across the fleet (or a single CT when `{ name }` is given).
   * Always 200 with a `{ reconciled, skipped, failed }` summary; per-CT failures are collected.
   */
  router.post("/reconcile", async function _reconcile(req, res)
  {
    const body = (req.body ?? {}) as ZitadelReconcileRequest;
    const baseDomain = process.env.PLATFORM_BASE_DOMAIN?.trim() ?? "";

    // 1. Resolve the scope: a single named CT (404 when absent) or the whole fleet.
    let rows: ClusterTenantRow[];
    if (typeof body.name === "string" && body.name.trim())
    {
      const row = await prisma.clusterTenant.findUnique({ where: { name: body.name.trim() } });
      if (!row)
      {
        res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
        return;
      }
      rows = [row];
    }
    else
    {
      rows = await prisma.clusterTenant.findMany({ orderBy: { createdAt: "asc" } });
    }

    const summary: ZitadelReconcileSummary = { reconciled: [], skipped: [], failed: [] };

    // 2. Walk every candidate. Each CT lands in exactly one bucket; a per-CT failure is
    //    collected and the loop continues so one bad org never strands the rest.
    for (const row of rows)
    {
      // 2a. Idempotency: a fully-provisioned CT makes no Zitadel call.
      if (_IsZitadelComplete(row))
      {
        summary.skipped.push({ name: row.name, reason: "already-provisioned" });
        continue;
      }

      // 2b. The master subject is the CT's Owner membership; with no Owner there is no
      //     identity to grant `admin`, so skip (reported) rather than guess.
      const owner = await prisma.orgMembership.findFirst({ where: { clusterTenant: row.name, role: "Owner" } });
      if (!owner)
      {
        _log.warn({ orgName: row.name }, "zitadel reconcile: skipped — no Owner membership to use as the org master subject");
        summary.skipped.push({ name: row.name, reason: "no-owner" });
        continue;
      }

      // 2c. (Re-)provision + persist transactionally (external LAST). A throw here is this
      //     CT's failure alone — collect it and move on.
      try
      {
        await _ReconcileOne(prisma, zitadelClient, row, owner.subject, baseDomain);
        _log.info({ orgName: row.name }, "zitadel reconcile: re-provisioned org and persisted ids");
        summary.reconciled.push(row.name);
      }
      catch (err)
      {
        const message = err instanceof Error ? err.message : String(err);
        _log.error({ err, orgName: row.name }, "zitadel reconcile: provision/persist FAILED for this org (continuing with the rest)");
        summary.failed.push({ name: row.name, error: message });
      }
    }

    _log.info({ reconciled: summary.reconciled.length, skipped: summary.skipped.length, failed: summary.failed.length }, "zitadel reconcile: run complete");
    res.status(200).json(summary);
  });

  return router;
}
