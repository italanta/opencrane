import type * as k8s from "@kubernetes/client-node";

import type { OperatorConfig } from "../../config.js";
import type { Tenant } from "../models/tenant.interface.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/**
 * Build a ServiceAccount for the tenant pod.
 * When GCP storage is configured, includes the Workload Identity annotation.
 */
export function _BuildServiceAccount(config: OperatorConfig, tenant: Tenant, namespace: string): k8s.V1ServiceAccount
{
  const name = tenant.metadata!.name!;
  const annotations: Record<string, string> = {};

  if (config.storageProvider === "gcs" && config.gcpProject)
  {
    annotations["iam.gke.io/gcp-service-account"] =
      `openclaw-${name}@${config.gcpProject}.iam.gserviceaccount.com`;
  }

  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: `openclaw-${name}`,
      namespace,
      labels: _BuildTenantLabels(name),
      annotations,
    },
  };
}