import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _OrgScope, _ResolvePerOrgClient } from "../../infra/auth/per-org-client.js";

/** Build a Prisma stub whose clusterTenant.findUnique returns `row` for any name. */
function _prismaReturning(row: Record<string, unknown> | null): { prisma: PrismaClient; findUnique: ReturnType<typeof vi.fn> }
{
  const findUnique = vi.fn().mockResolvedValue(row);
  const prisma = { clusterTenant: { findUnique } } as unknown as PrismaClient;
  return { prisma, findUnique };
}

describe("_OrgScope — Zitadel org-restriction login scope (S3b)", function _scopeSuite()
{
  it("builds the urn:zitadel:iam:org:id scope for an org id", function _builds()
  {
    expect(_OrgScope("org-123")).toBe("urn:zitadel:iam:org:id:org-123");
  });
});

describe("_ResolvePerOrgClient — host→CT→per-org client (S3b)", function _resolveSuite()
{
  it("resolves a per-org host to its client_id + org id + redirect URI", async function _resolves()
  {
    const { prisma, findUnique } = _prismaReturning({
      name: "acme",
      zitadelClientId: "client-acme",
      zitadelOrgId: "org-acme",
      zitadelRedirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback",
    });

    const resolved = await _ResolvePerOrgClient(prisma, "acme.dev.opencrane.ai");

    expect(resolved).toEqual({
      clusterTenant: "acme",
      clientId: "client-acme",
      orgId: "org-acme",
      redirectUri: "https://acme.dev.opencrane.ai/api/v1/auth/callback",
    });
    // The lookup is keyed by the host's first DNS label — never request-supplied input.
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { name: "acme" } }));
  });

  it("returns null for the platform host (bare host, no derivable silo) — masters fallback", async function _platformHost()
  {
    const { prisma, findUnique } = _prismaReturning(null);

    // No host ⇒ no derivable silo label ⇒ we never hit the DB and fall through.
    expect(await _ResolvePerOrgClient(prisma, undefined)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null for the platform host — its label matches no ClusterTenant (fail-closed)", async function _platformHost()
  {
    // `platform.<base>` yields the label "platform"; no CT is named that, so the DB lookup
    // returns null and login falls through to the masters client.
    const { prisma } = _prismaReturning(null);
    expect(await _ResolvePerOrgClient(prisma, "platform.dev.opencrane.ai")).toBeNull();
  });

  it("returns null for an unknown host label that matches no ClusterTenant (fail-closed)", async function _unknownHost()
  {
    const { prisma } = _prismaReturning(null);
    expect(await _ResolvePerOrgClient(prisma, "ghost.dev.opencrane.ai")).toBeNull();
  });

  it("returns null when the ClusterTenant has no provisioned client_id (fail-closed)", async function _noClientId()
  {
    const { prisma } = _prismaReturning({ name: "acme", zitadelClientId: null, zitadelOrgId: "org-acme", zitadelRedirectUri: null });
    expect(await _ResolvePerOrgClient(prisma, "acme.dev.opencrane.ai")).toBeNull();
  });

  it("returns null when the ClusterTenant has no provisioned org id (fail-closed)", async function _noOrgId()
  {
    const { prisma } = _prismaReturning({ name: "acme", zitadelClientId: "client-acme", zitadelOrgId: null, zitadelRedirectUri: null });
    expect(await _ResolvePerOrgClient(prisma, "acme.dev.opencrane.ai")).toBeNull();
  });
});
