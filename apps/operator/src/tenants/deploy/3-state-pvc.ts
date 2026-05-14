import type * as k8s from "@kubernetes/client-node";

import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build the per-tenant state PVC used by local and non-cloud installs.
 *
 * This PVC is only used when the operator is not configured with a cloud
 * storage provider/CSI driver pair. In that fallback mode the tenant stores
 * its OpenClaw runtime, sessions, uploads, and other persistent state on a
 * dedicated Kubernetes volume instead of a tenant-scoped bucket mount.
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