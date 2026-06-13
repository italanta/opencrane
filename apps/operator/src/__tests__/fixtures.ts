import type { AccessPolicy } from "../policies/types.js";
import type { OpenClawTenantOperatorConfig } from "../config.js";
import { HostingProvider } from "../config.js";
import type { Tenant } from "../tenants/models/tenant.interface.js";
import { TenantStatusPhase } from "../tenants/models/tenant-status.interface.js";
import { OnPremHostingAdapter } from "../hosting/adapters/onprem/onprem-hosting.adapter.js";
import { GcpHostingAdapter } from "../hosting/adapters/gcp/gcp-hosting.adapter.js";
import type { GcsBucketOperations } from "../hosting/adapters/gcp/gcp-bucket.client.js";

/**
 * Shared operator config fixture — on-prem baseline (no cloud fields required).
 */
export const defaultConfig: OpenClawTenantOperatorConfig = {
  watchNamespace: "default",
  tenantDefaultImage: "ghcr.io/opencrane/tenant:latest",
  ingressDomain: "opencrane.local",
  ingressTlsEnabled: false,
  ingressTlsSecretName: "opencrane-wildcard-tls",
  gatewayPort: 18789,
  hostingProvider: HostingProvider.OnPrem,
  idleTimeoutMinutes: 30,
  idleCheckIntervalSeconds: 60,
  liteLlmEnabled: false,
  liteLlmEndpoint: "http://litellm:4000",
  liteLlmMasterKey: "",
  liteLlmDefaultMonthlyBudgetUsd: 50,
  mcpGatewayUrl: "http://obot-gateway.opencrane-system.svc:8080",
  skillRegistryUrl: "http://skill-registry.opencrane-system.svc:5000",
  controlPlaneInternalUrl: "http://opencrane-control-plane.opencrane.svc:3000",
  obotDeploymentName: "opencrane-mcp-gateway",
  skillRegistryDeploymentName: "opencrane-skill-registry",
  projectedTokenTtlSeconds: 600,
};

/**
 * GCP-flavoured config fixture for tests that exercise cloud paths.
 */
export const gcpConfig: OpenClawTenantOperatorConfig = {
  ...defaultConfig,
  hostingProvider: HostingProvider.Gcp,
  gcp: {
    projectId: "my-gcp-project",
    bucketPrefix: "opencrane",
    csiDriver: "gcsfuse.csi.storage.gke.io",
  },
};

/** On-prem hosting adapter instance shared across tests. */
export const onPremAdapter = new OnPremHostingAdapter();

/** Fake GCS bucket client that records calls without hitting the network. */
export const fakeGcsBuckets: GcsBucketOperations & { provisioned: string[] } = {
  provisioned: [],
  async ensureBucket(bucketName: string): Promise<void>
  {
    fakeGcsBuckets.provisioned.push(bucketName);
  },
};

/** GCP hosting adapter backed by the fake bucket client. */
export const gcpAdapter = new GcpHostingAdapter(
  { projectId: "my-gcp-project", bucketPrefix: "opencrane", csiDriver: "gcsfuse.csi.storage.gke.io" },
  fakeGcsBuckets,
);

/**
 * Create a minimal Tenant fixture with the given name and optional
 * spec overrides and status properties for use in unit tests.
 */
export function _makeTenant(
  name: string,
  options?: {
    suspended?: boolean;
    phase?: TenantStatusPhase;
    namespace?: string;
  } & Partial<Tenant["spec"]>,
): Tenant
{
  const { phase, namespace, suspended, ...specOverrides } = options ?? {};

  return {
    apiVersion: "opencrane.io/v1alpha1",
    kind: "Tenant",
    metadata: { name, namespace: namespace ?? "default" },
    spec: {
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
      email: `${name}@example.com`,
      suspended,
      ...specOverrides,
    },
    status: {
      phase: phase ?? TenantStatusPhase.Running,
    },
  };
}

/**
 * Create a minimal AccessPolicy fixture for use in unit tests.
 */
export function _makeAccessPolicy(): AccessPolicy
{
  return {
    apiVersion: "opencrane.io/v1alpha1",
    kind: "AccessPolicy",
    metadata: {
      name: "default-egress",
      namespace: "default",
    },
    spec: {
      description: "Default tenant egress",
      tenantSelector: {
        matchLabels: { "opencrane.io/tenant": "jente" },
        matchTeam: "engineering",
      },
      egressRules: [
        {
          cidr: "10.0.0.0/8",
          ports: [443],
          protocol: "TCP",
        },
      ],
      domains: {
        allow: ["api.openai.com", "*.anthropic.com"],
      },
      mcpServers: {
        allow: ["skills"],
      },
    },
  };
}
