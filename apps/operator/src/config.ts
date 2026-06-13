import { HostingProvider } from "./hosting/hosting-adapter.types.js";
import type { GcpHostingConfig } from "./hosting/hosting-adapter.types.js";

export type { GcpHostingConfig };
export { HostingProvider };

/**
 * Runtime configuration for the operator, loaded from environment variables.
 */
export interface OpenClawTenantOperatorConfig
{
  /** Namespace to watch for CRDs (empty string watches all namespaces). */
  watchNamespace: string;

  /** Default container image used for tenant deployments. */
  tenantDefaultImage: string;

  /** Base domain for tenant ingress hostnames. */
  ingressDomain: string;

  /** When true, the tenant Ingress gets a `tls:` block referencing the wildcard cert. */
  ingressTlsEnabled: boolean;

  /** Name of the (wildcard) TLS Secret the tenant Ingress serves; must exist in the tenant namespace. */
  ingressTlsSecretName: string;

  /** Port number exposed by the OpenClaw gateway inside tenant pods. */
  gatewayPort: number;

  /** Active hosting substrate. Defaults to on-prem. */
  hostingProvider: HostingProvider;

  /** GCP-specific config; present only when hostingProvider === Gcp. */
  gcp?: GcpHostingConfig;

  /** Minutes of inactivity before a tenant is auto-suspended (0 = disabled). */
  idleTimeoutMinutes: number;

  /** How often (in seconds) the idle-check loop runs. */
  idleCheckIntervalSeconds: number;

  /** When true, tenant reconcile provisions per-tenant LiteLLM virtual keys. */
  liteLlmEnabled: boolean;

  /** Cluster-local LiteLLM base endpoint (e.g. http://litellm:4000). */
  liteLlmEndpoint: string;

  /** Master key used by the operator to call LiteLLM key-management APIs. */
  liteLlmMasterKey: string;

  /** Default monthly budget (USD) applied when tenant does not override it. */
  liteLlmDefaultMonthlyBudgetUsd: number;

  /** Optional default AccessPolicy name used when no explicit or selector match is found. */
  defaultTenantPolicyRef?: string;

  /** In-cluster MCP gateway URL exposed to tenant runtimes through managed env/contract. */
  mcpGatewayUrl: string;

  /** In-cluster skill registry delivery URL exposed to tenant runtimes. */
  skillRegistryUrl: string;

  /** In-cluster control-plane base URL used by tenant pods to re-pull the effective contract. */
  controlPlaneInternalUrl: string;

  /** Kubernetes Deployment name for the Obot MCP Gateway managed by this operator. */
  obotDeploymentName: string;

  /** Kubernetes Deployment name for the Skill Registry managed by this operator. */
  skillRegistryDeploymentName: string;

  /** Projected ServiceAccount token TTL in seconds for ingress-plane audiences. */
  projectedTokenTtlSeconds: number;
}

/**
 * Load operator configuration from environment variables.
 */
export function _LoadOperatorConfig(): OpenClawTenantOperatorConfig
{
  // 1. Resolve hosting provider first; GCP block is conditionally required.
  const hostingProvider = _readHostingProvider();

  return {
    watchNamespace: _readEnvValue<string>("WATCH_NAMESPACE", "string"),
    tenantDefaultImage: _readEnvValue<string>("TENANT_DEFAULT_IMAGE", "string"),
    ingressDomain: _readEnvValue<string>("INGRESS_DOMAIN", "string"),
    ingressTlsEnabled: _readEnvValue<boolean>("INGRESS_TLS_ENABLED", "boolean", false, false),
    ingressTlsSecretName: _readEnvValue<string>("INGRESS_TLS_SECRET_NAME", "string", false, "opencrane-wildcard-tls"),
    gatewayPort: _readEnvValue<number>("GATEWAY_PORT", "number"),
    hostingProvider,
    gcp: hostingProvider === HostingProvider.Gcp
      ? {
          projectId: _readEnvValue<string>("GCP_PROJECT_ID", "string"),
          bucketPrefix: _readEnvValue<string>("GCP_BUCKET_PREFIX", "string"),
          csiDriver: _readEnvValue<string>("GCP_CSI_DRIVER", "string", false, "gcsfuse.csi.storage.gke.io"),
        }
      : undefined,
    idleTimeoutMinutes: _readEnvValue<number>("IDLE_TIMEOUT_MINUTES", "number"),
    idleCheckIntervalSeconds: _readEnvValue<number>("IDLE_CHECK_INTERVAL_SECONDS", "number"),
    liteLlmEnabled: _readEnvValue<boolean>("LITELLM_ENABLED", "boolean"),
    liteLlmEndpoint: _readEnvValue<string>("LITELLM_ENDPOINT", "string"),
    liteLlmMasterKey: _readEnvValue<string>("LITELLM_MASTER_KEY", "string", false, ""),
    liteLlmDefaultMonthlyBudgetUsd: _readEnvValue<number>("LITELLM_DEFAULT_MONTHLY_BUDGET_USD", "number"),
    defaultTenantPolicyRef: _readEnvValue<string>("DEFAULT_TENANT_POLICY_REF", "string", false, ""),
    mcpGatewayUrl: _readEnvValue<string>("MCP_GATEWAY_URL", "string", false, "http://obot-gateway.opencrane-system.svc:8080"),
    skillRegistryUrl: _readEnvValue<string>("SKILL_REGISTRY_URL", "string", false, "http://skill-registry.opencrane-system.svc:5000"),
    controlPlaneInternalUrl: _readEnvValue<string>("CONTROL_PLANE_INTERNAL_URL", "string", false, "http://opencrane-control-plane.opencrane.svc:3000"),
    obotDeploymentName: _readEnvValue<string>("OBOT_DEPLOYMENT_NAME", "string", false, "opencrane-mcp-gateway"),
    skillRegistryDeploymentName: _readEnvValue<string>("SKILL_REGISTRY_DEPLOYMENT_NAME", "string", false, "opencrane-skill-registry"),
    projectedTokenTtlSeconds: _readEnvValue<number>("PROJECTED_TOKEN_TTL_SECONDS", "number", false, 600),
  };
}

/**
 * Parse the HOSTING_PROVIDER env var.
 * Defaults to on-prem when unset so plain cluster installs need no configuration.
 */
function _readHostingProvider(): HostingProvider
{
  const raw = process.env["HOSTING_PROVIDER"] ?? "";
  switch (raw)
  {
    case "gcp": return HostingProvider.Gcp;
    case "azure": return HostingProvider.Azure;
    case "aws": return HostingProvider.Aws;
    case "onprem":
    case "":
    default:
      return HostingProvider.OnPrem;
  }
}

/**
 * Supported runtime env parsing modes.
 */
type EnvValueType = "string" | "number" | "boolean";

/**
 * Read and parse a typed environment variable.
 *
 * @param envName - Environment variable name to read.
 * @param valueType - Runtime parsing mode used to convert the raw string into type T.
 * @param isMandatory - When true, throws if variable is not set.
 * @param defaultVal - Fallback value used only when variable is not set and not mandatory.
 * @returns Parsed value of type T.
 */
function _readEnvValue<T>(
  envName: string,
  valueType: EnvValueType,
  isMandatory: boolean = true,
  defaultVal: T | null = null,
): T
{
  const rawValue = process.env[envName];

  if (rawValue === undefined)
  {
    if (!isMandatory && defaultVal !== null)
    {
      return defaultVal;
    }

    const message = `${envName} is required`;
    console.error(message);
    throw new Error(message);
  }

  try
  {
    switch (valueType)
    {
      case "string":
        return rawValue as T;
      case "number": {
        const value = Number(rawValue);
        if (!Number.isFinite(value))
        {
          throw new Error("must be a valid number");
        }

        return value as T;
      }
      case "boolean":
        if (rawValue === "true") return true as T;
        if (rawValue === "false") return false as T;
        throw new Error("must be 'true' or 'false'");
    }
  }
  catch (err)
  {
    const message = err instanceof Error ? err.message : "invalid value";
    console.error(`${envName} ${message}`);
    throw new Error(`${envName} ${message}`);
  }
}
