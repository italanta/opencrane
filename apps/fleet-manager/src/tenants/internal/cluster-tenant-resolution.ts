import type * as k8s from "@kubernetes/client-node";

import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "@opencrane/infra-api";
import type { Tenant } from "../models/tenant.interface.js";
import type { ClusterTenantResource, ClusterTenantResolutionResult } from "./cluster-tenant-resolution.types.js";

/**
 * Resolve the parent ClusterTenant for an openclaw and determine the namespace
 * its child resources must be deployed into.
 *
 * Multi-tenancy is opt-in. When `tenant.spec.clusterTenantRef` is absent the
 * openclaw belongs to the implicit default cluster tenant bound to the install
 * namespace, so the resolver returns `installNamespace` unchanged and the
 * reconcile path behaves byte-for-byte as it did before ClusterTenant existed.
 * When a ref is set the parent is fetched (cluster-scoped) and its
 * `status.boundNamespace` becomes the deployment target; the resolved resource
 * is returned so CT.5 can later stamp its compute/quota policy.
 *
 * @param customApi - Client for cluster-scoped custom objects.
 * @param tenant - The openclaw being reconciled.
 * @param installNamespace - Namespace used for the default (ref-less) path.
 * @returns The deployment target namespace and the resolved parent when ref'd.
 * @see https://kubernetes.io/docs/reference/using-api/api-concepts/ - API reference
 */
export async function _ResolveClusterTenant(customApi: k8s.CustomObjectsApi, tenant: Tenant,
                                            installNamespace: string): Promise<ClusterTenantResolutionResult>
{
  const ref = tenant.spec.clusterTenantRef;

  // 1. Default path — no parent referenced. Return the install namespace so a
  //    ref-less openclaw attaches to the implicit default cluster tenant; this
  //    keeps single-install behaviour identical to the pre-ClusterTenant code.
  if (!ref)
  {
    return {
      targetNamespace: installNamespace,
      ref: false,
    };
  }

  // 2. Opt-in path — fetch the cluster-scoped parent so we can read its bound
  //    namespace. The lookup is required because the openclaw must land in the
  //    customer's fenced namespace, not the install namespace.
  const clusterTenant = await customApi.getClusterCustomObject({
    group: OPENCRANE_API_GROUP,
    version: OPENCRANE_API_VERSION,
    plural: CLUSTER_TENANT_CRD_PLURAL,
    name: ref,
  }) as ClusterTenantResource;

  // 3. Bound namespace gate — the parent must be provisioned (status.boundNamespace
  //    set) before any openclaw can attach; failing fast surfaces a clear error to
  //    the caller instead of silently deploying into the wrong namespace.
  const boundNamespace = clusterTenant.status?.boundNamespace;
  if (!boundNamespace)
  {
    throw new Error(`clusterTenantRef '${ref}' has no bound namespace yet (status.boundNamespace is unset)`);
  }

  return {
    targetNamespace: boundNamespace,
    ref: true,
    clusterTenant,
  };
}
