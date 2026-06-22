/**
 * Operator-local boundary provisioner for the in-cluster isolation tiers.
 *
 * Mirrors the control plane's `SharedClusterProvisioner` (which was dead code at
 * runtime): the `shared` and `dedicatedNodes` tiers both map a customer to a
 * deterministic namespace `opencrane-<name>`. The operator carries its own copy of
 * this derivation rather than importing the control-plane package, matching the
 * deliberate "operator is self-contained, no cross-app/contracts dependency"
 * posture used elsewhere (see `org-serving-domain.ts`). The string `opencrane-` is
 * the shared boundary contract between control plane and operator.
 *
 * `dedicatedCluster` is NOT served here — it needs an out-of-process webhook
 * backend that lives in the control-plane registry; an org that reaches the
 * operator with that tier is reported `failed` so it never strands silently.
 */

import { ClusterTenantReconcilePhase } from "./shared-cluster.provisioner.types.js";
import type { BoundaryProvisionResult } from "./shared-cluster.provisioner.types.js";

/** Prefix applied to a customer key to derive its bound namespace. */
const _NAMESPACE_PREFIX = "opencrane-";

/** Identifier the built-in shared provisioner advertises in status. */
export const SHARED_PROVISIONER_ID = "shared";

/** The in-cluster tiers the shared provisioner can serve. */
const _SHARED_TIERS = new Set(["shared", "dedicatedNodes"]);

/**
 * Derive the deterministic namespace bound to a customer key.
 *
 * @param name - Customer (ClusterTenant) key.
 * @returns The `opencrane-<name>` namespace name.
 */
export function _NamespaceForOrg(name: string): string
{
  return `${_NAMESPACE_PREFIX}${name}`;
}

/**
 * Resolve the isolation boundary for an org's isolation tier.
 *
 * Pure (no live cluster calls): it resolves the boundary the operator then
 * materialises as a fenced namespace. `shared`/`dedicatedNodes` bind the
 * `opencrane-<name>` namespace and report `ready`; an unsupported tier reports
 * `failed` with a clear message rather than stranding the org in `provisioning`.
 *
 * @param name - The org (ClusterTenant) name.
 * @param isolationTier - The requested isolation tier.
 * @returns The phase, bound namespace, and owning provisioner id.
 */
export function _ProvisionBoundary(name: string, isolationTier: string | undefined): BoundaryProvisionResult
{
  const tier = isolationTier ?? "shared";
  if (!_SHARED_TIERS.has(tier))
  {
    return {
      phase: ClusterTenantReconcilePhase.Failed,
      message: `No in-cluster provisioner serves isolation tier '${tier}'; a dedicatedCluster org needs an external webhook backend.`,
    };
  }

  return {
    phase: ClusterTenantReconcilePhase.Ready,
    boundNamespace: _NamespaceForOrg(name),
    provisioner: SHARED_PROVISIONER_ID,
  };
}
