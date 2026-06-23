import * as k8s from "@kubernetes/client-node";
import type { ClusterTenantObservedStatus } from "@opencrane/contracts";

import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "../../shared/crd-constants.js";

/**
 * Reader for the OBSERVED status the operator stamps on the cluster-scoped ClusterTenant CR.
 *
 * Separate from `cr-bridge.ts` on purpose: the bridge writes DESIRED state (`spec`) and never
 * touches `status`; this module does the opposite — it READS the `status` subresource the
 * operator owns. Keeping the read path out of the write-only bridge keeps each module's
 * contract honest.
 */

/**
 * Read the OBSERVED status the operator stamped on the cluster-scoped ClusterTenant CR.
 *
 * The control plane persists DESIRED state to Postgres and never writes status back; the
 * operator advances `status.phase` (pending→provisioning→ready) on the CR's status
 * subresource. The DB `phase` column therefore stays at its seeded `pending` forever, so
 * the read path must consult the CR to report real provisioning progress (the
 * onboarding poll otherwise never leaves `pending`).
 *
 * Returns null when no cluster is wired (`customApi` null), the CRD/CR is absent, or any
 * read error — callers then fall back to the DB-derived status, preserving behaviour in
 * non-cluster (dev/test) environments and never hard-failing the status endpoint on a
 * transient cluster blip.
 *
 * @param customApi - Kubernetes custom-objects client, or null when no cluster is wired.
 * @param name - The org (ClusterTenant) name whose observed status to read.
 */
export async function _ReadClusterTenantObservedStatus(customApi: k8s.CustomObjectsApi | null, name: string): Promise<ClusterTenantObservedStatus | null>
{
  if (!customApi) return null;

  try
  {
    const cr = await customApi.getClusterCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      plural: CLUSTER_TENANT_CRD_PLURAL,
      name,
    });
    const status = (cr as { status?: ClusterTenantObservedStatus } | undefined)?.status;
    return status && typeof status === "object" ? status : null;
  }
  catch
  {
    // No CRD / CR not found / cluster unreachable → caller falls back to the DB status.
    return null;
  }
}
