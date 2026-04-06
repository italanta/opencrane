import { describe, expect, it } from "vitest";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import { TenantDomains } from "../../tenants/internal/tenant-domains.js";
import { TenantResourceBuilder } from "../../tenants/internal/tenant-resource-builder.js";

describe("TenantResourceBuilder", () =>
{
  it("builds ServiceAccount with Workload Identity annotation", () =>
  {
    const builder = new TenantResourceBuilder(defaultConfig, new TenantDomains(defaultConfig.ingressDomain));
    const tenant = _makeTenant("jente");

    const sa = builder.buildServiceAccount(tenant, "default");

    expect(sa.metadata?.name).toBe("openclaw-jente");
    expect(sa.metadata?.annotations?.["iam.gke.io/gcp-service-account"])
      .toBe("openclaw-jente@my-gcp-project.iam.gserviceaccount.com");
  });

  it("builds ConfigMap with merged override config", () =>
  {
    const builder = new TenantResourceBuilder(defaultConfig, new TenantDomains(defaultConfig.ingressDomain));
    const tenant = _makeTenant("cfg", {
      configOverrides: {
        agents: { defaults: { thinking: "high" } },
      },
    });

    const configMap = builder.buildConfigMap(tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(configMap.metadata?.name).toBe("openclaw-cfg-config");
    expect(payload.agents.defaults.thinking).toBe("high");
  });

  it("builds Deployment with pvc fallback when no cloud storage", () =>
  {
    const localConfig = {
      ...defaultConfig,
      storageProvider: "" as const,
      csiDriver: "",
    };

    const builder = new TenantResourceBuilder(localConfig, new TenantDomains(localConfig.ingressDomain));
    const tenant = _makeTenant("local");

    const deployment = builder.buildDeployment(tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.persistentVolumeClaim?.claimName).toBe("openclaw-local-state");
  });

  it("builds Deployment with csi storage when cloud storage configured", () =>
  {
    const builder = new TenantResourceBuilder(defaultConfig, new TenantDomains(defaultConfig.ingressDomain));
    const tenant = _makeTenant("cloud");

    const deployment = builder.buildDeployment(tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.csi?.driver).toBe("gcsfuse.csi.storage.gke.io");
    expect(tenantStorage?.csi?.volumeAttributes?.bucketName).toBe("opencrane-cloud");
  });

  it("builds Ingress host from tenant domain conventions", () =>
  {
    const builder = new TenantResourceBuilder(defaultConfig, new TenantDomains(defaultConfig.ingressDomain));
    const tenant = _makeTenant("sarah");

    const ingress = builder.buildIngress(tenant, "default");
    const host = ingress.spec?.rules?.[0]?.host;

    expect(host).toBe("sarah.opencrane.local");
  });
});
