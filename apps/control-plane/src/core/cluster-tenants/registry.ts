import { ClusterTenantIsolationTier } from "@opencrane/contracts";

import { _ReadExternalWebhookConfig } from "./external-webhook.config.js";
import { DefaultClusterTenantProvisionerRegistry } from "./registry.infra.js";
import type { RegisteredProvisioner } from "./registry.infra.js";

/** Stable identifier the built-in shared backend advertises in the registry. */
export const SHARED_PROVISIONER_ID = "shared";

/**
 * Build the default registry from the environment.
 *
 * The registry is now a pure tier-availability gate (the operator owns provisioning,
 * see DOMAIN.T1/T2), so it carries only `{ id, tiers }` advertisements:
 *  - the built-in shared backend always advertises the two in-cluster tiers;
 *  - the external webhook backend advertises `dedicatedCluster` only when its env is
 *    configured (and validated as HTTPS), so the tier stays unavailable — rejected by
 *    the API — on installs that have not opted into an out-of-process backend.
 *
 * @returns A registry advertising the built-in shared tiers, plus `dedicatedCluster`
 *   when an external webhook backend is configured.
 */
export function _BuildClusterTenantProvisionerRegistry(): DefaultClusterTenantProvisionerRegistry
{
  const entries: RegisteredProvisioner[] = [
    {
      id: SHARED_PROVISIONER_ID,
      tiers: [ClusterTenantIsolationTier.Shared, ClusterTenantIsolationTier.DedicatedNodes],
    },
  ];

  // `_ReadExternalWebhookConfig` still gates the tier (and fails loud on a non-HTTPS
  // endpoint), even though the control plane no longer POSTs to the backend itself.
  const externalConfig = _ReadExternalWebhookConfig();
  if (externalConfig)
  {
    entries.push({
      id: externalConfig.id,
      tiers: [ClusterTenantIsolationTier.DedicatedCluster],
    });
  }

  return new DefaultClusterTenantProvisionerRegistry(entries);
}
