import { describe, expect, it } from "vitest";

import { _makeAccessPolicy } from "../fixtures.js";
import { PolicyResourceBuilder } from "../../policies/policy-resource-builder.js";

describe("PolicyResourceBuilder", () =>
{
  it("builds NetworkPolicy with DNS + configured egress", () =>
  {
    const builder = new PolicyResourceBuilder();
    const policy = _makeAccessPolicy();

    const netpol = builder.buildNetworkPolicy(policy, "default");

    expect(netpol.metadata?.name).toBe("opencrane-policy-default-egress");
    expect(netpol.spec?.policyTypes).toEqual(["Egress"]);
    expect(netpol.spec?.egress?.length).toBe(2);
    expect(netpol.spec?.egress?.[0]?.ports?.[0]?.port).toBe(53);
    expect(netpol.spec?.podSelector?.matchLabels?.["opencrane.io/tenant"]).toBe("jente");
    expect(netpol.spec?.podSelector?.matchLabels?.["opencrane.io/team"]).toBe("engineering");
  });

  it("builds Cilium policy with exact and wildcard FQDN matches", () =>
  {
    const builder = new PolicyResourceBuilder();
    const policy = _makeAccessPolicy();

    const cilium = builder.buildCiliumPolicy(policy, "default") as Record<string, unknown>;
    const spec = cilium.spec as Record<string, unknown>;
    const egress = (spec.egress as Array<Record<string, unknown>>)[0];
    const fqdn = egress.toFQDNs as Array<Record<string, unknown>>;

    expect(cilium.kind).toBe("CiliumNetworkPolicy");
    expect(cilium.apiVersion).toBe("cilium.io/v2");
    expect(fqdn[0].matchName).toBe("api.openai.com");
    expect(fqdn[1].matchPattern).toBe("*.anthropic.com");
  });
});
