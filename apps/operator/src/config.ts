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

  /** Kubernetes ingress class to annotate on tenant ingresses. */
  ingressClassName: string;

  /** Name of the shared PVC mounted read-only into every tenant pod. */
  sharedSkillsPvcName: string;

  /** Port number exposed by the OpenClaw gateway inside tenant pods. */
  gatewayPort: number;

  /** Cloud storage provider type (empty string = PVC fallback). */
  storageProvider: "gcs" | "azure-blob" | "s3" | "";

  /** Bucket name prefix for tenant storage. */
  bucketPrefix: string;

  /** GCP project ID for Workload Identity bindings. */
  gcpProject: string;

  /** CSI driver name for mounting cloud storage into pods. */
  csiDriver: string;

  /** Whether Crossplane manages storage resources. */
  crossplaneEnabled: boolean;

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
}

/** Backwards-compatible alias used by existing operator modules. */
export type OperatorConfig = OpenClawTenantOperatorConfig;

/**
 * Load operator configuration from environment variables.
 */
export function _LoadOperatorConfig(): OpenClawTenantOperatorConfig
{
  return {
    watchNamespace: _readEnvValue<string>("WATCH_NAMESPACE", "string"),
    tenantDefaultImage: _readEnvValue<string>("TENANT_DEFAULT_IMAGE", "string"),
    ingressDomain: _readEnvValue<string>("INGRESS_DOMAIN", "string"),
    ingressClassName: _readEnvValue<string>("INGRESS_CLASS_NAME", "string"),
    sharedSkillsPvcName: _readEnvValue<string>("SHARED_SKILLS_PVC_NAME", "string"),
    gatewayPort: _readEnvValue<number>("GATEWAY_PORT", "number"),
    storageProvider: _readEnvValue<OpenClawTenantOperatorConfig["storageProvider"]>("STORAGE_PROVIDER", "storageProvider"),
    bucketPrefix: _readEnvValue<string>("BUCKET_PREFIX", "string"),
    gcpProject: _readEnvValue<string>("GCP_PROJECT", "string"),
    csiDriver: _readEnvValue<string>("CSI_DRIVER", "string"),
    crossplaneEnabled: _readEnvValue<boolean>("CROSSPLANE_ENABLED", "boolean"),
    idleTimeoutMinutes: _readEnvValue<number>("IDLE_TIMEOUT_MINUTES", "number"),
    idleCheckIntervalSeconds: _readEnvValue<number>("IDLE_CHECK_INTERVAL_SECONDS", "number"),
    liteLlmEnabled: _readEnvValue<boolean>("LITELLM_ENABLED", "boolean"),
    liteLlmEndpoint: _readEnvValue<string>("LITELLM_ENDPOINT", "string"),
    liteLlmMasterKey: _readEnvValue<string>("LITELLM_MASTER_KEY", "string", false, ""),
    liteLlmDefaultMonthlyBudgetUsd: _readEnvValue<number>("LITELLM_DEFAULT_MONTHLY_BUDGET_USD", "number"),
  };
}


/**
 * Supported runtime env parsing modes.
 */
type OpenClawTenantOperatorConfigValueType = "string" | "number" | "boolean" | "storageProvider";

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
  valueType: OpenClawTenantOperatorConfigValueType,
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
      case "storageProvider":
        if (rawValue === "gcs" || rawValue === "azure-blob" || rawValue === "s3" || rawValue === "")
        {
          return rawValue as T;
        }

        throw new Error("must be one of: '', gcs, azure-blob, s3");
    }
  }
  catch (err)
  {
    const message = err instanceof Error ? err.message : "invalid value";
    console.error(`${envName} ${message}`);
    throw new Error(`${envName} ${message}`);
  }
}
