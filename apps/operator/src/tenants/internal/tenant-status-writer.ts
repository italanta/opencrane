import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { Tenant } from "../models/tenant.interface.js";
import type { TenantStatus } from "../models/tenant-status.interface.js";

/** Kubernetes API group for OpenCrane CRDs. */
const API_GROUP = "opencrane.io";

/** API version for the Tenant CRD. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the Tenant CRD. */
const PLURAL = "tenants";

/**
 * Handles status patching for Tenant resources.
 */
export class TenantStatusWriter
{
  /** Client for managing custom object subresources (status updates). */
  private customApi: k8s.CustomObjectsApi;

  /** Scoped logger for tenant-status-writer messages. */
  private log: Logger;

  /**
   * Create a new TenantStatusWriter.
    * @param customApi - Kubernetes CustomObjects API client used to patch Tenant status.
    * @param log - Root logger used to create a tenant-status-writer scoped logger.
   */
  constructor(customApi: k8s.CustomObjectsApi, log: Logger)
  {
    this.customApi = customApi;
    this.log = log.child({ component: "tenant-status-writer" });
  }

  /**
   * Patch the status subresource of a Tenant CR with the given fields.
    * @param tenant - Tenant resource whose status should be updated.
    * @param namespace - Namespace where the Tenant resource exists.
    * @param status - Partial status fields to merge into the current Tenant status.
   */
  async patchStatus(tenant: Tenant, namespace: string, status: Partial<TenantStatus>): Promise<void>
  {
    const name = tenant.metadata!.name!;
    try
    {
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { status: { ...tenant.status, ...status } },
      });
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to update tenant status");
    }
  }
}
