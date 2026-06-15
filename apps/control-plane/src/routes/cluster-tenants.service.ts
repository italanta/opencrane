import { ClusterTenantComputeMode, ClusterTenantIsolationTier, ClusterTenantPhase } from "@opencrane/contracts";
import type { ClusterTenant, ClusterTenantResourceQuota } from "@opencrane/contracts";
import type { Prisma } from "@prisma/client";

import type { ClusterTenantComputeInput, ClusterTenantResourcesInput } from "./cluster-tenants.models.js";

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
    isolationTier: _FromPrismaTier(row.isolationTier as unknown as string),
    compute: {
      mode: _FromPrismaCompute(row.computeMode as unknown as string),
      ...(row.nodePool ? { nodePool: row.nodePool } : {}),
    },
    resources: { quota: (row.quota as ClusterTenantResourceQuota | null) ?? {} },
    status: {
      phase: _FromPrismaPhase(row.phase),
      ...(row.message ? { message: row.message } : {}),
      ...(row.boundNamespace ? { boundNamespace: row.boundNamespace } : {}),
      ...(row.provisioner ? { provisioner: row.provisioner } : {}),
    },
  };
}
