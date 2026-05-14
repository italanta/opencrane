import { describe, expect, it } from "vitest";

import { defaultConfig, _makeAccessPolicy, _makeTenant } from "../fixtures.js";
import { _BuildConfigMap, _BuildDeployment, _BuildIngress, _BuildServiceAccount, _BuildStatePvc } from "../../tenants/deploy/index.js";

describe("TenantResourceBuilder", () =>
{
  it("builds ServiceAccount with Workload Identity annotation", () =>
  {
    const tenant = _makeTenant("jente");

    const sa = _BuildServiceAccount(defaultConfig, tenant, "default");

    expect(sa.metadata?.name).toBe("openclaw-jente");
    expect(sa.metadata?.annotations?.["iam.gke.io/gcp-service-account"])
      .toBe("openclaw-jente@my-gcp-project.iam.gserviceaccount.com");
  });

  it("builds ConfigMap with merged override config", () =>
  {
    const tenant = _makeTenant("cfg", {
      configOverrides: {
        agents: { defaults: { model: "gpt-4o" } },
      },
    });

    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");
    const runtimeContract = JSON.parse(configMap.data?.["opencrane-managed-runtime.json"] ?? "{}");

    expect(configMap.metadata?.name).toBe("openclaw-cfg-config");
    expect(payload.agents.defaults.model).toBe("gpt-4o");
    expect(runtimeContract.mode).toBe("managed");
    expect(runtimeContract.tenant.name).toBe("cfg");
  });

  it("publishes effective MCP policy details in the managed runtime contract", () =>
  {
    const tenant = _makeTenant("jente", {
      team: "engineering",
      policyRef: "default-egress",
    });

    const policy = _makeAccessPolicy();
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default", policy);
    const runtimeContract = JSON.parse(configMap.data?.["opencrane-managed-runtime.json"] ?? "{}");

    expect(runtimeContract.policy.effectiveRef).toBe("default-egress");
    expect(runtimeContract.policy.mcpServers).toEqual({ allow: ["skills"] });
    expect(runtimeContract.capabilities.mcpPolicyEnforced).toBe(true);
  });

  it("builds Deployment with pvc fallback when no cloud storage", () =>
  {
    const localConfig = {
      ...defaultConfig,
      storageProvider: "" as const,
      csiDriver: "",
    };

    const tenant = _makeTenant("local");

    const deployment = _BuildDeployment(localConfig, tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.persistentVolumeClaim?.claimName).toBe("openclaw-local-state");
  });

  it("builds state PVC for local storage fallback", () =>
  {
    const pvc = _BuildStatePvc("local", "default");

    expect(pvc.metadata?.name).toBe("openclaw-local-state");
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.resources?.requests?.storage).toBe("1Gi");
  });

  it("builds Deployment with csi storage when cloud storage configured", () =>
  {
    const tenant = _makeTenant("cloud");

    const deployment = _BuildDeployment(defaultConfig, tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.csi?.driver).toBe("gcsfuse.csi.storage.gke.io");
    expect(tenantStorage?.csi?.volumeAttributes?.bucketName).toBe("opencrane-cloud");
  });

  it("hardens Deployment runtime defaults and injects managed runtime env", () =>
  {
    const tenant = _makeTenant("strict", {
      policyRef: "restricted-mcp",
      skills: ["company-policy", "deploy-helper"],
    });

    const deployment = _BuildDeployment(defaultConfig, tenant, "default");
    const podSpec = deployment.spec?.template?.spec;
    const container = podSpec?.containers?.[0];
    const envVars = Object.fromEntries((container?.env ?? []).map((entry) => [entry.name ?? "", entry.value ?? ""]));
    const volumeMounts = container?.volumeMounts ?? [];
    const volumes = podSpec?.volumes ?? [];

    expect(podSpec?.securityContext?.runAsNonRoot).toBe(true);
    expect(podSpec?.securityContext?.runAsUser).toBe(1000);
    expect(podSpec?.securityContext?.fsGroup).toBe(1000);
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(container?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    expect(envVars.OPENCRANE_RUNTIME_MODE).toBe("managed");
    expect(envVars.OPENCRANE_RUNTIME_CONTRACT_PATH).toBe("/config/opencrane-managed-runtime.json");
    expect(envVars.OPENCRANE_POLICY_REF).toBe("restricted-mcp");
    expect(envVars.OPENCRANE_ALLOWED_SKILLS).toBe("company-policy,deploy-helper");
    expect(envVars.HOME).toBe("/tmp/opencrane-home");
    expect(envVars.NPM_CONFIG_CACHE).toBe("/tmp/npm-cache");
    expect(volumeMounts.some((mount) => mount.name === "tmp" && mount.mountPath === "/tmp")).toBe(true);
    expect(volumes.some((volume) => volume.name === "tmp" && volume.emptyDir !== undefined)).toBe(true);
  });

  it("builds Ingress host from tenant domain conventions", () =>
  {
    const tenant = _makeTenant("sarah");

    const ingress = _BuildIngress(defaultConfig, tenant, "default");
    const host = ingress.spec?.rules?.[0]?.host;

    expect(host).toBe("sarah.opencrane.local");
  });
});
