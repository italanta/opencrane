import { ClusterTenantComputeMode, ClusterTenantIsolationTier, ClusterTenantPhase } from "@opencrane/contracts";
import type { ClusterTenant, ClusterTenantObservedStatus, ClusterTenantResourceQuota, ClusterTenantStatus } from "@opencrane/contracts";
import type { Prisma, PrismaClient } from "../generated/prisma/index.js";

import type { ClusterTenantComputeInput, ClusterTenantResourcesInput } from "./cluster-tenants.models.js";
import { _log } from "../log.js";

/** A cluster_tenants row as read back from Prisma (subset consumed here). */
type ClusterTenantRow = Prisma.ClusterTenantGetPayload<Record<string, never>>;

/** Map the contract isolation tier (lowercase) to the Prisma enum member (PascalCase). */
export function _ToPrismaTier(tier: ClusterTenantIsolationTier): "Shared" | "DedicatedNodes" | "DedicatedCluster"
{
  switch (tier)
  {
    case ClusterTenantIsolationTier.Shared: return "Shared";
    case ClusterTenantIsolationTier.DedicatedNodes: return "DedicatedNodes";
    case ClusterTenantIsolationTier.DedicatedCluster: return "DedicatedCluster";
  }
}

/** Map the contract compute mode (lowercase) to the Prisma enum member (PascalCase). */
export function _ToPrismaCompute(mode: ClusterTenantComputeMode): "Shared" | "Dedicated"
{
  return mode === ClusterTenantComputeMode.Dedicated ? "Dedicated" : "Shared";
}

/** Map a Prisma isolation-tier enum member back to the contract tier value. */
export function _FromPrismaTier(value: string): ClusterTenantIsolationTier
{
  switch (value)
  {
    case "DedicatedNodes": return ClusterTenantIsolationTier.DedicatedNodes;
    case "DedicatedCluster": return ClusterTenantIsolationTier.DedicatedCluster;
    default: return ClusterTenantIsolationTier.Shared;
  }
}

/** Map a Prisma compute-mode enum member back to the contract compute value. */
export function _FromPrismaCompute(value: string): ClusterTenantComputeMode
{
  return value === "Dedicated" ? ClusterTenantComputeMode.Dedicated : ClusterTenantComputeMode.Shared;
}

/** Map the stored phase string back to the contract phase enum (defaults to pending). */
export function _FromPrismaPhase(value: string): ClusterTenantPhase
{
  switch (value)
  {
    case "provisioning": return ClusterTenantPhase.Provisioning;
    case "ready": return ClusterTenantPhase.Ready;
    case "failed": return ClusterTenantPhase.Failed;
    default: return ClusterTenantPhase.Pending;
  }
}

/**
 * Map the operator's OBSERVED CR status into the contract status shape.
 *
 * Used by the read path to surface the live phase the operator stamped on the CR
 * (which the DB `phase` column never receives) instead of the seeded `pending`. The
 * phase string uses the same tokens as the DB column, so {@link _FromPrismaPhase}
 * maps it identically.
 *
 * @param observed - The status subresource read from the ClusterTenant CR.
 * @returns The contract status reflecting real provisioning progress.
 */
export function _ObservedStatusToContract(observed: ClusterTenantObservedStatus): ClusterTenantStatus
{
  return {
    phase: _FromPrismaPhase(observed.phase ?? "pending"),
    ...(observed.message ? { message: observed.message } : {}),
    ...(observed.boundNamespace ? { boundNamespace: observed.boundNamespace } : {}),
    ...(observed.provisioner ? { provisioner: observed.provisioner } : {}),
  };
}

/**
 * Mirror the operator's observed CR status back into the `cluster_tenants` row (read-repair).
 *
 * Approach A2 reads the live phase from the CR, but the DB column stays stale, so the fleet
 * LIST endpoint (and any other DB reader) would still show `pending`. Writing the observed
 * status back on read converges the DB to the truth the operator stamped — without the
 * operator needing DB access. The phase tokens match the column's, so they persist verbatim.
 *
 * Idempotent and side-effect-safe: skips the write when nothing changed (no write amplification
 * once converged), and swallows write errors so a DB hiccup never fails the status read.
 *
 * @param prisma - Prisma client.
 * @param row - The currently persisted row (used to diff before writing).
 * @param observed - The observed status read from the CR.
 */
export async function _SyncObservedStatusToDb(prisma: PrismaClient, row: ClusterTenantRow, observed: ClusterTenantObservedStatus): Promise<void>
{
  const phase = observed.phase ?? "pending";
  const message = observed.message ?? null;
  const boundNamespace = observed.boundNamespace ?? null;
  const provisioner = observed.provisioner ?? null;

  // No delta → nothing to mirror (avoids a write on every poll once the org has converged).
  if (row.phase === phase && row.message === message && row.boundNamespace === boundNamespace && row.provisioner === provisioner)
  {
    return;
  }

  try
  {
    await prisma.clusterTenant.update({ where: { name: row.name }, data: { phase, message, boundNamespace, provisioner } });
  }
  catch (err)
  {
    // Best-effort mirror: the authoritative read already used the observed status, so a
    // transient DB write failure must not fail the status endpoint. Log at debug so a
    // persistent divergence is traceable without flooding the log on every poll.
    _log.debug({ err, orgName: row.name, phase }, "best-effort ClusterTenant status mirror to DB failed; serving observed status from the CR");
  }
}

/** Whether a value is one of the contract isolation-tier strings. */
export function _IsIsolationTier(value: unknown): value is ClusterTenantIsolationTier
{
  return value === ClusterTenantIsolationTier.Shared || value === ClusterTenantIsolationTier.DedicatedNodes || value === ClusterTenantIsolationTier.DedicatedCluster;
}

/** Whether a value is one of the contract compute-mode strings. */
export function _IsComputeMode(value: unknown): value is ClusterTenantComputeMode
{
  return value === ClusterTenantComputeMode.Shared || value === ClusterTenantComputeMode.Dedicated;
}

/**
 * Validate a compute block: a dedicated mode requires a node pool, otherwise the
 * operator could place pods on no machines at all.
 *
 * @param compute - Compute input from the request body.
 * @returns A validation error message, or null when valid.
 */
export function _ValidateCompute(compute: ClusterTenantComputeInput | undefined): string | null
{
  if (!compute || !_IsComputeMode(compute.mode))
  {
    return "compute.mode must be 'shared' or 'dedicated'.";
  }
  if (compute.mode === ClusterTenantComputeMode.Dedicated && !compute.nodePool?.trim())
  {
    return "compute.nodePool is required when compute.mode is 'dedicated'.";
  }
  return null;
}

/**
 * Validate a resources block: the quota object must be present (it is the
 * resource ceiling enforced over the customer's namespace).
 *
 * @param resources - Resources input from the request body.
 * @returns A validation error message, or null when valid.
 */
export function _ValidateResources(resources: ClusterTenantResourcesInput | undefined): string | null
{
  if (!resources || typeof resources.quota !== "object" || resources.quota === null)
  {
    return "resources.quota must be provided.";
  }
  return null;
}

/**
 * Project a stored row into the shared {@link ClusterTenant} contract shape.
 *
 * @param row - The persisted cluster_tenants row.
 * @returns The contract representation returned to API clients.
 */
export function _ToContract(row: ClusterTenantRow): ClusterTenant
{
  return {
    name: row.name,
    displayName: row.displayName,
    ...(row.vanityDomain ? { vanityDomain: row.vanityDomain } : {}),
    isolationTier: _FromPrismaTier(row.isolationTier as unknown as string),
    compute: {
      mode: _FromPrismaCompute(row.computeMode as unknown as string),
      ...(row.nodePool ? { nodePool: row.nodePool } : {}),
    },
    resources: { quota: (row.quota as ClusterTenantResourceQuota | null) ?? {} },
    // Public per-org Zitadel OIDC ids (set after `provisionOrg`). Included only when at
    // least one id is present, so the CR-projection (and merge-patch) does not carry an
    // empty `zitadel` block on an as-yet-unprovisioned org.
    ...((row.zitadelClientId || row.zitadelOrgId || row.zitadelRedirectUri)
      ? {
          zitadel: {
            ...(row.zitadelClientId ? { clientId: row.zitadelClientId } : {}),
            ...(row.zitadelOrgId ? { orgId: row.zitadelOrgId } : {}),
            ...(row.zitadelRedirectUri ? { redirectUri: row.zitadelRedirectUri } : {}),
          },
        }
      : {}),
    status: {
      phase: _FromPrismaPhase(row.phase),
      ...(row.message ? { message: row.message } : {}),
      ...(row.boundNamespace ? { boundNamespace: row.boundNamespace } : {}),
      ...(row.provisioner ? { provisioner: row.provisioner } : {}),
    },
  };
}
