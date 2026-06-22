import { HostingProvider } from "./hosting/hosting-adapter.types.js";
import type { GcpHostingConfig } from "./hosting/hosting-adapter.types.js";
import { _ParseTrustedProxies } from "./trusted-proxies.js";

export type { GcpHostingConfig };
export { HostingProvider };

/**
 * Runtime configuration for the operator, loaded from environment variables.
 */
export interface OpenClawTenantOperatorConfig
{
  /** Namespace to watch for CRDs (empty string watches all namespaces). */
  watchNamespace: string;

  /**
   * Multi-instance fail-closed guard: when true the operator refuses to start
   * with an empty `watchNamespace`, so an instance can never reconcile another
   * instance's Tenants cluster-wide (multi-instance brief B2).
   */
  requireWatchNamespace: boolean;

  /** Default container image used for tenant deployments. */
  tenantDefaultImage: string;

  /**
   * Default OpenClaw npm package version installed into tenant pods when a Tenant
   * CR does not set `spec.openclawVersion`. Pinned (not `latest`) so the gateway
   * never silently rolls across a breaking OpenClaw release.
   */
  defaultOpenclawVersion: string;

  /** Base domain for tenant ingress hostnames. */
  ingressDomain: string;

  /**
   * Cluster ingress external IP the per-org wildcard A records (declared as a DNSEndpoint
   * CR) point at. Empty when unknown (e.g. on-prem or before the LoadBalancer IP is
   * assigned); the per-org DNS side effect is then skipped and only the Certificate is
   * applied.
   */
  ingressIp: string;

  /** cert-manager issuer name the per-org Certificate references. */
  certManagerIssuerName: string;

  /** Issuer kind for the per-org Certificate: `ClusterIssuer` (default) or `Issuer`. */
  certManagerIssuerKind: "ClusterIssuer" | "Issuer";

  /** When true, the tenant Ingress gets a `tls:` block referencing the wildcard cert. */
  ingressTlsEnabled: boolean;

  /** Name of the (wildcard) TLS Secret the tenant Ingress serves; must exist in the tenant namespace. */
  ingressTlsSecretName: string;

  /** Port number exposed by the OpenClaw gateway inside tenant pods. */
  gatewayPort: number;

  /**
   * Reverse-proxy CIDRs/IPs the OpenClaw gateway trusts for `trusted-proxy` auth
   * (OC-2 / CONN.4). The gateway authenticates a connection as the user named in
   * {@link gatewayTrustedProxyUserHeader} only when the TCP source is one of these.
   * Set to the ingress source range; a NetworkPolicy additionally restricts the
   * gateway port to the ingress so this range can't be abused by other pods.
   *
   * Validated and fail-closed at load (see {@link _ParseTrustedProxies}): an empty
   * allowlist means **trust nothing** (never trust-all) and is paired with
   * {@link gatewayTrustNothing}; a malformed entry crashes the operator at startup.
   */
  gatewayTrustedProxies: string[];

  /**
   * Fail-closed trust flag derived from {@link gatewayTrustedProxies}: `true` when
   * no proxy source was configured, so the gateway is rendered to trust no source
   * and the trusted-proxy header is ignored. Disambiguates the empty allowlist so
   * an unconfigured operator can never silently trust every connection.
   */
  gatewayTrustNothing: boolean;

  /** Header the trusted proxy injects with the authenticated user identity. */
  gatewayTrustedProxyUserHeader: string;

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

  /**
   * Budget reset window passed to LiteLLM (`budget_duration`) so the per-tenant
   * spend cap rolls over on a fixed cadence (e.g. "30d"). Without it the
   * `max_budget` is a lifetime cap that never resets.
   */
  liteLlmBudgetDuration: string;

  /**
   * Default per-key tokens-per-minute throttle applied at key generation.
   * The Tenant CR has no per-tenant rate-limit field, so this config default is
   * the only lever; 0 (or negative) leaves the limit unset on LiteLLM.
   */
  liteLlmDefaultTpmLimit: number;

  /**
   * Default per-key requests-per-minute throttle applied at key generation.
   * Mirrors `liteLlmDefaultTpmLimit`; 0 (or negative) leaves it unset.
   */
  liteLlmDefaultRpmLimit: number;

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

  // 2. Resolve this operator's own namespace for the runtime-plane URL fallbacks.
  //    The Helm chart always sets MCP_GATEWAY_URL / SKILL_REGISTRY_URL /
  //    CONTROL_PLANE_INTERNAL_URL to release-prefixed values, so these defaults are a
  //    safety net only. They derive from POD_NAMESPACE (downward API) so an unset env
  //    resolves to THIS instance's namespace — never a hard-coded shared namespace
  //    like `opencrane-system`, which would be a latent cross-instance footgun (B5).
  const ownNamespace = _readOwnNamespace();

  // 2b. Parse the trusted-proxy allowlist fail-closed (OC-2 / CONN.4). An empty
  //     value resolves to trust-nothing (never trust-all); a malformed CIDR throws
  //     here so a typo crashes the operator at startup rather than silently
  //     widening or narrowing the gateway's trust boundary.
  const trustedProxies = _ParseTrustedProxies(_readEnvValue<string>("GATEWAY_TRUSTED_PROXIES", "string", false, ""));

  // 3. Build the typed config from env, applying namespace-derived fallbacks for the
  //    runtime-plane URLs so no value silently points at another instance.
  const config: OpenClawTenantOperatorConfig = {
    watchNamespace: _readEnvValue<string>("WATCH_NAMESPACE", "string"),
    requireWatchNamespace: _readEnvValue<boolean>("REQUIRE_WATCH_NAMESPACE", "boolean", false, false),
    tenantDefaultImage: _readEnvValue<string>("TENANT_DEFAULT_IMAGE", "string"),
    defaultOpenclawVersion: _readEnvValue<string>("DEFAULT_OPENCLAW_VERSION", "string", false, "2026.6.9"),
    ingressDomain: _readEnvValue<string>("INGRESS_DOMAIN", "string"),
    ingressIp: _readEnvValue<string>("INGRESS_IP", "string", false, ""),
    certManagerIssuerName: _readEnvValue<string>("CERT_MANAGER_ISSUER_NAME", "string", false, "opencrane-issuer"),
    certManagerIssuerKind: _readEnvValue<string>("CERT_MANAGER_ISSUER_KIND", "string", false, "ClusterIssuer") === "Issuer" ? "Issuer" : "ClusterIssuer",
    ingressTlsEnabled: _readEnvValue<boolean>("INGRESS_TLS_ENABLED", "boolean", false, false),
    ingressTlsSecretName: _readEnvValue<string>("INGRESS_TLS_SECRET_NAME", "string", false, "opencrane-wildcard-tls"),
    gatewayPort: _readEnvValue<number>("GATEWAY_PORT", "number"),
    gatewayTrustedProxies: trustedProxies.cidrs,
    gatewayTrustNothing: trustedProxies.trustNothing,
    gatewayTrustedProxyUserHeader: _readEnvValue<string>("GATEWAY_TRUSTED_PROXY_USER_HEADER", "string", false, "X-Forwarded-User"),
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
    liteLlmBudgetDuration: _readEnvValue<string>("LITELLM_BUDGET_DURATION", "string", false, "30d"),
    liteLlmDefaultTpmLimit: _readEnvValue<number>("LITELLM_DEFAULT_TPM_LIMIT", "number", false, 0),
    liteLlmDefaultRpmLimit: _readEnvValue<number>("LITELLM_DEFAULT_RPM_LIMIT", "number", false, 0),
    defaultTenantPolicyRef: _readEnvValue<string>("DEFAULT_TENANT_POLICY_REF", "string", false, ""),
    mcpGatewayUrl: _readEnvValue<string>("MCP_GATEWAY_URL", "string", false, `http://opencrane-mcp-gateway.${ownNamespace}.svc:8080`),
    skillRegistryUrl: _readEnvValue<string>("SKILL_REGISTRY_URL", "string", false, `http://opencrane-skill-registry.${ownNamespace}.svc:5000`),
    controlPlaneInternalUrl: _readEnvValue<string>("CONTROL_PLANE_INTERNAL_URL", "string", false, `http://opencrane-control-plane.${ownNamespace}.svc:3000`),
    obotDeploymentName: _readEnvValue<string>("OBOT_DEPLOYMENT_NAME", "string", false, "opencrane-mcp-gateway"),
    skillRegistryDeploymentName: _readEnvValue<string>("SKILL_REGISTRY_DEPLOYMENT_NAME", "string", false, "opencrane-skill-registry"),
    projectedTokenTtlSeconds: _readEnvValue<number>("PROJECTED_TOKEN_TTL_SECONDS", "number", false, 600),
  };

  // 4. Fail closed in multi-instance mode: refuse to watch the whole cluster when
  //    this instance must be scoped to its own namespace(s) (brief B2). Without
  //    this, an unscoped operator would reconcile every instance's Tenants.
  if (config.requireWatchNamespace && config.watchNamespace.trim().length === 0)
  {
    const message = "REQUIRE_WATCH_NAMESPACE is set but WATCH_NAMESPACE is empty; refusing to watch all namespaces in multi-instance mode";
    console.error(message);
    throw new Error(message);
  }

  return config;
}

/**
 * Resolve the namespace this operator pod runs in, used only as the fallback host
 * for the runtime-plane URLs (MCP gateway, skill registry, control plane).
 *
 * Reads POD_NAMESPACE, which the Helm operator Deployment populates from the
 * downward API (`metadata.namespace`). Falls back to `default` when unset (e.g. in
 * unit tests) so the fallback never points at a hard-coded shared namespace such as
 * `opencrane-system`, which would be a latent cross-instance footgun (B5).
 *
 * @returns The operator's own namespace, or `default` when POD_NAMESPACE is unset.
 */
function _readOwnNamespace(): string
{
  const raw = process.env["POD_NAMESPACE"]?.trim();
  return raw && raw.length > 0 ? raw : "default";
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
