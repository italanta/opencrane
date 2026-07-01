import { describe, expect, it } from "vitest";

import { defaultConfig, gcpConfig, gcpAdapter, onPremAdapter, _makeAccessPolicy, _makeTenant } from "../fixtures.js";
import { _BuildClusterTenantLimitRange, _BuildClusterTenantNamespace, _BuildClusterTenantResourceQuota, _BuildClusterTenantScheduling, _BuildConfigMap, _BuildDeployment, _BuildGatewayNetworkPolicy, _BuildServiceAccount, _BuildSiloBaselineNetworkPolicy, _BuildSiloLinkerdIdentityPolicy, _BuildStatePvc, _ConfigChecksum } from "../../tenants/deploy/index.js";

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
    // OC-2 / CONN.4: gateway uses trusted-proxy auth (control-plane brokers the
    // connection); trustedProxies + userHeader come from operator config.
    expect(payload.gateway.auth.mode).toBe("trusted-proxy");
    expect(payload.gateway.auth.trustedProxy.userHeader).toBe(defaultConfig.gatewayTrustedProxyUserHeader);
    // CONN.10: the pod is pinned to its OWNER so trusted-proxy cannot accept any other
    // injected identity (cross-tenant guard); _makeTenant("cfg") → cfg@example.com.
    expect(payload.gateway.auth.trustedProxy.allowUsers).toEqual(["cfg@example.com"]);
    expect(payload.gateway.trustedProxies).toEqual(defaultConfig.gatewayTrustedProxies);
    // The rendered trustedProxy block must contain ONLY keys OpenClaw's strict
    // schema accepts (userHeader, allowUsers); an unknown key crashes the gateway.
    expect(Object.keys(payload.gateway.auth.trustedProxy).sort()).toEqual(["allowUsers", "userHeader"]);
    expect(payload.agents.defaults.model).toBe("gpt-4o");
    expect(runtimeContract.mode).toBe("managed");
    expect(runtimeContract.tenant.name).toBe("cfg");
    expect(runtimeContract.contractVersion).toBe("2.1.0");
    expect(runtimeContract.mcp.gateway).toBe(defaultConfig.mcpGatewayUrl);
    expect(runtimeContract.skills.registry).toBe(defaultConfig.skillRegistryUrl);
  });

  it("emits litellm-proxy in replace mode (LiteLLM is the only provider — no bare-provider bypass)", () =>
  {
    const liteLlmConfig = { ...defaultConfig, liteLlmEnabled: true };
    const tenant = _makeTenant("ll");

    // Non-empty modelSet → replace, default surfaced, allowlist restricted to the set.
    const withModels = JSON.parse(_BuildConfigMap(liteLlmConfig, tenant, "default", undefined, { models: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"], defaultModel: "openai/gpt-4o" }).data?.["openclaw.json"] ?? "{}");
    expect(withModels.models.mode).toBe("replace");
    expect(withModels.models.default).toBe("openai/gpt-4o");
    expect(Object.keys(withModels.models.providers)).toEqual(["litellm-proxy"]);
    expect(withModels.models.providers["litellm-proxy"].models).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);

    // Empty/null modelSet → still replace (no built-in fallback); empty allowlist, no default.
    // This bricked-pod window is what cluster onboarding's ≥1-model requirement prevents.
    const noModels = JSON.parse(_BuildConfigMap(liteLlmConfig, tenant, "default", undefined, null).data?.["openclaw.json"] ?? "{}");
    expect(noModels.models.mode).toBe("replace");
    expect(noModels.models.default).toBeUndefined();
    expect(noModels.models.providers["litellm-proxy"].models).toEqual([]);
  });

  it("normalises the gateway owner allowlist (trim + lowercase) to match gateway-verify", () =>
  {
    // gateway-verify injects email.trim().toLowerCase(); a mixed-case / padded owner
    // email must normalise to the SAME value or the allowlist would lock the owner out.
    const tenant = _makeTenant("mixed");
    tenant.spec.email = "  Mike.Owner@EXAMPLE.com  ";

    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(payload.gateway.auth.trustedProxy.allowUsers).toEqual(["mike.owner@example.com"]);
  });

  it("allowlists the org Control-UI origin when a serving host is given (CONTROL_UI_ORIGIN_NOT_ALLOWED)", () =>
  {
    // With bind:lan the gateway refuses a Control-UI WS whose Origin isn't allowlisted.
    // The org-admin SPA connects through the org host, so its https origin must be allowed.
    const tenant = _makeTenant("acme-user");
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default", undefined, undefined, "acme.dev.opencrane.ai");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(payload.gateway.controlUi.allowedOrigins).toEqual(["https://acme.dev.opencrane.ai"]);
    // Device-less trusted-proxy model: device auth disabled so the proxy-injected identity's
    // scopes stand (otherwise the gateway strips them). Safe only behind the gateway NetworkPolicy.
    expect(payload.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    // Survives the step-3b gateway re-pin (controlUi is part of the platform-owned block).
    expect(payload.gateway.auth.trustedProxy.allowUsers).toEqual(["acme-user@example.com"]);
  });

  it("disables Control-UI device auth even with no serving host, but omits the origin allowlist", () =>
  {
    const tenant = _makeTenant("plain");
    const configMap = _BuildConfigMap(defaultConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    // Device-less model applies regardless of host; the origin allowlist is host-derived.
    expect(payload.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(payload.gateway.controlUi).not.toHaveProperty("allowedOrigins");
  });

  it("renders an unambiguous trust-nothing gateway config when no proxy is configured (OC-2 / CONN.4)", () =>
  {
    // An operator with no GATEWAY_TRUSTED_PROXIES resolves to trust-nothing. We rely
    // on OpenClaw's native fail-closed semantics — an empty `trustedProxies` trusts
    // no source — so the ConfigMap emits an empty list and NO bespoke marker key
    // (which OpenClaw's strict trustedProxy schema would reject at gateway startup).
    const trustNothingConfig = { ...defaultConfig, gatewayTrustedProxies: [], gatewayTrustNothing: true };
    const tenant = _makeTenant("trust-none");

    const configMap = _BuildConfigMap(trustNothingConfig, tenant, "default");
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(payload.gateway.auth.mode).toBe("trusted-proxy");
    expect(payload.gateway.trustedProxies).toEqual([]);
    expect(payload.gateway.auth.trustedProxy).not.toHaveProperty("trustNothing");
  });

  it("populates litellm-proxy models[] when a non-empty model set is supplied", () =>
  {
    const litellmConfig = { ...defaultConfig, liteLlmEnabled: true };
    const tenant = _makeTenant("models-test");

    const configMap = _BuildConfigMap(litellmConfig, tenant, "default", undefined, { models: ["gpt-4o", "claude-opus-4-8"], defaultModel: "gpt-4o" });
    const payload = JSON.parse(configMap.data?.["openclaw.json"] ?? "{}");

    expect(payload.models.providers["litellm-proxy"].models).toEqual(["gpt-4o", "claude-opus-4-8"]);
    expect(payload.models.default).toBe("gpt-4o");
  });

  it("keeps litellm-proxy models[] empty when the model set is empty or null", () =>
  {
    const litellmConfig = { ...defaultConfig, liteLlmEnabled: true };
    const tenant = _makeTenant("models-empty");

    const emptyMap = _BuildConfigMap(litellmConfig, tenant, "default", undefined, { models: [], defaultModel: null });
    const nullMap = _BuildConfigMap(litellmConfig, tenant, "default", undefined, null);

    const emptyPayload = JSON.parse(emptyMap.data?.["openclaw.json"] ?? "{}");
    const nullPayload = JSON.parse(nullMap.data?.["openclaw.json"] ?? "{}");

    expect(emptyPayload.models.providers["litellm-proxy"].models).toEqual([]);
    expect(emptyPayload.models.default).toBeUndefined();
    expect(nullPayload.models.providers["litellm-proxy"].models).toEqual([]);
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
    expect(envVars.OPENCLAW_VERSION).toBe(defaultConfig.defaultOpenclawVersion);
    expect(envVars.OPENCRANE_RUNTIME_MODE).toBe("managed");
    expect(envVars.OPENCRANE_RUNTIME_CONTRACT_PATH).toBe("/config/opencrane-managed-runtime.json");
    expect(envVars.OPENCRANE_MCP_GATEWAY_URL).toBe(defaultConfig.mcpGatewayUrl);
    expect(envVars.OPENCRANE_SKILL_REGISTRY_URL).toBe(defaultConfig.skillRegistryUrl);
    expect(envVars.OPENCRANE_MCP_GATEWAY_TOKEN_PATH).toBe("/var/run/opencrane/tokens/obot-gateway.token");
    expect(envVars.OPENCRANE_SKILL_REGISTRY_TOKEN_PATH).toBe("/var/run/opencrane/tokens/skill-registry.token");
    expect(envVars.OPENCRANE_POLICY_REF).toBe("restricted-mcp");
    expect(envVars.HOME).toBe("/tmp/opencrane-home");
    expect(envVars.NPM_CONFIG_CACHE).toBe("/tmp/npm-cache");
    // OC-2 / CONN.4: gateway auth is trusted-proxy (configured in openclaw.json,
    // not via env), so there is no OPENCLAW_GATEWAY_TOKEN on the pod.
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

  it("builds a NetworkPolicy locking the gateway port to the in-operator proxy (CONN.4)", () =>
  {
    const tenant = _makeTenant("sarah");
    const config = { ...defaultConfig, operatorNamespace: "opencrane" };
    const netpol = _BuildGatewayNetworkPolicy(config, tenant, "default");

    expect(netpol.spec?.policyTypes).toEqual(["Ingress"]);
    // Only the clustertenant-manager pod (which hosts the identity-routing proxy) in the
    // operator's namespace may reach the gateway port — no per-user Ingress, no other pod, can
    // connect and assert an arbitrary X-Forwarded-User. The selector MUST match the proxy pod's
    // real label (`clustertenant-manager`); "operator" matched nothing → fail-open/closed bug.
    const rule = netpol.spec?.ingress?.[0];
    expect(rule?._from?.[0]?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"]).toBe("opencrane");
    expect(rule?._from?.[0]?.podSelector?.matchLabels?.["app.kubernetes.io/component"]).toBe("clustertenant-manager");
    expect(rule?.ports?.[0]?.port).toBe(config.gatewayPort);
  });
});

describe("Silo baseline NetworkPolicy (S2 / Phase 1 — default-deny silo edge)", () =>
{
  const config = { ...defaultConfig, operatorNamespace: "opencrane-system" };
  const netpol = _BuildSiloBaselineNetworkPolicy("opencrane-acme", "acme", config);

  it("flips the silo namespace to default-deny (empty podSelector, Ingress+Egress)", () =>
  {
    expect(netpol.metadata?.namespace).toBe("opencrane-acme");
    expect(netpol.metadata?.labels?.["opencrane.io/cluster-tenant"]).toBe("acme");
    expect(netpol.spec?.podSelector).toEqual({});
    expect(netpol.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
  });

  it("admits ingress only from the same silo and the control-plane namespace (uses _from, not from)", () =>
  {
    const rule = netpol.spec?.ingress?.[0];
    // _from MUST be set — a bare `from` would be dropped by the serializer and fail OPEN.
    expect(rule?._from).toBeDefined();
    expect(rule?._from).toContainEqual({ podSelector: {} });
    expect(rule?._from).toContainEqual({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "opencrane-system" } } });
  });

  it("allows egress to DNS, the platform namespace, intra-silo, and external HTTPS only", () =>
  {
    const egress = netpol.spec?.egress ?? [];
    // DNS on 53/UDP+TCP to kube-system.
    const dns = egress.find(e => e.to?.some(t => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "kube-system"));
    expect(dns?.ports).toEqual([{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }]);
    // External HTTPS on 443 (no `to` ⇒ any destination) for LLM/MCP/Git.
    expect(egress).toContainEqual({ ports: [{ protocol: "TCP", port: 443 }] });
    // Platform-plane reachability.
    const platform = egress.find(e => e.to?.some(t => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "opencrane-system"));
    expect(platform).toBeDefined();
  });

  it("creates NO silo→silo path (no rule names another silo namespace)", () =>
  {
    const serialized = JSON.stringify(netpol.spec);
    // The only namespaces referenced are the platform namespace and kube-system —
    // never another ClusterTenant silo (e.g. opencrane-bcorp).
    expect(serialized).not.toContain("opencrane-bcorp");
    const nsNames = [...serialized.matchAll(/"kubernetes\.io\/metadata\.name":"([^"]+)"/g)].map(m => m[1]);
    expect(new Set(nsNames)).toEqual(new Set(["opencrane-system", "kube-system"]));
  });
});

describe("Silo Linkerd identity policy (S5 / ADR 0001 — meshed default-deny silo edge)", () =>
{
  const config = { ...defaultConfig, operatorNamespace: "opencrane-system", gatewayPort: 18789 };
  const bundle = _BuildSiloLinkerdIdentityPolicy("opencrane-acme", "acme", config);

  it("emits a deny-by-default Server over every pod (empty podSelector, v1beta1)", () =>
  {
    const { server } = bundle;
    expect(server.apiVersion).toBe("policy.linkerd.io/v1beta1");
    expect(server.kind).toBe("Server");
    expect(server.metadata.namespace).toBe("opencrane-acme");
    expect(server.metadata.labels["opencrane.io/cluster-tenant"]).toBe("acme");
    // Empty selector → every pod in the silo namespace; deny → default-deny baseline.
    expect(server.spec.podSelector).toEqual({});
    expect(server.spec.accessPolicy).toBe("deny");
    expect(server.spec.port).toBe(18789);
  });

  it("admits ingress identities only from the same silo and the operator namespace", () =>
  {
    const { meshTlsAuthentication } = bundle;
    expect(meshTlsAuthentication.apiVersion).toBe("policy.linkerd.io/v1alpha1");
    expect(meshTlsAuthentication.kind).toBe("MeshTLSAuthentication");
    expect(meshTlsAuthentication.spec.identities).toContain(
      "*.opencrane-acme.serviceaccount.identity.linkerd.cluster.local",
    );
    expect(meshTlsAuthentication.spec.identities).toContain(
      "*.opencrane-system.serviceaccount.identity.linkerd.cluster.local",
    );
  });

  it("binds the Server to the authentication via an AuthorizationPolicy (v1alpha1)", () =>
  {
    const { authorizationPolicy, server, meshTlsAuthentication } = bundle;
    expect(authorizationPolicy.apiVersion).toBe("policy.linkerd.io/v1alpha1");
    expect(authorizationPolicy.kind).toBe("AuthorizationPolicy");
    // targetRef points at the deny-by-default Server.
    expect(authorizationPolicy.spec.targetRef).toEqual({ group: "policy.linkerd.io", kind: "Server", name: server.metadata.name });
    // requiredAuthenticationRefs points at the allow-list MeshTLSAuthentication.
    expect(authorizationPolicy.spec.requiredAuthenticationRefs).toContainEqual({
      group: "policy.linkerd.io", kind: "MeshTLSAuthentication", name: meshTlsAuthentication.metadata.name,
    });
  });

  it("creates NO cross-silo identity path (no foreign silo identity is ever listed)", () =>
  {
    const serialized = JSON.stringify(bundle);
    // The only identity domains referenced are the silo's own and the operator plane —
    // never another ClusterTenant silo (e.g. opencrane-bcorp).
    expect(serialized).not.toContain("opencrane-bcorp");
    const nsDomains = [...serialized.matchAll(/\*\.([^.]+)\.serviceaccount\.identity/g)].map(m => m[1]);
    expect(new Set(nsDomains)).toEqual(new Set(["opencrane-acme", "opencrane-system"]));
  });
});

describe("ClusterTenant isolation builders (CT.5)", () =>
{
  it("builds a Namespace labelled for PSA baseline enforce/warn/audit", () =>
  {
    const ns = _BuildClusterTenantNamespace("ct-acme", "acme");
    const labels = ns.metadata?.labels ?? {};

    expect(ns.metadata?.name).toBe("ct-acme");
    expect(labels["pod-security.kubernetes.io/enforce"]).toBe("baseline");
    expect(labels["pod-security.kubernetes.io/warn"]).toBe("baseline");
    expect(labels["pod-security.kubernetes.io/audit"]).toBe("baseline");
    expect(labels["opencrane.io/cluster-tenant"]).toBe("acme");
  });

  it("omits the Linkerd inject annotation by default and stamps it when gated on (S5)", () =>
  {
    // Default (gate off) — no mesh injection annotation.
    const off = _BuildClusterTenantNamespace("ct-acme", "acme");
    expect(off.metadata?.annotations?.["linkerd.io/inject"]).toBeUndefined();
    // Gate on — namespace opts its pods into the mesh.
    const on = _BuildClusterTenantNamespace("ct-acme", "acme", true);
    expect(on.metadata?.annotations?.["linkerd.io/inject"]).toBe("enabled");
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

describe("config checksum → pod roll", () =>
{
  const _annotations = (config: string | undefined) =>
    _BuildDeployment(defaultConfig, onPremAdapter.buildStateVolume("jente"), _makeTenant("jente"), "default", undefined, config)
      .spec?.template?.metadata?.annotations;

  it("computes a deterministic, config-sensitive digest", () =>
  {
    const cmA = _BuildConfigMap(defaultConfig, _makeTenant("jente"), "default");
    const cmAAgain = _BuildConfigMap(defaultConfig, _makeTenant("jente"), "default");
    const cmB = _BuildConfigMap(defaultConfig, _makeTenant("other"), "default");

    // Stable across identical renders (no spurious rolls), and changes with the config.
    expect(_ConfigChecksum(cmA)).toBe(_ConfigChecksum(cmAAgain));
    expect(_ConfigChecksum(cmA)).not.toBe(_ConfigChecksum(cmB));
    expect(_ConfigChecksum(cmA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stamps the checksum on the pod template so a config change rolls the pod", () =>
  {
    expect(_annotations("abc123")).toEqual({ "opencrane.io/config-checksum": "abc123" });
  });

  it("omits the annotation when no checksum is supplied (suspend path unchanged)", () =>
  {
    expect(_annotations(undefined)).toBeUndefined();
  });
});
