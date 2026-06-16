import { describe, expect, it } from "vitest";

import { _ResolveIdentityClaims } from "../../infra/auth/oidc.service.js";

/** Default claim names with one configured operator group, mirroring the loader defaults. */
const _CONFIG = {
  groupsClaim: "groups",
  rolesClaim: "roles",
  clusterTenantClaim: "cluster_tenant",
  platformOperatorGroups: ["opencrane-operators"],
};

describe("_ResolveIdentityClaims — role/group/clusterTenant projection (WOI.1)", function _suite()
{
  it("resolves platform-operator when a groups-claim value matches a configured operator group", function _operatorViaGroups()
  {
    const result = _ResolveIdentityClaims({ groups: ["Acme-Users", "OpenCrane-Operators"] }, _CONFIG);

    expect(result.role).toBe("platform-operator");
    expect(result.groups).toEqual(["Acme-Users", "OpenCrane-Operators"]);
  });

  it("matches operator groups case-insensitively and also reads the roles claim", function _operatorViaRoles()
  {
    const result = _ResolveIdentityClaims({ roles: "opencrane-operators" }, _CONFIG);

    expect(result.role).toBe("platform-operator");
    expect(result.groups).toEqual(["opencrane-operators"]);
  });

  it("falls back to customer-admin (least privilege) when no claim matches", function _customerAdmin()
  {
    const result = _ResolveIdentityClaims({ groups: ["acme-admins"] }, _CONFIG);

    expect(result.role).toBe("customer-admin");
  });

  it("treats everyone as customer-admin when no operator groups are configured", function _emptyOperatorSet()
  {
    const result = _ResolveIdentityClaims({ groups: ["opencrane-operators"] }, { ..._CONFIG, platformOperatorGroups: [] });

    expect(result.role).toBe("customer-admin");
  });

  it("surfaces the ClusterTenant from the configured claim when it is a non-empty string", function _clusterTenant()
  {
    const result = _ResolveIdentityClaims({ cluster_tenant: "acme-corp" }, _CONFIG);

    expect(result.clusterTenant).toBe("acme-corp");
  });

  it("omits the ClusterTenant when the claim is absent, blank, or not a string", function _noClusterTenant()
  {
    expect(_ResolveIdentityClaims({}, _CONFIG).clusterTenant).toBeUndefined();
    expect(_ResolveIdentityClaims({ cluster_tenant: "   " }, _CONFIG).clusterTenant).toBeUndefined();
    expect(_ResolveIdentityClaims({ cluster_tenant: 42 }, _CONFIG).clusterTenant).toBeUndefined();
  });

  it("returns an empty group list when neither claim is present", function _noGroups()
  {
    const result = _ResolveIdentityClaims({}, _CONFIG);

    expect(result.groups).toEqual([]);
    expect(result.role).toBe("customer-admin");
  });
});
