import { describe, expect, it, vi, beforeEach } from "vitest";

import { GcpHostingAdapter } from "../../hosting/adapters/gcp/gcp-hosting.adapter.js";
import { HostingProvider } from "../../hosting/index.js";
import type { GcsBucketOperations } from "../../hosting/adapters/gcp/gcp-bucket.client.js";

function _makeFakeBuckets(): GcsBucketOperations & { calls: string[] }
{
  return {
    calls: [],
    async ensureBucket(bucketName: string): Promise<void>
    {
      this.calls.push(bucketName);
    },
  };
}

describe("GcpHostingAdapter", () =>
{
  const gcpConfig = {
    projectId: "my-gcp-project",
    bucketPrefix: "opencrane",
    csiDriver: "gcsfuse.csi.storage.gke.io",
  };

  let fakeBuckets: ReturnType<typeof _makeFakeBuckets>;
  let adapter: GcpHostingAdapter;

  beforeEach(() =>
  {
    fakeBuckets = _makeFakeBuckets();
    adapter = new GcpHostingAdapter(gcpConfig, fakeBuckets);
  });

  it("reports the gcp provider identifier", () =>
  {
    expect(adapter.provider).toBe(HostingProvider.Gcp);
  });

  it("provisions storage by calling ensureBucket with the prefixed name", async () =>
  {
    const binding = await adapter.provisionTenantStorage({ tenantName: "alice", namespace: "default" });

    expect(fakeBuckets.calls).toEqual(["opencrane-alice"]);
    expect(binding.externalName).toBe("opencrane-alice");
  });

  it("is idempotent — repeated provision calls hit ensureBucket each time", async () =>
  {
    await adapter.provisionTenantStorage({ tenantName: "alice", namespace: "default" });
    await adapter.provisionTenantStorage({ tenantName: "alice", namespace: "default" });

    expect(fakeBuckets.calls).toHaveLength(2);
  });

  it("deprovisions storage as a no-op (bucket is retained)", async () =>
  {
    await expect(adapter.deprovisionTenantStorage("alice")).resolves.toBeUndefined();
    expect(fakeBuckets.calls).toHaveLength(0);
  });

  it("returns Workload Identity annotation with the correct GSA email", () =>
  {
    const annotations = adapter.buildServiceAccountIdentity("alice");

    expect(annotations["iam.gke.io/gcp-service-account"])
      .toBe("openclaw-alice@my-gcp-project.iam.gserviceaccount.com");
  });

  it("returns a CSI-backed state volume with requiresPvc false", () =>
  {
    const vol = adapter.buildStateVolume("alice");

    expect(vol.requiresPvc).toBe(false);
    expect(vol.volumeMount.mountPath).toBe("/data/openclaw");
    expect(vol.volume.csi?.driver).toBe("gcsfuse.csi.storage.gke.io");
    expect(vol.volume.csi?.volumeAttributes?.bucketName).toBe("opencrane-alice");
  });

  it("derives bucket names as {prefix}-{tenantName}", async () =>
  {
    await adapter.provisionTenantStorage({ tenantName: "bob", namespace: "default" });

    expect(fakeBuckets.calls[0]).toBe("opencrane-bob");
  });
});
