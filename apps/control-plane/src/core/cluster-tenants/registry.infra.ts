import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import type { ClusterTenantProvisionerCapability, ClusterTenantProvisionerRegistry } from "@opencrane/contracts";

/**
 * A registered backend: just its stable id and the tiers it advertises.
 *
 * The control plane no longer holds provisioner *lifecycle* logic — the operator's
 * ClusterTenant reconciler owns provision/deprovision (see DOMAIN.T1/T2). All this
 * registry does at runtime is answer "can a backend serve this tier?", so an entry
 * needs nothing more than `{ id, tiers }`.
 */
export interface RegisteredProvisioner
{
  /** Stable provisioner identifier surfaced in capabilities. */
  id: string;
  /** Isolation tiers this provisioner advertises. */
  tiers: ClusterTenantIsolationTier[];
}

/**
 * Tier-availability gate for the management API. Tells the create/update path
 * whether some registered backend advertises a requested isolation tier, and
 * advertises the full capability set — nothing more. The provisioning itself is
 * the operator's job.
 */
export class DefaultClusterTenantProvisionerRegistry implements ClusterTenantProvisionerRegistry
{
  /** Every registered backend with its advertised tiers. */
  private readonly registered: RegisteredProvisioner[];

  /**
   * @param entries - Pre-built registrations (built-in first, external last).
   */
  constructor(entries: RegisteredProvisioner[])
  {
    this.registered = entries;
  }

  /** Whether some registered backend advertises the given isolation tier. */
  isTierAvailable(tier: ClusterTenantIsolationTier): boolean
  {
    return this.registered.some(entry => entry.tiers.includes(tier));
  }

  /** Capabilities of every registered backend. */
  capabilities(): ClusterTenantProvisionerCapability[]
  {
    return this.registered.map(entry => ({ id: entry.id, supportedTiers: entry.tiers }));
  }
}
