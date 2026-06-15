import { describe, expect, it } from "vitest";

import { defaultConfig, gcpConfig, gcpAdapter, onPremAdapter, _makeAccessPolicy, _makeTenant } from "../fixtures.js";
import { _BuildClusterTenantLimitRange, _BuildClusterTenantNamespace, _BuildClusterTenantResourceQuota, _BuildClusterTenantScheduling, _BuildConfigMap, _BuildDeployment, _BuildIngress, _BuildServiceAccount, _BuildStatePvc } from "../../tenants/deploy/index.js";

describe("TenantResourceBuilder", () =>
{
  it("builds ServiceAccount with no annotations on-prem", () =>
  {
    const tenant = _makeTenant("jente");

    const sa = _BuildServiceAccount(onPremAdapter, tenant, "default");

    expect(sa.metadata?.name).toBe("openclaw-jente");
    expect(sa.metadata?.annotations).toEqual({});
  });

  it("builds ServiceAccount with Workload Identity annotation on GCP", () =>
  {
    const tenant = _makeTenant("jente");

    const sa = _BuildServiceAccount(gcpAdapter, tenant, "default");

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
    expect(runtimeContract.contractVersion).toBe("2.1.0");
    expect(runtimeContract.mcp.gateway).toBe(defaultConfig.mcpGatewayUrl);
    expect(runtimeContract.skills.registry).toBe(defaultConfig.skillRegistryUrl);
  });

  it("pins workspace path and disables bootstrap even when agents block is overridden", () =>
  {
    const tenant = _makeTenant("ws", {
      configOverrides: {
        // Override the entire agents key — platform workspace settings must still survive.
        agents: { defaults: { model: "claude-opus-4-8" } },
      },
    });

    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(payload.agents.defaults.workspace).toBe("/data/openclaw/workspace");
    expect(payload.agents.defaults.skipBootstrap).toBe(true);
    // Tenant override must still be present alongside the platform settings.
    expect(payload.agents.defaults.model).toBe("claude-opus-4-8");
  });

  it("emits L0 and L2 workspace file keys in the ConfigMap", () =>
  {
    const tenant = _makeTenant("identity-test", { team: "engineering" });
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const data = configMap.data ?? {};

    // L0 platform files must be present.
    expect(data["AGENTS.md"]).toBeDefined();
    expect(data["TOOLS.md"]).toBeDefined();

    // L2 seed files must be present.
    expect(data["SOUL.md.seed"]).toBeDefined();
    expect(data["IDENTITY.md.seed"]).toBeDefined();
    expect(data["USER.md.seed"]).toBeDefined();

    // AGENTS.md must contain key platform concepts (static file — references env var names).
    expect(data["AGENTS.md"]).toContain("managed");
    expect(data["AGENTS.md"]).toContain("OPENCRANE_MCP_GATEWAY_URL");
    expect(data["AGENTS.md"]).toContain("OPENCRANE_SKILL_REGISTRY_URL");
    expect(data["AGENTS.md"]).toContain("Platform Invariants");

    // TOOLS.md must reference the env var names (static file — no literal URLs injected).
    expect(data["TOOLS.md"]).toContain("OPENCRANE_MCP_GATEWAY_URL");
    expect(data["TOOLS.md"]).toContain("OPENCRANE_SKILL_REGISTRY_URL");

    // L2 seed files must have non-empty content.
    expect(data["SOUL.md.seed"]!.length).toBeGreaterThan(0);
    expect(data["IDENTITY.md.seed"]!.length).toBeGreaterThan(0);
    expect(data["USER.md.seed"]!.length).toBeGreaterThan(0);
  });

  it("publishes policy reference metadata and defers grants to effective-contract", () =>
  {
    const tenant = _makeTenant("jente", {
      team: "engineering",
      policyRef: "default-egress",
    });

    const policy = _makeAccessPolicy();
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default", policy);
    const runtimeContract = JSON.parse(configMap.data?.["opencrane-managed-runtime.json"] ?? "{}");

    expect(runtimeContract.policy.effectiveRef).toBe("default-egress");
    expect(runtimeContract.policy.mcpServers).toBeUndefined();
    expect(runtimeContract.mcp.servers).toEqual([]);
    expect(runtimeContract.skills.entitled).toEqual([]);
  });

  it("builds Deployment with PVC volume on-prem", () =>
  {
    const tenant = _makeTenant("local");
    const stateVolume = onPremAdapter.buildStateVolume("local");

    const deployment = _BuildDeployment(defaultConfig, stateVolume, tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.persistentVolumeClaim?.claimName).toBe("openclaw-local-state");
  });

  it("on-prem stateVolume requiresPvc is true", () =>
  {
    const stateVolume = onPremAdapter.buildStateVolume("test");

    expect(stateVolume.requiresPvc).toBe(true);
    expect(stateVolume.volumeMount.mountPath).toBe("/data/openclaw");
  });

  it("builds Deployment with CSI volume on GCP", () =>
  {
    const tenant = _makeTenant("cloud");
    const stateVolume = gcpAdapter.buildStateVolume("cloud");

    const deployment = _BuildDeployment(gcpConfig, stateVolume, tenant, "default");
    const volumes = deployment.spec?.template?.spec?.volumes ?? [];
    const tenantStorage = volumes.find((v) => v.name === "tenant-storage");

    expect(tenantStorage?.csi?.driver).toBe("gcsfuse.csi.storage.gke.io");
    expect(tenantStorage?.csi?.volumeAttributes?.bucketName).toBe("opencrane-cloud");
  });

  it("GCP stateVolume requiresPvc is false", () =>
  {
    const stateVolume = gcpAdapter.buildStateVolume("test");

    expect(stateVolume.requiresPvc).toBe(false);
  });

  it("builds state PVC for on-prem storage", () =>
  {
    const pvc = _BuildStatePvc("local", "default");

    expect(pvc.metadata?.name).toBe("openclaw-local-state");
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.resources?.requests?.storage).toBe("1Gi");
  });

  it("hardens Deployment runtime defaults and injects managed runtime env", () =>
  {
    const tenant = _makeTenant("strict", {
      policyRef: "restricted-mcp",
      skillAllowlist: ["company-policy", "deploy-helper"],
    });

    const stateVolume = onPremAdapter.buildStateVolume("strict");
    const deployment = _BuildDeployment(defaultConfig, stateVolume, tenant, "default");
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
    expect(envVars.OPENCRANE_MCP_GATEWAY_URL).toBe(defaultConfig.mcpGatewayUrl);
    expect(envVars.OPENCRANE_SKILL_REGISTRY_URL).toBe(defaultConfig.skillRegistryUrl);
    expect(envVars.OPENCRANE_MCP_GATEWAY_TOKEN_PATH).toBe("/var/run/opencrane/tokens/obot-gateway.token");
    expect(envVars.OPENCRANE_SKILL_REGISTRY_TOKEN_PATH).toBe("/var/run/opencrane/tokens/skill-registry.token");
    expect(envVars.OPENCRANE_POLICY_REF).toBe("restricted-mcp");
    expect(envVars.OPENCRANE_ALLOWED_SKILLS).toBeUndefined();
    expect(envVars.HOME).toBe("/tmp/opencrane-home");
    expect(envVars.NPM_CONFIG_CACHE).toBe("/tmp/npm-cache");
    expect(envVars.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(volumeMounts.some((mount) => mount.name === "tmp" && mount.mountPath === "/tmp")).toBe(true);
    expect(volumeMounts.some((mount) => mount.name === "projected-identity" && mount.mountPath === "/var/run/opencrane/tokens")).toBe(true);
    expect(volumes.some((volume) => volume.name === "tmp" && volume.emptyDir !== undefined)).toBe(true);
    expect(volumes.some((volume) =>
      volume.name === "projected-identity"
      && volume.projected?.sources?.some((source) => source.serviceAccountToken?.audience === "obot-gateway")
      && volume.projected?.sources?.some((source) => source.serviceAccountToken?.audience === "skill-registry"),
    )).toBe(true);
  });

  it("builds Ingress with nginx class on-prem", () =>
  {
    const tenant = _makeTenant("sarah");
    const ingressBinding = onPremAdapter.buildIngressBinding();

    const ingress = _BuildIngress(defaultConfig, ingressBinding, tenant, "default");
    const host = ingress.spec?.rules?.[0]?.host;

    expect(host).toBe("sarah.opencrane.local");
    expect(ingress.spec?.ingressClassName).toBe("nginx");
    expect(ingress.metadata?.annotations).toEqual({});
  });

  it("builds Ingress with gce class and annotation on GCP", () =>
  {
    const tenant = _makeTenant("sarah");
    const ingressBinding = gcpAdapter.buildIngressBinding();

    const ingress = _BuildIngress(gcpConfig, ingressBinding, tenant, "default");

    expect(ingress.spec?.ingressClassName).toBe("gce");
    expect(ingress.metadata?.annotations?.["kubernetes.io/ingress.class"]).toBe("gce");
  });

  it("omits the tls block when ingress TLS is disabled (default)", () =>
  {
    const tenant = _makeTenant("sarah");
    const ingress = _BuildIngress(defaultConfig, onPremAdapter.buildIngressBinding(), tenant, "default");

    expect(ingress.spec?.tls).toBeUndefined();
  });

  it("adds a tls block referencing the wildcard secret when ingress TLS is enabled", () =>
  {
    const tenant = _makeTenant("sarah");
    const tlsConfig = { ...defaultConfig, ingressTlsEnabled: true, ingressTlsSecretName: "opencrane-wildcard-tls" };

    const ingress = _BuildIngress(tlsConfig, onPremAdapter.buildIngressBinding(), tenant, "default");

    expect(ingress.spec?.tls).toEqual([{ hosts: ["sarah.opencrane.local"], secretName: "opencrane-wildcard-tls" }]);
  });
});

describe("ClusterTenant isolation builders (CT.5)", () =>
{
  it("builds a Namespace labelled for PSA restricted enforce/warn/audit", () =>
  {
    const ns = _BuildClusterTenantNamespace("ct-acme", "acme");
    const labels = ns.metadata?.labels ?? {};

    expect(ns.metadata?.name).toBe("ct-acme");
    expect(labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels["pod-security.kubernetes.io/warn"]).toBe("restricted");
    expect(labels["pod-security.kubernetes.io/audit"]).toBe("restricted");
    expect(labels["opencrane.io/cluster-tenant"]).toBe("acme");
  });

  it("builds a ResourceQuota from every present quota dimension", () =>
  {
    const quota = _BuildClusterTenantResourceQuota("ct-acme", "acme", {
      cpu: "4",
      memory: "8Gi",
      pods: 10,
      storage: "100Gi",
      gpu: 2,
    });
    const hard = quota.spec?.hard ?? {};

    expect(quota.metadata?.namespace).toBe("ct-acme");
    expect(hard["requests.cpu"]).toBe("4");
    expect(hard["requests.memory"]).toBe("8Gi");
    expect(hard.pods).toBe("10");
    expect(hard["requests.storage"]).toBe("100Gi");
    expect(hard["requests.nvidia.com/gpu"]).toBe("2");
  });

  it("omits unset quota dimensions so they stay unbounded", () =>
  {
    const quota = _BuildClusterTenantResourceQuota("ct-acme", "acme", { cpu: "2" });
    const hard = quota.spec?.hard ?? {};

    expect(hard["requests.cpu"]).toBe("2");
    expect(hard["requests.memory"]).toBeUndefined();
    expect(hard.pods).toBeUndefined();
    expect(hard["requests.storage"]).toBeUndefined();
    expect(hard["requests.nvidia.com/gpu"]).toBeUndefined();
  });

  it("builds a LimitRange with sensible per-container defaults", () =>
  {
    const limits = _BuildClusterTenantLimitRange("ct-acme", "acme");
    const item = limits.spec?.limits?.[0];

    expect(limits.metadata?.namespace).toBe("ct-acme");
    expect(item?.type).toBe("Container");
    expect(item?._default?.cpu).toBe("1");
    expect(item?.defaultRequest?.cpu).toBe("100m");
    expect(item?.defaultRequest?.memory).toBe("128Mi");
  });

  it("pins dedicated compute to its node pool with a matching toleration", () =>
  {
    const scheduling = _BuildClusterTenantScheduling({ mode: "dedicated", nodePool: "acme-pool" });

    expect(scheduling.nodeSelector?.["opencrane.io/node-pool"]).toBe("acme-pool");
    expect(scheduling.tolerations?.[0]).toEqual({
      key: "opencrane.io/dedicated",
      operator: "Equal",
      value: "acme-pool",
      effect: "NoSchedule",
    });
  });

  it("leaves shared / unset / pool-less compute unconstrained", () =>
  {
    expect(_BuildClusterTenantScheduling({ mode: "shared" })).toEqual({});
    expect(_BuildClusterTenantScheduling(undefined)).toEqual({});
    expect(_BuildClusterTenantScheduling({ mode: "dedicated" })).toEqual({});
  });

  it("stamps nodeSelector + tolerations on the Deployment for dedicated compute", () =>
  {
    const tenant = _makeTenant("pinned");
    const stateVolume = onPremAdapter.buildStateVolume("pinned");

    const deployment = _BuildDeployment(defaultConfig, stateVolume, tenant, "ct-acme", {
      mode: "dedicated",
      nodePool: "acme-pool",
    });
    const podSpec = deployment.spec?.template?.spec;

    expect(podSpec?.nodeSelector?.["opencrane.io/node-pool"]).toBe("acme-pool");
    expect(podSpec?.tolerations?.[0]?.key).toBe("opencrane.io/dedicated");
  });

  it("renders no scheduling constraints on the default (ref-less) Deployment", () =>
  {
    const tenant = _makeTenant("plain");
    const stateVolume = onPremAdapter.buildStateVolume("plain");

    // No compute argument === the ref-less default path: the pod spec must be
    // byte-for-byte free of any nodeSelector / tolerations keys.
    const deployment = _BuildDeployment(defaultConfig, stateVolume, tenant, "default");
    const podSpec = deployment.spec?.template?.spec;

    expect(podSpec?.nodeSelector).toBeUndefined();
    expect(podSpec?.tolerations).toBeUndefined();
  });
});
