import type * as k8s from "@kubernetes/client-node";

import type { ClusterTenantQuotaView } from "../internal/cluster-tenant-resolution.types.js";

/** Resource name the GPU quota/limit is expressed under (NVIDIA device plugin convention). */
const GPU_RESOURCE_NAME = "requests.nvidia.com/gpu";

/** Default per-container CPU request applied by the LimitRange when none is set on a pod. */
const DEFAULT_CONTAINER_CPU_REQUEST = "100m";

/** Default per-container memory request applied by the LimitRange when none is set on a pod. */
const DEFAULT_CONTAINER_MEMORY_REQUEST = "128Mi";

/** Default per-container CPU limit applied by the LimitRange when none is set on a pod. */
const DEFAULT_CONTAINER_CPU_LIMIT = "1";

/** Default per-container memory limit applied by the LimitRange when none is set on a pod. */
const DEFAULT_CONTAINER_MEMORY_LIMIT = "1Gi";

/**
 * Build the namespace-wide ResourceQuota derived from a ClusterTenant's
 * `spec.resources.quota`.
 *
 * The quota is the aggregate ceiling for the customer's fenced namespace: it
 * caps total CPU/memory requests, pod count, persistent-storage claims, and
 * GPU requests across every openclaw the customer runs. Only the dimensions the
 * customer actually specified are stamped, so an unset field stays
 * unconstrained rather than being forced to zero. Ref-less openclaws never
 * reach this builder, so the default path renders no quota at all.
 *
 * @param namespace - The bound namespace the quota is enforced over.
 * @param clusterTenantName - Parent ClusterTenant name, recorded as a label.
 * @param quota - The aggregate quota view carried by the CT.4 resolution.
 * @returns A ResourceQuota object scoped to the namespace.
 * @see https://kubernetes.io/docs/concepts/policy/resource-quotas/ - ResourceQuota reference
 */
export function _BuildClusterTenantResourceQuota(namespace: string, clusterTenantName: string,
                                                 quota: ClusterTenantQuotaView): k8s.V1ResourceQuota
{
  // 1. Hard limits — translate each present quota dimension to its Kubernetes
  //    ResourceQuota key. Absent dimensions are skipped so they stay unbounded
  //    instead of collapsing to a zero ceiling that would block all scheduling.
  const hard: Record<string, string> = {};
  if (quota.cpu !== undefined) hard["requests.cpu"] = quota.cpu;
  if (quota.memory !== undefined) hard["requests.memory"] = quota.memory;
  if (quota.pods !== undefined) hard.pods = String(quota.pods);
  if (quota.storage !== undefined) hard["requests.storage"] = quota.storage;
  if (quota.gpu !== undefined) hard[GPU_RESOURCE_NAME] = String(quota.gpu);

  // 2. Object — wrap the computed hard limits in a namespaced ResourceQuota so
  //    the api-server admission controller rejects any request that would push
  //    the customer's namespace past its allotment.
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "opencrane-cluster-tenant-quota",
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-operator",
        "opencrane.io/cluster-tenant": clusterTenantName,
      },
    },
    spec: {
      hard,
    },
  };
}

/**
 * Build a sensible default LimitRange for the customer's namespace.
 *
 * A ResourceQuota that constrains `requests.cpu`/`requests.memory` requires
 * every container to declare requests, otherwise the api-server rejects the
 * pod. The LimitRange supplies safe per-container defaults (and default
 * requests) so workloads that omit explicit values still schedule while
 * remaining accountable against the namespace quota.
 *
 * @param namespace - The bound namespace the limit range applies to.
 * @param clusterTenantName - Parent ClusterTenant name, recorded as a label.
 * @returns A LimitRange object scoped to the namespace.
 * @see https://kubernetes.io/docs/concepts/policy/limit-range/ - LimitRange reference
 */
export function _BuildClusterTenantLimitRange(namespace: string, clusterTenantName: string): k8s.V1LimitRange
{
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: {
      name: "opencrane-cluster-tenant-limits",
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-operator",
        "opencrane.io/cluster-tenant": clusterTenantName,
      },
    },
    spec: {
      limits: [
        {
          type: "Container",
          // `_default` is the client-node field name for the LimitRange `default`
          // (per-container limit) key; it serialises back to `default` on the wire.
          _default: {
            cpu: DEFAULT_CONTAINER_CPU_LIMIT,
            memory: DEFAULT_CONTAINER_MEMORY_LIMIT,
          },
          defaultRequest: {
            cpu: DEFAULT_CONTAINER_CPU_REQUEST,
            memory: DEFAULT_CONTAINER_MEMORY_REQUEST,
          },
        },
      ],
    },
  };
}
