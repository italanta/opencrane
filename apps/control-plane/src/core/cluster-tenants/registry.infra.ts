import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import type { ClusterTenantProvisionerCapability, ClusterTenantProvisionerRegistry } from "@opencrane/contracts";

import type { ClusterTenantProvisioner } from "./provisioner.types.js";

/**
 * A registered provisioner paired with the tiers it advertises.
 */
export interface RegisteredProvisioner
{
  /** Stable provisioner identifier surfaced in capabilities. */
  id: string;
  /** Isolation tiers this provisioner can satisfy. */
  tiers: ClusterTenantIsolationTier[];
  /** The provisioner instance that materialises the boundary. */
  provisioner: ClusterTenantProvisioner;
}

/**
 * Concrete registry holding the built-in shared provisioner plus any external
 * webhook backend. Tier→provisioner routing is by advertised capability, so the
 * management API can ask whether a tier can be served and resolve the backend
 * that owns it without knowing about specific vendors.
 */
export class DefaultClusterTenantProvisionerRegistry implements ClusterTenantProvisionerRegistry
{
  /** Every registered provisioner with its advertised tiers, in routing order. */
  private readonly registered: RegisteredProvisioner[];

  /**
   * @param entries - Pre-built provisioner registrations (built-in first, external last).
   */
  constructor(entries: RegisteredProvisioner[])
  {
    this.registered = entries;
  }

  /** Whether some registered provisioner advertises the given isolation tier. */
  isTierAvailable(tier: ClusterTenantIsolationTier): boolean
  {
    return this.registered.some(entry => entry.tiers.includes(tier));
  }

  /** Capabilities of every registered provisioner. */
  capabilities(): ClusterTenantProvisionerCapability[]
  {
    return this.registered.map(entry => ({ id: entry.id, supportedTiers: entry.tiers }));
  }

  /**
   * Resolve the provisioner that owns the given tier.
   *
   * @param tier - Isolation tier to route.
   * @returns The owning provisioner, or null when no backend serves the tier.
   */
  provisionerFor(tier: ClusterTenantIsolationTier): ClusterTenantProvisioner | null
  {
    const entry = this.registered.find(item => item.tiers.includes(tier));
    return entry ? entry.provisioner : null;
  }
}
