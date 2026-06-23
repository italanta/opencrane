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
 * On create it also stamps the org owner's identity as metadata annotations
 * ({@link _OWNER_EMAIL_ANNOTATION}/{@link _OWNER_SUBJECT_ANNOTATION}). The operator
 * has no database access, so this is the only channel by which the ClusterTenant
 * reconciler can learn who to attribute the org's default Tenant to once it is ready.
 */

/** Annotation carrying the org owner's IdP-verified email, so the operator can attribute the org's default Tenant. */
const _OWNER_EMAIL_ANNOTATION = "opencrane.io/owner-email";

/** Annotation carrying the org owner's OIDC subject, recorded alongside the email for traceability. */
const _OWNER_SUBJECT_ANNOTATION = "opencrane.io/owner-subject";

/** Org owner identity stamped onto the ClusterTenant CR so the operator can seed a default Tenant. */
export interface ClusterTenantOwner
{
  /** The owner's IdP-verified email; becomes the default Tenant's contact email. */
  email?: string;
  /** The owner's OIDC subject (`sub`). */
  subject?: string;
}

/** The cluster-scoped ClusterTenant custom resource shape the control plane emits. */
interface ClusterTenantCr
{
  /** API group/version of the ClusterTenant CRD (`opencrane.io/<version>`). */
  apiVersion: string;
  /** CRD kind discriminator — always `ClusterTenant`. */
  kind: "ClusterTenant";
  /** Object metadata; the org name is the cluster-scoped CR name, plus optional owner annotations. */
  metadata: { name: string; annotations?: Record<string, string> };
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
 * Build the owner-identity annotation map for a CR, or undefined when no owner
 * field is set (so an org create without a resolvable owner carries no annotations
 * rather than empty ones).
 *
 * @param owner - The org owner's email/subject, if known.
 */
function _BuildOwnerAnnotations(owner?: ClusterTenantOwner): Record<string, string> | undefined
{
  const annotations: Record<string, string> = {};
  if (owner?.email?.trim())
  {
    annotations[_OWNER_EMAIL_ANNOTATION] = owner.email.trim();
  }
  if (owner?.subject?.trim())
  {
    annotations[_OWNER_SUBJECT_ANNOTATION] = owner.subject.trim();
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * Project a {@link ClusterTenant} contract object into the cluster-scoped CR spec.
 * Only desired-state fields are carried; status is the operator's to write. The
 * owner's identity, when supplied, is stamped as metadata annotations so the
 * operator can seed the org's default Tenant once it is ready.
 *
 * @param org   - The org contract object (as returned by `_ToContract`).
 * @param owner - The org owner's identity, stamped as annotations when present.
 * @returns The ClusterTenant CR body ready for server-side apply.
 */
function _BuildClusterTenantCr(org: ClusterTenant, owner?: ClusterTenantOwner): ClusterTenantCr
{
  const annotations = _BuildOwnerAnnotations(owner);
  return {
    apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
    kind: "ClusterTenant",
    metadata: { name: org.name, ...(annotations ? { annotations } : {}) },
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
 * @param owner - The org owner's identity, stamped as annotations on create (and merged on update).
 */
export async function _ApplyClusterTenantCr(customApi: k8s.CustomObjectsApi | null, org: ClusterTenant, owner?: ClusterTenantOwner): Promise<void>
{
  if (!customApi) return;

  const body = _BuildClusterTenantCr(org, owner);

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
      // Merge-patch the spec (and owner annotations when present) so the operator's
      // status subresource is untouched; merge-patch on annotations adds/updates the
      // owner keys without dropping any other annotation the operator may have set.
      await customApi.patchClusterCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        plural: CLUSTER_TENANT_CRD_PLURAL,
        name: org.name,
        body: body.metadata.annotations
          ? { metadata: { annotations: body.metadata.annotations }, spec: body.spec }
          : { spec: body.spec },
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

/** Observed-state fields the operator stamps on the ClusterTenant CR status subresource. */
export interface ClusterTenantObservedStatus
{
  /** Current lifecycle phase the operator observed (pending|provisioning|ready|failed). */
  phase?: string;
  /** Human-readable detail, set on failure or transitional states. */
  message?: string;
  /** Namespace the operator bound to this org once provisioned. */
  boundNamespace?: string;
  /** Identifier of the provisioner that owns this org's boundary. */
  provisioner?: string;
}

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
