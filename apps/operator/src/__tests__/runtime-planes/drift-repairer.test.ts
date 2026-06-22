import * as k8s from "@kubernetes/client-node";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import { HostingProvider } from "../../config.js";
import { RuntimePlaneDriftRepairer } from "../../runtime-planes/drift-repairer.js";

/** Minimal operator config for drift-repairer tests. */
function _buildConfig(overrides: Partial<OpenClawTenantOperatorConfig> = {}): OpenClawTenantOperatorConfig
{
  return {
    watchNamespace: "opencrane",
    requireWatchNamespace: false,
    tenantDefaultImage: "opencrane/tenant:latest",
    defaultOpenclawVersion: "2026.6.9",
    ingressDomain: "opencrane.local",
    ingressIp: "",
    certManagerIssuerName: "opencrane-issuer",
    certManagerIssuerKind: "ClusterIssuer",
    ingressTlsEnabled: false,
    ingressTlsSecretName: "opencrane-wildcard-tls",
    gatewayPort: 18789,
    gatewayTrustedProxies: ["10.0.0.0/8"],
    gatewayTrustNothing: false,
    gatewayTrustedProxyUserHeader: "X-Forwarded-User",
    operatorNamespace: "opencrane",
    gatewayProxyEnabled: false,
    gatewayProxyPort: 8090,
    clusterDomain: "svc.cluster.local",
    gatewayProxyAllowedOrigins: [],
    gatewayProxyAllowedOriginBaseDomains: [],
    gatewayProxyRateLimitPerMinute: 60,
    hostingProvider: HostingProvider.OnPrem,
    idleTimeoutMinutes: 0,
    idleCheckIntervalSeconds: 60,
    liteLlmEnabled: false,
    liteLlmEndpoint: "",
    liteLlmMasterKey: "",
    liteLlmDefaultMonthlyBudgetUsd: 0,
    liteLlmBudgetDuration: "30d",
    liteLlmDefaultTpmLimit: 0,
    liteLlmDefaultRpmLimit: 0,
    mcpGatewayUrl: "http://obot:8080",
    skillRegistryUrl: "http://skill-registry:5000",
    controlPlaneInternalUrl: "http://control-plane:3000",
    obotDeploymentName: "opencrane-mcp-gateway",
    skillRegistryDeploymentName: "opencrane-skill-registry",
    projectedTokenTtlSeconds: 600,
    ...overrides,
  };
}

/**
 * Build a mock AppsV1Api that serves different env vars per deployment name.
 *
 * @param envByDeployment - Map of deploymentName → env vars; unmapped names get empty env.
 */
function _buildAppsApi(envByDeployment: Record<string, k8s.V1EnvVar[]>): k8s.AppsV1Api
{
  return {
    readNamespacedDeployment: vi.fn().mockImplementation(function _read(args: { name: string })
    {
      const env = envByDeployment[args.name] ?? [];
      return Promise.resolve({
        spec: { template: { spec: { containers: [{ name: args.name, env }] } } },
      } as unknown as k8s.V1Deployment);
    }),
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
  } as unknown as k8s.AppsV1Api;
}

const _log = pino({ level: "silent" });

describe("RuntimePlaneDriftRepairer", () =>
{
  it("does not patch when env vars are already correct", async () =>
  {
    const appsApi = _buildAppsApi({
      "opencrane-mcp-gateway": [
        { name: "OBOT_SERVER_MCPRUNTIME_BACKEND", value: "kubernetes" },
      ],
      "opencrane-skill-registry": [
        { name: "CONTROL_PLANE_URL", value: "http://control-plane:3000" },
      ],
    });
    const repairer = new RuntimePlaneDriftRepairer(appsApi, _buildConfig(), _log);

    // Access the private method for unit testing by casting.
    await (repairer as unknown as { _checkAndRepairAll(): Promise<void> })._checkAndRepairAll();

    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("patches when OBOT_SERVER_MCPRUNTIME_BACKEND has drifted", async () =>
  {
    const appsApi = _buildAppsApi({
      "opencrane-mcp-gateway": [
        { name: "OBOT_SERVER_MCPRUNTIME_BACKEND", value: "docker" },
      ],
      "opencrane-skill-registry": [
        { name: "CONTROL_PLANE_URL", value: "http://control-plane:3000" },
      ],
    });
    const repairer = new RuntimePlaneDriftRepairer(appsApi, _buildConfig(), _log);

    await (repairer as unknown as { _checkAndRepairAll(): Promise<void> })._checkAndRepairAll();

    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalled();
    const patchCall = (appsApi.patchNamespacedDeployment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const repairedEnv: k8s.V1EnvVar[] = patchCall?.body?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const backendVar = repairedEnv.find(function _find(e) { return e.name === "OBOT_SERVER_MCPRUNTIME_BACKEND"; });
    expect(backendVar?.value).toBe("kubernetes");
  });

  it("no longer enforces the removed OBOT_SERVER_PROVIDER_REGISTRIES knob (P0.2)", async () =>
  {
    // PROVIDER_REGISTRIES is an LLM model-provider directory knob, not an MCP catalogue,
    // so an arbitrary value for it must NOT trigger a repair.
    const appsApi = _buildAppsApi({
      "opencrane-mcp-gateway": [
        { name: "OBOT_SERVER_PROVIDER_REGISTRIES", value: "http://anything:9000" },
        { name: "OBOT_SERVER_MCPRUNTIME_BACKEND", value: "kubernetes" },
      ],
      "opencrane-skill-registry": [
        { name: "CONTROL_PLANE_URL", value: "http://control-plane:3000" },
      ],
    });
    const repairer = new RuntimePlaneDriftRepairer(appsApi, _buildConfig(), _log);

    await (repairer as unknown as { _checkAndRepairAll(): Promise<void> })._checkAndRepairAll();

    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("does not throw when deployment is missing (cluster bootstrap)", async () =>
  {
    const appsApi: k8s.AppsV1Api = {
      readNamespacedDeployment: vi.fn().mockRejectedValue(new Error("404 not found")),
      patchNamespacedDeployment: vi.fn(),
    } as unknown as k8s.AppsV1Api;

    const repairer = new RuntimePlaneDriftRepairer(appsApi, _buildConfig(), _log);

    await expect(
      (repairer as unknown as { _checkAndRepairAll(): Promise<void> })._checkAndRepairAll(),
    ).resolves.not.toThrow();
  });
});
