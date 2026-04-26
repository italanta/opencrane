import type * as k8s from "@kubernetes/client-node";

import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the per-tenant state PVC used when cloud storage is disabled.
 */
export function _BuildStatePvc(tenantName: string, namespace: string): k8s.V1PersistentVolumeClaim
{
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: `openclaw-${tenantName}-state`,
      namespace,
      labels: _BuildTenantLabels(tenantName),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: "1Gi",
        },
      },
    },
  };
}