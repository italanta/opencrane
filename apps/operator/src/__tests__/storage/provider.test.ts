import { describe, it, expect } from "vitest";

import { buildBucketClaim } from "../../storage/provider.js";

describe("StorageProvider", () =>
{
  it("builds bucket claim with correct name and prefix", () =>
  {
    const claim = buildBucketClaim("jente", "default", "opencrane");

    expect(claim.metadata?.name).toBe("openclaw-jente-bucket");
    expect((claim as Record<string, unknown>).spec).toEqual({
      bucketName: "opencrane-jente",
      tenantName: "jente",
    });
  });

  it("includes tenant label on bucket claim", () =>
  {
    const claim = buildBucketClaim("sarah", "default", "myprefix");

    expect(claim.metadata?.labels?.["opencrane.io/tenant"]).toBe("sarah");
  });

  it("generates correct GCS bucket name from prefix and tenant", () =>
  {
    const claim = buildBucketClaim("mike", "prod", "acme-ai");
    const spec = (claim as Record<string, unknown>).spec as Record<string, unknown>;

    expect(spec.bucketName).toBe("acme-ai-mike");
  });
});
