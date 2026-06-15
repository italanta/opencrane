import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";

import { _makeTenant, _makeClusterTenant, defaultConfig } from "../fixtures.js";
import { _ResolveClusterTenant } from "../../tenants/internal/cluster-tenant-resolution.js";
import type { ClusterTenantResource } from "../../tenants/internal/cluster-tenant-resolution.types.js";

/**
 * Build a stub CustomObjectsApi whose `getClusterCustomObject` returns the
 * supplied ClusterTenant (or throws when none is provided), so resolution can
 * be exercised without a live cluster.
 */
function _makeStubApi(clusterTenant?: ClusterTenantResource): k8s.CustomObjectsApi
{
  return {
    async getClusterCustomObject(): Promise<unknown>
    {
      if (!clusterTenant)
      {
        throw new Error("not found");
      }
      return clusterTenant;
    },
  } as unknown as k8s.CustomObjectsApi;
}

describe("_ResolveClusterTenant", () =>
{
  it("default mode (no clusterTenantRef) resolves to the install namespace unchanged", async () =>
  {
    const tenant = _makeTenant("jente");
    const api = _makeStubApi();

    const result = await _ResolveClusterTenant(api, tenant, defaultConfig.watchNamespace);

    expect(result.ref).toBe(false);
    expect(result.targetNamespace).toBe(defaultConfig.watchNamespace);
    expect(result.clusterTenant).toBeUndefined();
  });

  it("default mode falls back to the Tenant CR's own namespace as install namespace", async () =>
  {
    const tenant = _makeTenant("anna", { namespace: "team-a" });
    const api = _makeStubApi();

    const result = await _ResolveClusterTenant(api, tenant, tenant.metadata!.namespace!);

    expect(result.ref).toBe(false);
    expect(result.targetNamespace).toBe("team-a");
  });

  it("ref'd openclaw resolves to the parent ClusterTenant's bound namespace", async () =>
  {
    const tenant = _makeTenant("mike", { clusterTenantRef: "acme" });
    const api = _makeStubApi(_makeClusterTenant("acme", "ct-acme"));

    const result = await _ResolveClusterTenant(api, tenant, defaultConfig.watchNamespace);

    expect(result.ref).toBe(true);
    expect(result.targetNamespace).toBe("ct-acme");
    expect(result.clusterTenant?.metadata?.name).toBe("acme");
  });

  it("ref'd openclaw whose parent has no bound namespace throws", async () =>
  {
    const tenant = _makeTenant("sarah", { clusterTenantRef: "pending-customer" });
    const api = _makeStubApi(_makeClusterTenant("pending-customer"));

    await expect(_ResolveClusterTenant(api, tenant, defaultConfig.watchNamespace)).rejects.toThrow(/bound namespace/);
  });
});
