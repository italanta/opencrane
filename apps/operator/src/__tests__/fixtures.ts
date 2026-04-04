import type { AccessPolicy } from "../policies/types.js";
import type { OperatorConfig } from "../config.js";
import type { Tenant } from "../tenants/types.js";

/**
 * Shared operator config fixture used across all unit test suites.
 * Represents a fully-configured GCP environment.
 */
export const defaultConfig: OperatorConfig = {
  watchNamespace: "default",
  tenantDefaultImage: "ghcr.io/opencrane/tenant:latest",
  ingressDomain: "opencrane.local",
  ingressClassName: "nginx",
  sharedSkillsPvcName: "opencrane-shared-skills",
  gatewayPort: 18789,
  storageProvider: "gcs",
  bucketPrefix: "opencrane",
  gcpProject: "my-gcp-project",
  csiDriver: "gcsfuse.csi.storage.gke.io",
  crossplaneEnabled: true,
  idleTimeoutMinutes: 30,
  idleCheckIntervalSeconds: 60,
};

/**
 * Create a minimal Tenant fixture with the given name and optional
 * spec overrides for use in unit tests.
 */
export function _makeTenant(name: string, overrides?: Partial<Tenant["spec"]>): Tenant
{
  return {
    apiVersion: "opencrane.io/v1alpha1",
    kind: "Tenant",
    metadata: { name, namespace: "default" },
    spec: {
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
      email: `${name}@example.com`,
      ...overrides,
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
