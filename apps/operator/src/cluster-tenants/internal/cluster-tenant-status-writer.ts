import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "../../shared/crd-constants.js";
import type { ClusterTenantResource } from "../../tenants/internal/cluster-tenant-resolution.types.js";

/** Observed-state fields the reconciler patches onto a ClusterTenant status. */
export interface ClusterTenantStatusPatch
{
  /** Current lifecycle phase (pending|provisioning|ready|failed). */
  phase?: string;
  /** Human-readable detail, set on failure or transitional states. */
  message?: string;
  /** Namespace bound to this customer once provisioned. */
  boundNamespace?: string;
  /** Identifier of the provisioner that owns this customer's boundary. */
  provisioner?: string;
  /** Canonical org apex the domain step provisioned (or would have). */
  orgDomain?: string;
  /** Whether the per-org domain (DNS + wildcard TLS) step completed. */
  domainReady?: boolean;
  /** True when the per-org domain step was skipped (no cert-manager/DNS backend). */
  domainSkipped?: boolean;
}

/**
 * Patches the status subresource of the cluster-scoped ClusterTenant CR.
 *
 * Mirrors `TenantStatusWriter` but targets a CLUSTER-scoped object
 * (`patchClusterCustomObjectStatus`, no namespace). Merges the patch onto the
 * existing status so partial updates (e.g. flipping just `domainReady`) never drop
 * other observed fields.
 */
export class ClusterTenantStatusWriter
{
  /** Client for managing custom object subresources (status updates). */
  private customApi: k8s.CustomObjectsApi;

  /** Scoped logger. */
  private log: Logger;

  /**
   * @param customApi - Kubernetes CustomObjects API client used to patch status.
   * @param log - Root logger; scoped to `cluster-tenant-status-writer`.
   */
  constructor(customApi: k8s.CustomObjectsApi, log: Logger)
  {
    this.customApi = customApi;
    this.log = log.child({ component: "cluster-tenant-status-writer" });
  }

  /**
   * Patch the status subresource of a ClusterTenant CR, merging onto current status.
   *
   * @param clusterTenant - The CR whose status should be updated.
   * @param status - Partial status fields to merge into the current status.
   */
  async patchStatus(clusterTenant: ClusterTenantResource, status: ClusterTenantStatusPatch): Promise<void>
  {
    const name = clusterTenant.metadata?.name;
    if (!name) return;

    const mergedStatus = { ...clusterTenant.status, ...status };

    try
    {
      // JSON Patch "add" on /status replaces the member value per RFC 6902 — matches
      // the json-patch content type this client defaults to (see TenantStatusWriter).
      await this.customApi.patchClusterCustomObjectStatus({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        plural: CLUSTER_TENANT_CRD_PLURAL,
        name,
        body: [{ op: "add", path: "/status", value: mergedStatus }],
      });
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to update cluster tenant status");
    }
  }
}
