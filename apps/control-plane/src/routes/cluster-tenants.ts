import { Router } from "express";
import type { Request } from "express";
import * as k8s from "@kubernetes/client-node";
import { ClusterTenantPhase, ClusterTenantTierUnavailableCode } from "@opencrane/contracts";
import type { ClusterTenantProvisionerRegistry } from "@opencrane/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { ClusterTenantCreateRequest, ClusterTenantUpdateRequest } from "./cluster-tenants.models.js";
import { _IsIsolationTier, _ToContract, _ToPrismaCompute, _ToPrismaTier, _ValidateCompute, _ValidateResources } from "./cluster-tenants.service.js";
import { _IsDevAuthMode } from "../infra/auth/auth-mode.js";
import { _RequireBillingAccountForOrgCreate, _RequireOrgManager } from "../infra/middleware/cluster-tenant-org-admin.js";
import { _ApplyClusterTenantCr, _DeleteClusterTenantCr } from "../core/cluster-tenants/cr-bridge.js";

/** RFC-1123-ish DNS domain: lowercase labels, ≥1 dot, alpha TLD, ≤253 chars. */
const _VANITY_DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Whether a string is a syntactically valid customer-vanity domain. */
function _isValidVanityDomain(value: string): boolean
{
  return _VANITY_DOMAIN_PATTERN.test(value);
}

/**
 * CRUD router for the first-class cluster tenant (customer / isolation unit).
 *
 * Over-tier requests — an `isolationTier` no registered provisioner can serve
 * (e.g. `dedicatedCluster` with no external webhook configured) — are rejected
 * with HTTP 422 and the coded error {@link ClusterTenantTierUnavailableCode}.
 *
 * @param prisma   - Prisma client used for persistence (dual-writes the row).
 * @param registry - Provisioner registry used to gate isolation tiers (CT.6).
 * @param customApi - Kubernetes custom-objects client used to dual-write the
 *   cluster-scoped ClusterTenant CR the operator reconciles. Pass `null` in dev/test
 *   wiring with no cluster; the CR bridge then no-ops and the DB row stands alone.
 * @returns Configured Express router.
 */
export function clusterTenantsRouter(prisma: PrismaClient, registry: ClusterTenantProvisionerRegistry,
                                     customApi: k8s.CustomObjectsApi | null = null): Router
{
  const router = Router();

  // Org-management guards (operator OR owner/admin member of the named org). Applied
  // to the fleet list/get reads and the destructive mutations below; the create path
  // uses the billing gate instead (a user becomes admin BY creating, so create cannot
  // require pre-existing org-admin).
  const requireOrgManager = _RequireOrgManager(prisma);

  /** List all cluster tenants (fleet view — platform-operator only via the guard). */
  router.get("/", requireOrgManager, async function _listClusterTenants(req, res)
  {
    const rows = await prisma.clusterTenant.findMany({ orderBy: { createdAt: "asc" } });
    res.json(rows.map(_ToContract));
  });

  /** Get a single cluster tenant by name (operator OR owner/admin of that org). */
  router.get("/:name", requireOrgManager, async function _getClusterTenant(req: Request<{ name: string }>, res)
  {
    const row = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!row)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    res.json(_ToContract(row));
  });

  /** Get just the observed status of a cluster tenant (operator OR owner/admin of that org). */
  router.get("/:name/status", requireOrgManager, async function _getClusterTenantStatus(req: Request<{ name: string }>, res)
  {
    const row = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!row)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    res.json(_ToContract(row).status);
  });

  /**
   * Create a cluster tenant (organisation), gating on the caller's billing account
   * and recording the caller as the org's single `owner` membership transactionally.
   * The billing gate (not pre-existing org-admin) is what authorises create — a user
   * becomes an org admin BY creating their first org.
   */
  router.post("/", _RequireBillingAccountForOrgCreate(prisma), async function _createClusterTenant(req, res)
  {
    const body = req.body as ClusterTenantCreateRequest;

    // 0. Resolve the caller's subject — the future owner. The billing gate ahead has
    //    already established an authenticated session (or the dev-mode bypass), so a
    //    missing subject here can only be the dev-mode path: stamp a synthetic owner.
    const ownerSubject = (typeof req.session?.authUser?.sub === "string" && req.session.authUser.sub.trim())
      ? req.session.authUser.sub.trim()
      : (_IsDevAuthMode() ? "dev-local-subject" : "");
    if (!ownerSubject)
    {
      res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
      return;
    }

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
    if (body.vanityDomain !== undefined && body.vanityDomain.trim() && !_isValidVanityDomain(body.vanityDomain.trim()))
    {
      res.status(400).json({ error: "vanityDomain must be a valid lowercase DNS domain (e.g. ai.client-company.com).", code: "VALIDATION_ERROR" });
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

    // 4. Persist the org and its single owner membership in ONE transaction: the
    //    caller becomes the org's root admin (owner) atomically with the org row.
    //    Dual-write the org in `pending`; the operator reconciles it to `ready`.
    //    NOTE (provisioning hand-off): the ClusterTenant operator/CR watcher reconciles
    //    `pending` → `ready` and drives the domain provisioner. This handler only
    //    persists the desired state; it performs no cluster-side side effects.
    const created = await prisma.$transaction(async function _createOrgWithOwner(tx)
    {
      const org = await tx.clusterTenant.create({
        data: {
          name: body.name.trim(),
          displayName: body.displayName.trim(),
          vanityDomain: body.vanityDomain?.trim() || null,
          isolationTier: _ToPrismaTier(body.isolationTier),
          computeMode: _ToPrismaCompute(body.compute.mode),
          nodePool: body.compute.nodePool?.trim() || null,
          quota: (body.resources.quota as Prisma.InputJsonValue),
          phase: ClusterTenantPhase.Pending,
        },
      });

      // The creator is the org's single `owner` (one-owner-per-org is enforced by the
      // partial unique index). Written in the same tx so an org can never exist
      // without its owner, and vice versa.
      await tx.orgMembership.create({
        data: { clusterTenant: org.name, subject: ownerSubject, role: "Owner" },
      });

      return org;
    });

    // 5. DB → K8s bridge. Project the persisted desired state into the cluster-scoped
    //    `clustertenants` CR the ClusterTenant reconciler watches. This is the seam
    //    that turns the `pending` row into something that actually provisions: the
    //    reconciler picks up the CR, calls the registered provisioner, and patches
    //    `status.phase` (`pending → provisioning → ready`) + `boundNamespace` back.
    //    The bridge writes ONLY spec (never status) and is idempotent.
    //
    //    Domain provisioning hand-off (fixed-wildcard topology) follows the same path:
    //    the org is addressable at its derived apex `<name>.<platformBaseDomain>` and
    //    its users at `<user>.<name>.<base>`. Two cluster-side side effects must follow
    //    — the per-org DNS record (`*.<org>.<base>` → ingress IP) and the per-org
    //    wildcard TLS cert — both owned by the OPERATOR's `DefaultOrgDomainProvisioner`
    //    (apps/operator/src/cluster-tenants/internal), which the ClusterTenant reconciler
    //    drives on the `pending` → `ready` reconcile via `provisionOrgDomain(...)`. It is
    //    runtime-gated there and never executed inline here; this handler only persists/
    //    declares desired state and does not mutate DNS or cert-manager.
    const orgContract = _ToContract(created);
    await _ApplyClusterTenantCr(customApi, orgContract);

    res.status(201).json(orgContract);
  });

  /** Update a cluster tenant (operator OR owner/admin of that org), re-gating the isolation tier when it changes. */
  router.put("/:name", requireOrgManager, async function _updateClusterTenant(req: Request<{ name: string }>, res)
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

    // 1b. Apply vanity-domain change when present; an empty string clears it (back to
    //     the derived `<name>.<base>` apex only), a non-empty value must be valid.
    if (body.vanityDomain !== undefined)
    {
      const trimmed = body.vanityDomain.trim();
      if (trimmed && !_isValidVanityDomain(trimmed))
      {
        res.status(400).json({ error: "vanityDomain must be a valid lowercase DNS domain (e.g. ai.client-company.com).", code: "VALIDATION_ERROR" });
        return;
      }
      data.vanityDomain = trimmed || null;
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

    // Persist ONLY the desired-state fields collected above. `data` never carries
    // `phase`, `boundNamespace`, `message`, or `provisioner`, so an org update can
    // never clobber the observed status the reconciler stamps — those columns are
    // the operator's to own. Re-project the new spec onto the CR so the reconciler
    // re-converges to the changed desired state (idempotent; status untouched).
    const updated = await prisma.clusterTenant.update({ where: { name: req.params.name }, data });
    const orgContract = _ToContract(updated);
    await _ApplyClusterTenantCr(customApi, orgContract);
    res.json(orgContract);
  });

  /** Delete a cluster tenant (operator OR owner/admin of that org). */
  router.delete("/:name", requireOrgManager, async function _deleteClusterTenant(req: Request<{ name: string }>, res)
  {
    const existing = await prisma.clusterTenant.findUnique({ where: { name: req.params.name } });
    if (!existing)
    {
      res.status(404).json({ error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" });
      return;
    }
    await prisma.clusterTenant.delete({ where: { name: req.params.name } });
    // Tear down the cluster-scoped CR so the reconciler stops watching it; tolerant
    // of a missing CR (404) for the dev/no-cluster path where none was ever written.
    await _DeleteClusterTenantCr(customApi, req.params.name);
    res.json({ name: req.params.name, status: "deleted" });
  });

  return router;
}
