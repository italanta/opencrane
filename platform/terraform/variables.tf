# -----------------------------------------------------------------------------
# Root variables for OpenCrane GCP infrastructure
# -----------------------------------------------------------------------------

variable "project_id"
{
  description = "GCP project ID"
  type        = string
}

variable "region"
{
  description = "GCP region for all resources"
  type        = string
  default     = "europe-west1"
}

variable "environment"
{
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

# Networking
#
# By default the GKE cluster runs on the project's existing `default` VPC, so a
# bare apply needs no custom networking. Set enable_custom_vpc=true to provision
# a dedicated VPC + subnet + Cloud Router + Cloud NAT (e.g. for private nodes).
variable "enable_custom_vpc"
{
  description = "Provision a dedicated VPC + subnet + Cloud NAT. When false, GKE uses the project default VPC."
  type        = bool
  default     = false
}

variable "vpc_name"
{
  description = "Name for the VPC network (only used when enable_custom_vpc=true)"
  type        = string
  default     = "opencrane-vpc"
}

# Cloud DNS is optional. By default the deploy prints the ingress IP and you set
# DNS manually at your registrar. Set enable_cloud_dns=true to have Terraform
# create a managed zone + wildcard/apex records.
variable "enable_cloud_dns"
{
  description = "Create a Cloud DNS managed zone and wildcard/apex records pointing at the ingress IP."
  type        = bool
  default     = false
}

# Artifact Registry is optional. By default images are expected on an external
# registry (e.g. ghcr.io). Set enable_artifact_registry=true to provision a GCP
# Artifact Registry and push images there.
variable "enable_artifact_registry"
{
  description = "Provision a GCP Artifact Registry repository for OpenCrane images."
  type        = bool
  default     = false
}

# Container registry base URL used for image references when Artifact Registry is
# disabled. Defaults to the public ghcr.io OpenCrane org.
variable "registry_url"
{
  description = "Registry base URL for OpenCrane images when enable_artifact_registry=false (e.g. ghcr.io/italanta)."
  type        = string
  default     = "ghcr.io/italanta"
}

# Enable GCS-backed tenant storage (Workload Identity + GCS Fuse). When false
# (default) tenant storage uses standard k8s PVCs, keeping the deploy plain-k8s.
variable "enable_gcs_storage"
{
  description = "Enable GCS-backed tenant storage extras. Plain k8s PVC storage when false."
  type        = bool
  default     = false
}

# Install the OpenCrane Helm chart with Terraform. When false (default), Terraform
# provisions the cluster ONLY — so a single `terraform apply` always succeeds (no
# provider bootstrap problem) and you install the app afterwards with the standard
# `helm install` (k8s-native). Set true to also deploy the chart via Terraform; the
# guided deploy.sh handles the required two-step bootstrap automatically.
variable "enable_app_deploy"
{
  description = "Also install the OpenCrane Helm chart via Terraform. When false (default), Terraform creates the cluster only — run `helm install` afterwards."
  type        = bool
  default     = false
}

# GKE
variable "cluster_name"
{
  description = "Name for the GKE cluster"
  type        = string
  default     = "opencrane-cluster"
}

# Domain & DNS. Optional — bring the cluster up first and wire DNS later. Used for
# ingress hostnames and, when enable_cloud_dns=true, the managed DNS records.
variable "domain"
{
  description = "Base domain for tenant subdomains (e.g. opencrane.example.com). Optional."
  type        = string
  default     = ""
}

# Container images
variable "image_tag"
{
  description = "Docker image tag for OpenCrane components"
  type        = string
  default     = "latest"
}
