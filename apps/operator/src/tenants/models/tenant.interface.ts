import type { KubernetesObject } from "@kubernetes/client-node";

import type { TenantSpec } from "./tenant-spec.interface.js";
import type { TenantStatus } from "./tenant-status.interface.js";

/**
 * Full Tenant custom resource, extending the base KubernetesObject
 * with a typed spec and optional status.
 */
export interface Tenant extends KubernetesObject
{
  /** Desired state of the tenant. */
  spec: TenantSpec;

  /** Observed state of the tenant, managed by the operator. */
  status?: TenantStatus;
}
