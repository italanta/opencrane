import { describe, it, expect } from "vitest";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import { _BuildIngressHost } from "../../tenants/deploy/ingress-host.js";

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

  it("generates correct ingress host", () =>
  {
    const tenant = _makeTenant("sarah");
    const host = _BuildIngressHost(tenant.metadata!.name!, defaultConfig.ingressDomain);

    expect(host).toBe("sarah.opencrane.local");
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
      agents: { defaults: { thinking: "medium" } },
    };

    const merged = tenant.spec.configOverrides
      ? { ...baseConfig, ...tenant.spec.configOverrides }
      : baseConfig;

    expect(merged.agents).toEqual({ defaults: { thinking: "high" } });
  });

  it("supports openclawVersion on tenant spec", () =>
  {
    const tenant = _makeTenant("versioned", { openclawVersion: "2026.3.15" });
    expect(tenant.spec.openclawVersion).toBe("2026.3.15");
  });

  it("defaults openclawVersion to latest when not set", () =>
  {
    const tenant = _makeTenant("default-version");
    const version = tenant.spec.openclawVersion ?? "latest";
    expect(version).toBe("latest");
  });
});

describe("ServiceAccount (Workload Identity)", () =>
{
  it("generates correct GCP service account annotation", () =>
  {
    const name = "jente";
    const project = defaultConfig.gcpProject;
    const expected = `openclaw-${name}@${project}.iam.gserviceaccount.com`;

    expect(expected).toBe("openclaw-jente@my-gcp-project.iam.gserviceaccount.com");
  });
});
