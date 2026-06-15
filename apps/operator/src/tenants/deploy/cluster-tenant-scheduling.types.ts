import type * as k8s from "@kubernetes/client-node";

/**
 * Pod scheduling constraints derived from a ClusterTenant's compute placement
 * policy. Both fields are absent for the shared/unconstrained path, which keeps
 * the openclaw pod spec byte-for-byte identical to the ref-less default.
 */
export interface ClusterTenantScheduling
{
  /** Node label selector pinning the pod to a dedicated node pool, when set. */
  nodeSelector?: Record<string, string>;
  /** Tolerations letting the pod past the dedicated pool's guard taint, when set. */
  tolerations?: k8s.V1Toleration[];
}
