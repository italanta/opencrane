import { describe, it, expect } from "vitest";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import { _ResolveOrgServingDomain } from "../../tenants/internal/org-serving-domain.js";

describe("TenantOperator", () =>
{
  it("builds correct resource names from tenant name", () =>
  {
    const tenant = _makeTenant("jente");
    const name = tenant.metadata!.name;

    expect(`openclaw-${name}`).toBe("openclaw-jente");
    expect(`openclaw-${name}-config`).toBe("openclaw-jente-config");
    expect(`openclaw-${name}-encryption-key`).toBe("openclaw-jente-encryption-key");
    expect(`openclaw-${name}-bucket`).toBe("openclaw-jente-bucket");
  });

  it("serves a user at the ORG host (no per-user subdomain)", () =>
  {
    // The user reaches their pod through the org host `<org>.<base>` via the in-operator
    // proxy; there is no `<user>.<org>.<base>` host any more.
    expect(_ResolveOrgServingDomain("acme", undefined, defaultConfig.ingressDomain)).toBe("acme.opencrane.local");
    expect(_ResolveOrgServingDomain(undefined, undefined, defaultConfig.ingressDomain)).toBe("opencrane.local");
  });

  it("respects custom image override", () =>
  {
    const tenant = _makeTenant("mike", {
      openclawImage: "custom-registry/openclaw:v2",
    });

    const image = tenant.spec.openclawImage ?? defaultConfig.tenantDefaultImage;
    expect(image).toBe("custom-registry/openclaw:v2");
  });

  it("falls back to default image when no override", () =>
  {
    const tenant = _makeTenant("anna");

    const image = tenant.spec.openclawImage ?? defaultConfig.tenantDefaultImage;
    expect(image).toBe("ghcr.io/opencrane/tenant:latest");
  });

  it("detects suspended tenants", () =>
  {
    const active = _makeTenant("active");
    const suspended = _makeTenant("paused", { suspended: true });

    expect(active.spec.suspended).toBeFalsy();
    expect(suspended.spec.suspended).toBe(true);
  });

  it("merges config overrides", () =>
  {
    const tenant = _makeTenant("custom", {
      configOverrides: {
        agents: { defaults: { thinking: "high" } },
      },
    });

    const baseConfig = {
      gateway: { mode: "local", port: 18789, bind: "lan" },
    };

    const merged: Record<string, unknown> = tenant.spec.configOverrides
      ? { ...baseConfig, ...tenant.spec.configOverrides }
      : baseConfig;

    expect(merged.agents).toEqual({ defaults: { thinking: "high" } });
  });

  it("supports openclawVersion on tenant spec", () =>
  {
    const tenant = _makeTenant("versioned", { openclawVersion: "2026.3.15" });
    expect(tenant.spec.openclawVersion).toBe("2026.3.15");
  });

  it("defaults openclawVersion to the pinned operator default (not latest) when not set", () =>
  {
    const tenant = _makeTenant("default-version");
    const version = tenant.spec.openclawVersion ?? defaultConfig.defaultOpenclawVersion;
    expect(version).toBe("2026.6.9");
    expect(version).not.toBe("latest");
  });
});

describe("ServiceAccount (Workload Identity)", () =>
{
  it("generates correct GCP service account annotation via adapter", () =>
  {
    const name = "jente";
    const projectId = "my-gcp-project";
    const expected = `openclaw-${name}@${projectId}.iam.gserviceaccount.com`;

    expect(expected).toBe("openclaw-jente@my-gcp-project.iam.gserviceaccount.com");
  });
});
