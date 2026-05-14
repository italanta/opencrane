import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "../../shared/crd-constants.js";
import type { Tenant } from "../models/tenant.interface.js";
import type { TenantStatus } from "../models/tenant-status.interface.js";

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
    const mergedStatus = { ...tenant.status, ...status };

    try
    {
      // Use JSON Patch because this client defaults to json-patch content type.
      // "add" on an existing object member replaces its value per RFC 6902.
      await this.customApi.patchNamespacedCustomObjectStatus(
        {
          group: OPENCRANE_API_GROUP,
          version: OPENCRANE_API_VERSION,
          namespace,
          plural: TENANT_CRD_PLURAL,
          name,
          body: [{ op: "add", path: "/status", value: mergedStatus }],
        },
      );
    }
    catch (err)
    {
      this.log.warn({ err, name }, "failed to update tenant status");
    }
  }
}
