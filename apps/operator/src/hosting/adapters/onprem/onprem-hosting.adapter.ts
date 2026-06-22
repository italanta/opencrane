import { HostingProvider } from "../../hosting-adapter.types.js";
import type { HostingAdapter, TenantStateVolume, TenantStorageBinding, TenantStorageRequest } from "../../hosting-adapter.types.js";
import { _BuildPvcStateVolume } from "../../core/pvc-state-volume.js";

/** Default hosting adapter: vanilla Kubernetes, no cloud dependency. */
export class OnPremHostingAdapter implements HostingAdapter
{
  /** @inheritdoc */
  public readonly provider: HostingProvider = HostingProvider.OnPrem;

  /** No external storage on-prem; tenant state lives on a PVC. */
  public async provisionTenantStorage(_request: TenantStorageRequest): Promise<TenantStorageBinding>
  {
    return { externalName: null };
  }

  /** Nothing to release on-prem; the PVC lifecycle follows the tenant. */
  public async deprovisionTenantStorage(_tenantName: string): Promise<void>
  {
    return;
  }

  /** Plain ServiceAccount: no cloud identity annotations. */
  public buildServiceAccountIdentity(_tenantName: string): Record<string, string>
  {
    return {};
  }

  /** PVC-backed state volume; the operator must create the PVC. */
  public buildStateVolume(tenantName: string): TenantStateVolume
  {
    return _BuildPvcStateVolume(tenantName);
  }

}
