import { ClusterTenantIsolationTier } from "@opencrane/contracts";

import { SHARED_PROVISIONER_ID, SharedClusterProvisioner } from "./shared-cluster.provisioner.js";
import { ExternalWebhookProvisioner } from "./external-webhook.provisioner.js";
import { _ReadExternalWebhookConfig } from "./external-webhook.config.js";
import { DefaultClusterTenantProvisionerRegistry } from "./registry.infra.js";
import type { RegisteredProvisioner } from "./registry.infra.js";

/**
 * Build the default registry from the environment.
 *
 * @returns A registry advertising the built-in shared tiers, plus the external
 *   webhook backend (advertising `dedicatedCluster`) only when configured.
 */
export function _BuildClusterTenantProvisionerRegistry(): DefaultClusterTenantProvisionerRegistry
{
  // 1. Always register the built-in shared provisioner — it serves the two
  //    in-cluster tiers and is the platform's default isolation backend.
  const entries: RegisteredProvisioner[] = [
    {
      id: SHARED_PROVISIONER_ID,
      tiers: [ClusterTenantIsolationTier.Shared, ClusterTenantIsolationTier.DedicatedNodes],
      provisioner: new SharedClusterProvisioner(),
    },
  ];

  // 2. Register the external webhook backend only when its env is configured, so
  //    `dedicatedCluster` stays unavailable (rejected by the API) on installs
  //    that have not opted into an out-of-process provisioner.
  const externalConfig = _ReadExternalWebhookConfig();
  if (externalConfig)
  {
    entries.push({
      id: externalConfig.id,
      tiers: [ClusterTenantIsolationTier.DedicatedCluster],
      provisioner: new ExternalWebhookProvisioner(externalConfig),
    });
  }

  return new DefaultClusterTenantProvisionerRegistry(entries);
}
