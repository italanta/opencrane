import * as k8s from "@kubernetes/client-node";
import { ClusterTenantComputeMode } from "@opencrane/contracts";
import type { ClusterTenant } from "@opencrane/contracts";

import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, _IsK8sConflict, _IsK8sNotFound } from "@opencrane/infra-api";
import type { ClusterTenantCrSpecPatch, ClusterTenantOwner, ClusterTenantSpec } from "./cr-bridge.types.js";

/**
 * DB → Kubernetes bridge for the cluster-scoped ClusterTenant CRD.
 *
 * The control plane is the system of record for an org's DESIRED state (the
 * `cluster_tenants` row); the operator owns the OBSERVED state (`status.phase`,
 * `status.boundNamespace`). The bridge writes ONLY `spec` — never `status` — so
 * a CR write can never clobber the phase/boundNamespace the operator stamps.
 *
 * Three named steps compose the apply path:
 *   1. {@link _BuildSpecPatch}  — project the persisted row into the owner-free spec.
 *   2. {@link _PatchSpec}       — merge-patch the spec onto an existing CR (update).
 *   3. {@link _CreateCr}        — create a full CR with mandatory `spec.owner` (create).
 *
 * {@link _ApplyClusterTenantCr} orchestrates: create (with owner) → on 409 fall back
 * to patch; update (no owner) → patch only, tolerate 404.
 */

export type { ClusterTenantOwner } from "./cr-bridge.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full cluster-scoped ClusterTenant custom resource emitted on create. */
interface ClusterTenantCr
{
  apiVersion: string;
  kind: "ClusterTenant";
  metadata: { name: string };
  spec: ClusterTenantSpec;
}

// ---------------------------------------------------------------------------
// Step 1 — Build
// ---------------------------------------------------------------------------

function _BuildOwnerSpec(owner?: Partial<ClusterTenantOwner>): ClusterTenantOwner | undefined
{
  const subject = owner?.subject?.trim();
  if (!subject) return undefined;
  const email = owner?.email?.trim();
  return { subject, ...(email ? { email } : {}) };
}

function _BuildSpecPatch(org: ClusterTenant): ClusterTenantCrSpecPatch
{
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Patch (update path)
// ---------------------------------------------------------------------------

/**
 * Merge-patch the owner-free spec onto an existing CR. Tolerates 404 — a missing
 * CR on the update path is an out-of-band anomaly, not something this write-back
 * can resolve (a re-create requires an owner).
 */
async function _PatchSpec(customApi: k8s.CustomObjectsApi, name: string, specPatch: ClusterTenantCrSpecPatch): Promise<void>
{
  try
  {
    await customApi.patchClusterCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      plural: CLUSTER_TENANT_CRD_PLURAL,
      name,
      body: { spec: specPatch },
    });
  }
  catch (err: unknown)
  {
    if (_IsK8sNotFound(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Create (create path)
// ---------------------------------------------------------------------------

/**
 * Create the full CR with mandatory `spec.owner`. Returns `true` when created,
 * `false` when the CR already existed (409).
 */
async function _CreateCr(customApi: k8s.CustomObjectsApi, body: ClusterTenantCr): Promise<boolean>
{
  try
  {
    await customApi.createClusterCustomObject({
      group: OPENCRANE_API_GROUP,
      version: OPENCRANE_API_VERSION,
      plural: CLUSTER_TENANT_CRD_PLURAL,
      body,
    });
    return true;
  }
  catch (err: unknown)
  {
    if (_IsK8sConflict(err)) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply the cluster-scoped ClusterTenant CR idempotently.
 *
 * With owner (create path): build full CR → {@link _CreateCr} → on 409 fall back
 * to {@link _PatchSpec}. Without owner (update path): {@link _PatchSpec} only.
 */
export async function _ApplyClusterTenantCr(customApi: k8s.CustomObjectsApi | null, org: ClusterTenant, owner?: Partial<ClusterTenantOwner>): Promise<void>
{
  if (!customApi) return;

  const specPatch = _BuildSpecPatch(org);
  const ownerSpec = _BuildOwnerSpec(owner);

  if (!ownerSpec)
  {
    await _PatchSpec(customApi, org.name, specPatch);
    return;
  }

  const body: ClusterTenantCr = {
    apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
    kind: "ClusterTenant",
    metadata: { name: org.name },
    spec: { ...specPatch, owner: ownerSpec },
  };

  const created = await _CreateCr(customApi, body);
  if (!created)
  {
    await _PatchSpec(customApi, org.name, specPatch);
  }
}

/**
 * Delete the cluster-scoped ClusterTenant CR, tolerating 404.
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
    if (_IsK8sNotFound(err)) return;
    throw err;
  }
}
