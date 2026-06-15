variable "project_id"
{
  description = "GCP project ID"
  type        = string
}

variable "namespace"
{
  description = "Kubernetes namespace for the OpenCrane deployment"
  type        = string
  default     = "opencrane"
}

variable "release_name"
{
  description = "Helm release name"
  type        = string
  default     = "opencrane"
}

variable "registry_url"
{
  description = "Artifact Registry URL (region-docker.pkg.dev/project/repo)"
  type        = string
}

variable "image_tag"
{
  description = "Docker image tag for OpenCrane components"
  type        = string
  default     = "latest"
}

variable "domain"
{
  description = "Base domain for tenant subdomains"
  type        = string
}

# -- GCP extras (opt-in). When false (default) the deploy is plain-k8s on GKE:
#    standard PVC tenant storage, k8s Secrets, no GCS / Workload Identity / External
#    Secrets specialness. Flip to true to enable GCS-backed tenant storage.
variable "enable_gcs_storage"
{
  description = "Enable GCS-backed tenant storage (Workload Identity + GCS Fuse CSI). Plain k8s PVC storage when false."
  type        = bool
  default     = false
}

variable "bucket_prefix"
{
  description = "Bucket name prefix for GCS-backed tenant storage (only used when enable_gcs_storage=true)"
  type        = string
  default     = "opencrane"
}
