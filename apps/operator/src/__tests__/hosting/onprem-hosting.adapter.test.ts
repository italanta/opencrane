import { describe, expect, it } from "vitest";

import { OnPremHostingAdapter } from "../../hosting/adapters/onprem/onprem-hosting.adapter.js";
import { HostingProvider } from "../../hosting/index.js";

describe("OnPremHostingAdapter", () =>
{
  const adapter = new OnPremHostingAdapter();

  it("reports the onprem provider identifier", () =>
  {
    expect(adapter.provider).toBe(HostingProvider.OnPrem);
  });

  it("provisions storage as a no-op returning null externalName", async () =>
  {
    const binding = await adapter.provisionTenantStorage({ tenantName: "alice", namespace: "default" });

    expect(binding.externalName).toBeNull();
  });

  it("deprovisions storage as a no-op without throwing", async () =>
  {
    await expect(adapter.deprovisionTenantStorage("alice")).resolves.toBeUndefined();
  });

  it("returns empty identity annotations (no cloud binding)", () =>
  {
    expect(adapter.buildServiceAccountIdentity("alice")).toEqual({});
  });

  it("returns a PVC-backed state volume with requiresPvc true", () =>
  {
    const vol = adapter.buildStateVolume("alice");

    expect(vol.requiresPvc).toBe(true);
    expect(vol.volumeMount.mountPath).toBe("/data/openclaw");
    expect(vol.volume.persistentVolumeClaim?.claimName).toBe("openclaw-alice-state");
  });
});
