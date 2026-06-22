import * as k8s from "@kubernetes/client-node";
import { ClusterTenantComputeMode } from "@opencrane/contracts";
import type { ClusterTenant } from "@opencrane/contracts";

import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "../../shared/crd-constants.js";

/**
 * DB → Kubernetes bridge for the cluster-scoped ClusterTenant CRD.
 *
 * The control plane is the system of record for an org's DESIRED state (the
 * `cluster_tenants` row); the operator owns the OBSERVED state (`status.phase`,
 * `status.boundNamespace`). Mirroring how `tenantsRouter` dual-writes the Tenant
 * CRD, the create/update/delete handlers project the persisted row into a
 * cluster-scoped `clustertenants` CR so the ClusterTenant reconciler has something
 * to watch. Without this bridge a `POST /cluster-tenants` would persist a `pending`
 * row that nothing ever reconciles ("hollow CRUD shell").
 *
 * The bridge writes ONLY `spec` — never `status` — so a CR write can never clobber
 * the phase/boundNamespace the operator stamps. It is idempotent: create-or-patch
 * (merge-patch the spec), so re-applying the same desired state converges.
 */

/** The cluster-scoped ClusterTenant custom resource shape the control plane emits. */
interface ClusterTenantCr
{
  /** API group/version of the ClusterTenant CRD (`opencrane.io/<version>`). */
  apiVersion: string;
  /** CRD kind discriminator — always `ClusterTenant`. */
  kind: "ClusterTenant";
  /** Object metadata; the org name is the cluster-scoped CR name. */
  metadata: { name: string };
  /** Desired-state spec projected from the persisted org row (never status). */
  spec: {
    /** Human-readable org display name. */
    displayName: string;
    /** Optional customer-vanity domain CNAMEd onto the org apex. */
    vanityDomain?: string;
    /** Isolation tier driving the operator's boundary provisioner selection. */
    isolationTier: string;
    /** Compute placement: shared cluster or a dedicated node pool. */
    compute: { mode: string; nodePool?: string };
    /** Resource governance for the org's bound namespace (quota map). */
    resources: { quota: Record<string, unknown> };
  };
}

/**
 * Project a {@link ClusterTenant} contract object into the cluster-scoped CR spec.
 * Only desired-state fields are carried; status is the operator's to write.
 *
 * @param org - The org contract object (as returned by `_ToContract`).
 * @returns The ClusterTenant CR body ready for server-side apply.
 */
function _BuildClusterTenantCr(org: ClusterTenant): ClusterTenantCr
{
  return {
    apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
    kind: "ClusterTenant",
    metadata: { name: org.name },
    spec: {
      displayName: org.displayName,
      ...(org.vanityDomain ? { vanityDomain: org.vanityDomain } : {}),
      isolationTier: org.isolationTier,
      compute: {
        mode: org.compute.mode,
        ...(org.compute.mode === ClusterTenantComputeMode.Dedicated && org.compute.nodePool
          ? { nodePool: org.compute.nodePool }
          : {}),
      },
      resources: { quota: (org.resources.quota as Record<string, unknown>) ?? {} },
    },
  };
}

/**
 * Apply the cluster-scoped ClusterTenant CR for an org idempotently.
 *
 * Tries to create; on 409 (already exists) merge-patches the spec so an update to
 * the org's desired state propagates without touching operator-owned status. The
 * `customApi` may be null in dev/test wiring with no cluster — in that case the
 * bridge is a no-op (the DB row is still the source of truth and the reconciler is
 * not running anyway).
 *
 * @param customApi - Kubernetes custom-objects client, or null when no cluster is wired.
 * @param org - The org contract object to project into the CR.
 */
export async function _ApplyClusterTenantCr(customApi: k8s.CustomObjectsApi | null, org: ClusterTenant): Promise<void>
{
  if (!customApi) return;

  const body = _BuildClusterTenantCr(org);

  try
  {
    await customApi.createClusterCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      plural: CLUSTER_TENANT_CRD_PLURAL,
      body,
    });
  }
  catch (err: unknown)
  {
    if (_IsAlreadyExists(err))
    {
      // Merge-patch only the spec so the operator's status subresource is untouched.
      await customApi.patchClusterCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        plural: CLUSTER_TENANT_CRD_PLURAL,
        name: org.name,
        body: { spec: body.spec },
      });
      return;
    }
    throw err;
  }
}

/**
 * Delete the cluster-scoped ClusterTenant CR for an org, tolerating 404.
 *
 * @param customApi - Kubernetes custom-objects client, or null when no cluster is wired.
 * @param name - The org (ClusterTenant) name to delete.
 */
export async function _DeleteClusterTenantCr(customApi: k8s.CustomObjectsApi | null, name: string): Promise<void>
{
  if (!customApi) return;

  try
  {
    await customApi.deleteClusterCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      plural: CLUSTER_TENANT_CRD_PLURAL,
      name,
    });
  }
  catch (err: unknown)
  {
    if (_IsNotFound(err)) return;
    throw err;
  }
}

/** Whether a Kubernetes API error carries a given numeric status code (common shapes). */
function _HasK8sStatus(err: unknown, code: number): boolean
{
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; code?: unknown; body?: { code?: unknown } };
  if (e.statusCode === code || e.code === code) return true;
  return typeof e.body === "object" && e.body !== null && (e.body as { code?: unknown }).code === code;
}

/** Whether the error is a Kubernetes 409 AlreadyExists. */
function _IsAlreadyExists(err: unknown): boolean
{
  return _HasK8sStatus(err, 409);
}

/** Whether the error is a Kubernetes 404 NotFound. */
function _IsNotFound(err: unknown): boolean
{
  return _HasK8sStatus(err, 404);
}
