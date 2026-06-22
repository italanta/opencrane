import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";

import { _ApplyClusterTenantCr } from "../core/cluster-tenants/cr-bridge.js";
import { _ToContract, _ToPrismaTier } from "../routes/cluster-tenants.service.js";
import type { ClusterTenantSeedConfig } from "./cluster-tenant-seed.types.js";

/**
 * Read the single-tenant ClusterTenant seed config from the environment.
 *
 * Sourced from `OPENCRANE_SEED_CLUSTER_TENANT_*` (set by Helm only in the
 * single-tenant profile). An empty/absent name means "no seed" — the multi-tenant
 * profile leaves these unset, so the seed is a strict no-op there. The tier is
 * validated against the contract enum and falls back to `shared` (the right default
 * for a single-tenant box) on an unknown value.
 *
 * @returns The parsed seed config; `name` is empty when no seed is configured.
 */
export function _ReadClusterTenantSeedConfig(): ClusterTenantSeedConfig
{
  // 1. The name is the gate: empty → no seed. Trim so accidental whitespace from a
  //    Helm value does not produce a phantom org keyed on a blank-padded name.
  const name = process.env.OPENCRANE_SEED_CLUSTER_TENANT_NAME?.trim() ?? "";

  // 2. Display name defaults to the name so a minimal seed (name + owner only) still
  //    produces a sensible, human-readable org.
  const displayName = process.env.OPENCRANE_SEED_CLUSTER_TENANT_DISPLAY_NAME?.trim() || name;

  // 3. Owner email is recorded as the membership subject (OIDC-sub-else-email
  //    fallback). Lowercased/trimmed so it matches the verified email at login time.
  const ownerEmail = process.env.OPENCRANE_SEED_CLUSTER_TENANT_OWNER_EMAIL?.trim().toLowerCase() ?? "";

  // 4. Tier is constrained to the contract enum; anything unrecognised degrades to
  //    `shared` rather than seeding an org the operator cannot place.
  const rawTier = process.env.OPENCRANE_SEED_CLUSTER_TENANT_TIER?.trim() ?? "";
  const isolationTier = _isIsolationTier(rawTier) ? rawTier : ClusterTenantIsolationTier.Shared;

  return { name, displayName, ownerEmail, isolationTier };
}

/** Narrow an arbitrary string to a {@link ClusterTenantIsolationTier} enum member. */
function _isIsolationTier(value: string): value is ClusterTenantIsolationTier
{
  return value === ClusterTenantIsolationTier.Shared
    || value === ClusterTenantIsolationTier.DedicatedNodes
    || value === ClusterTenantIsolationTier.DedicatedCluster;
}

/**
 * Seed the single-tenant org DIRECTLY at boot: a ClusterTenant DB row + its single
 * `owner` OrgMembership, then bridge it to the cluster-scoped CR the operator (#50)
 * reconciles. This is the seed pattern — NOT the billing-gated `POST /cluster-tenants`
 * — so the single-tenant profile (manager/billing OFF) still gets a working org.
 *
 * Idempotent and fail-soft: a re-run on every pod restart converges (existing row is
 * left as-is so it never clobbers operator-stamped status), and any seed failure is
 * logged but never blocks the control-plane from starting (the org can be reconciled
 * later). The membership subject is the owner email (OIDC-sub-else-email fallback)
 * since the owner has no verified `sub` until they first log in.
 *
 * @param prisma    - Prisma client (system of record for desired state).
 * @param customApi - Kubernetes Custom Objects API for the DB→CR bridge; null skips it.
 * @param log       - Logger for seed progress and fail-soft diagnostics.
 */
export async function _SeedClusterTenant(prisma: PrismaClient, customApi: k8s.CustomObjectsApi | null, log: Logger): Promise<void>
{
  const config = _ReadClusterTenantSeedConfig();

  // 1. No name → no seed. The multi-tenant profile takes this path (env unset), so the
  //    seed is inert unless the single-tenant Helm profile explicitly configures it.
  if (config.name === "")
  {
    return;
  }

  try
  {
    // 2. Idempotency gate: if the org already exists, leave it untouched. The operator
    //    owns observed status (phase/boundNamespace), so re-seeding must never reset it.
    const existing = await prisma.clusterTenant.findUnique({ where: { name: config.name } });
    if (existing)
    {
      log.info({ name: config.name }, "single-tenant seed: ClusterTenant already present, skipping");
      // Still ensure the CR exists (a DB row with no CR would never reconcile).
      await _ApplyClusterTenantCr(customApi, _ToContract(existing));
      return;
    }

    // 3. Create the org row and its single owner membership in ONE transaction (mirrors
    //    the POST handler): an org must never exist without its owner, and vice versa.
    //    The owner membership is created only when an owner email was supplied.
    const created = await prisma.$transaction(async function _createSeededOrg(tx)
    {
      const org = await tx.clusterTenant.create({
        data: {
          name: config.name,
          displayName: config.displayName,
          isolationTier: _ToPrismaTier(config.isolationTier),
          phase: "pending",
        },
      });

      if (config.ownerEmail !== "")
      {
        await tx.orgMembership.create({
          data: { clusterTenant: org.name, subject: config.ownerEmail, role: "Owner" },
        });
      }

      return org;
    });

    // 4. DB → K8s bridge: project the seeded desired state into the ClusterTenant CR the
    //    #50 reconciler watches, so the pending org actually provisions.
    await _ApplyClusterTenantCr(customApi, _ToContract(created));

    log.info({ name: config.name, owner: config.ownerEmail || "(none)", tier: config.isolationTier },
      "single-tenant seed: ClusterTenant + owner membership created");
  }
  catch (err)
  {
    // Fail-soft: a seed error must not stop the control-plane from serving. Log and
    // continue; the org can be reconciled on the next restart or seeded manually.
    log.error({ err, name: config.name }, "single-tenant seed failed (captured, not thrown)");
  }
}
