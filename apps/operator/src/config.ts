/**
 * Runtime configuration for the operator, loaded from environment variables.
 */
export interface OperatorConfig
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
}

/**
 * Load the operator configuration from environment variables, falling back
 * to sensible defaults for local development.
 */
export function loadOperatorConfig(): OperatorConfig
{
  return {
    watchNamespace: process.env.WATCH_NAMESPACE ?? "",
    tenantDefaultImage: process.env.TENANT_DEFAULT_IMAGE ?? "ghcr.io/opencrane/tenant:latest",
    ingressDomain: process.env.INGRESS_DOMAIN ?? "opencrane.local",
    ingressClassName: process.env.INGRESS_CLASS_NAME ?? "nginx",
    sharedSkillsPvcName: process.env.SHARED_SKILLS_PVC_NAME ?? "opencrane-shared-skills",
    gatewayPort: Number(process.env.GATEWAY_PORT ?? "18789"),
    storageProvider: (process.env.STORAGE_PROVIDER ?? "") as OperatorConfig["storageProvider"],
    bucketPrefix: process.env.BUCKET_PREFIX ?? "opencrane",
    gcpProject: process.env.GCP_PROJECT ?? "",
    csiDriver: process.env.CSI_DRIVER ?? "",
    crossplaneEnabled: process.env.CROSSPLANE_ENABLED === "true",
  };
}
