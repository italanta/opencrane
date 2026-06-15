import { ClusterTenantPhase } from "@opencrane/contracts";
import type { ClusterTenantProvisionRequest, ClusterTenantProvisionResult } from "@opencrane/contracts";

import type { ClusterTenantProvisioner } from "./provisioner.types.js";

/** Stable identifier the built-in shared provisioner advertises in the registry. */
export const SHARED_PROVISIONER_ID = "shared";

/** Prefix applied to a customer key to derive its bound namespace. */
const _NAMESPACE_PREFIX = "opencrane-";

/**
 * Derive the deterministic namespace name bound to a customer key.
 *
 * @param name - Customer key.
 * @returns The `opencrane-<name>` namespace name.
 */
function _NamespaceFor(name: string): string
{
  return `${_NAMESPACE_PREFIX}${name}`;
}

/**
 * Built-in provisioner that fences a customer inside a shared cluster. It serves
 * the `shared` and `dedicatedNodes` tiers by mapping the customer to a namespace
 * (`opencrane-<name>`); the operator later stamps `nodeSelector`/`tolerations`
 * for the dedicated-nodes case. It does not talk to a live cluster here — it
 * resolves the boundary the management API persists.
 */
export class SharedClusterProvisioner implements ClusterTenantProvisioner
{
  /** Provision a `shared`/`dedicatedNodes` boundary by binding a namespace. */
  async provision(req: ClusterTenantProvisionRequest): Promise<ClusterTenantProvisionResult>
  {
    return {
      phase: ClusterTenantPhase.Ready,
      boundNamespace: _NamespaceFor(req.name),
    };
  }

  /** Tear down the shared boundary; namespace teardown is a no-op at this layer. */
  async deprovision(name: string): Promise<void>
  {
    void name;
  }

  /** Report the boundary as ready with its deterministically derived namespace. */
  async getStatus(name: string): Promise<ClusterTenantProvisionResult>
  {
    return {
      phase: ClusterTenantPhase.Ready,
      boundNamespace: _NamespaceFor(name),
    };
  }

  /** Shared tenants reuse the cluster's own kubeconfig, so none is brokered here. */
  async getKubeconfigRef(name: string): Promise<string | null>
  {
    void name;
    return null;
  }
}
