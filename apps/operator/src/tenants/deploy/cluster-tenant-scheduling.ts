import type * as k8s from "@kubernetes/client-node";

import type { ClusterTenantComputeView } from "../internal/cluster-tenant-resolution.types.js";
import type { ClusterTenantScheduling } from "./cluster-tenant-scheduling.types.js";

/** Node label key a dedicated openclaw pod is pinned to (matches the node pool name). */
const NODE_POOL_LABEL = "opencrane.io/node-pool";

/** Taint key dedicated node pools carry so only matching ClusterTenant pods land there. */
const DEDICATED_TAINT_KEY = "opencrane.io/dedicated";

/**
 * Derive the pod scheduling constraints (nodeSelector + tolerations) for an
 * openclaw from its parent ClusterTenant `spec.compute`.
 *
 * Mode `dedicated` pins the pod to the customer's node pool: a nodeSelector
 * targets the pool label and a matching toleration lets the pod past the
 * pool's `NoSchedule` taint that keeps other tenants off. Mode `shared` (and
 * any unset/unknown mode, or a dedicated mode missing its `nodePool`) returns
 * an empty object so the pod schedules anywhere — the default, byte-for-byte
 * behaviour for ref-less openclaws.
 *
 * @param compute - The compute placement view carried by the CT.4 resolution.
 * @returns nodeSelector/tolerations to stamp on the pod spec, empty when unconstrained.
 * @see https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/ - taint/toleration reference
 */
export function _BuildClusterTenantScheduling(compute: ClusterTenantComputeView | undefined): ClusterTenantScheduling
{
  // 1. Unconstrained path — shared mode, no compute block, or a dedicated mode
  //    that never named a pool all mean "schedule anywhere". Returning an empty
  //    object keeps the pod spec identical to the pre-ClusterTenant baseline.
  if (!compute || compute.mode !== "dedicated" || !compute.nodePool)
  {
    return {};
  }

  // 2. Dedicated path — pin to the named pool and tolerate its guard taint so
  //    the pod can land on otherwise-fenced nodes reserved for this customer.
  const nodeSelector: Record<string, string> = { [NODE_POOL_LABEL]: compute.nodePool };
  const tolerations: k8s.V1Toleration[] = [
    {
      key: DEDICATED_TAINT_KEY,
      operator: "Equal",
      value: compute.nodePool,
      effect: "NoSchedule",
    },
  ];

  return { nodeSelector, tolerations };
}
