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
 *
 * On create it also projects the org owner's identity into `spec.owner` — first-class,
 * schema-validated desired state, NOT a free-floating annotation. The operator has no
 * database access, so the CR spec is the only channel by which the ClusterTenant
 * reconciler can learn who to attribute the org's default Tenant to once it is ready.
 * Presence is enforced upstream by this control plane (org create 401s with no resolvable
 * subject), so an owner-less org can never be persisted in the first place.
 */

/** Org owner identity projected into the ClusterTenant CR `spec.owner` so the operator can seed a default Tenant. */
export interface ClusterTenantOwner
{
  /** The owner's IdP-verified email; becomes the default Tenant's contact email. */
  email?: string;
  /** The owner's OIDC subject (`sub`). */
  subject?: string;
}

/**
 * Desired-state spec projected from the persisted org row (never status), EXCLUDING the
 * owner. This is the shape sent on a merge-patch (update path): omitting `owner` means a
 * JSON merge-patch leaves the existing `spec.owner` untouched, so an update by a non-owner
 * admin (who has no owner identity to re-assert) can never drop it.
 */
interface ClusterTenantCrSpecPatch
{
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
}

/**
 * The full cluster-scoped ClusterTenant custom resource the control plane emits on create.
 * `spec.owner` is MANDATORY: every org has a single owner (the control plane records it
 * transactionally and 401s a create with no resolvable subject), so a CR can never be born
 * without one. Updates use {@link ClusterTenantCrSpecPatch}, which preserves the owner.
 */
interface ClusterTenantCr
{
  /** API group/version of the ClusterTenant CRD (`opencrane.io/<version>`). */
  apiVersion: string;
  /** CRD kind discriminator — always `ClusterTenant`. */
  kind: "ClusterTenant";
  /** Object metadata; the org name is the cluster-scoped CR name. */
  metadata: { name: string };
  /** Desired-state spec projected from the persisted org row (never status). */
  spec: ClusterTenantCrSpecPatch & {
    /** Org owner identity, so the operator can attribute the org's default Tenant. */
    owner: { subject: string; email?: string };
  };
}

/**
 * Build the `spec.owner` block for a CR, or undefined when no owner subject is
 * resolvable (the dev/test path with no session) — so the projected spec carries a
 * well-formed owner or none at all, never a subject-less stub the CRD would reject.
 *
 * @param owner - The org owner's email/subject, if known.
 */
function _BuildOwnerSpec(owner?: ClusterTenantOwner): { subject: string; email?: string } | undefined
{
  const subject = owner?.subject?.trim();
  if (!subject) return undefined;
  const email = owner?.email?.trim();
  return { subject, ...(email ? { email } : {}) };
}

/**
 * Project a {@link ClusterTenant} contract object into the owner-free desired-state spec.
 * Only desired-state fields are carried; status is the operator's to write, and `owner` is
 * added by the create path (never on update — see {@link ClusterTenantCrSpecPatch}).
 *
 * @param org - The org contract object (as returned by `_ToContract`).
 * @returns The owner-free spec, ready as a create-body fragment or a merge-patch body.
 */
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
 * @param owner - The org owner's identity. Present on create (projected into the mandatory
 *                `spec.owner`); omitted on update, where the spec is merge-patched and the
 *                existing `spec.owner` is preserved.
 */
export async function _ApplyClusterTenantCr(customApi: k8s.CustomObjectsApi | null, org: ClusterTenant, owner?: ClusterTenantOwner): Promise<void>
{
  if (!customApi) return;

  const specPatch = _BuildSpecPatch(org);
  const ownerSpec = _BuildOwnerSpec(owner);

  // Update path: no resolvable owner to assert → merge-patch the spec only. A JSON
  // merge-patch leaves keys it omits (here, `owner`) untouched, so the owner the create
  // stamped is preserved. Tolerates a 404 the way the delete bridge does: the CR cannot
  // be (re)created without an owner, and a missing CR on update is an out-of-band anomaly,
  // not something this write-back can resolve.
  if (!ownerSpec)
  {
    try
    {
      await customApi.patchClusterCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        plural: CLUSTER_TENANT_CRD_PLURAL,
        name: org.name,
        body: { spec: specPatch },
      });
    }
    catch (err: unknown)
    {
      if (_IsNotFound(err)) return;
      throw err;
    }
    return;
  }

  // Create path: full CR including the mandatory `spec.owner`. Idempotent — on 409 the CR
  // already exists, so fall back to the same owner-free spec merge-patch (preserving owner).
  const body: ClusterTenantCr = {
    apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
    kind: "ClusterTenant",
    metadata: { name: org.name },
    spec: { ...specPatch, owner: ownerSpec },
  };

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
      await customApi.patchClusterCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        plural: CLUSTER_TENANT_CRD_PLURAL,
        name: org.name,
        body: { spec: specPatch },
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
