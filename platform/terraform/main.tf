# -----------------------------------------------------------------------------
# OpenCrane GCP Infrastructure
#
# Provisions networking, GKE, Artifact Registry, in-cluster PostgreSQL,
# the OpenCrane platform, and Cloud DNS for wildcard routing.
#
# Usage:
#   cd platform/terraform
#   terraform init
#   terraform apply -var-file=environments/dev/terraform.tfvars
# -----------------------------------------------------------------------------

data "google_client_config" "default" {}

# ---- Phase 1: Networking ----

module "networking"
{
  source = "./modules/networking"

  project_id = var.project_id
  region     = var.region
  vpc_name   = var.vpc_name
}

# ---- Phase 2: GKE Cluster ----

module "gke"
{
  source = "./modules/gke"

  project_id   = var.project_id
  region       = var.region
  cluster_name = var.cluster_name
  vpc_id       = module.networking.vpc_id
  subnet_id    = module.networking.subnet_id

  depends_on = [module.networking]
}

# Configure kubernetes and helm providers using GKE cluster credentials
provider "kubernetes"
{
  host                   = "https://${module.gke.cluster_endpoint}"
  cluster_ca_certificate = base64decode(module.gke.cluster_ca_certificate)
  token                  = data.google_client_config.default.access_token
}

provider "helm"
{
  kubernetes
  {
    host                   = "https://${module.gke.cluster_endpoint}"
    cluster_ca_certificate = base64decode(module.gke.cluster_ca_certificate)
    token                  = data.google_client_config.default.access_token
  }
}

# ---- Phase 3: Artifact Registry ----

module "artifact_registry"
{
  source = "./modules/artifact-registry"

  project_id    = var.project_id
  region        = var.region
  repository_id = "opencrane"
}

# ---- Phase 4: Application (PostgreSQL + OpenCrane + DB migration) ----

module "app_deploy"
{
  source = "./modules/app-deploy"

  project_id   = var.project_id
  registry_url = module.artifact_registry.repository_url
  image_tag    = var.image_tag
  domain       = var.domain
  namespace    = "opencrane"

  depends_on = [module.gke]
}

# ---- Phase 6: Cloud DNS (wildcard → ingress IP) ----

module "dns"
{
  source = "./modules/dns"

  project_id = var.project_id
  domain     = var.domain
  ingress_ip = module.app_deploy.ingress_ip

  depends_on = [module.app_deploy]
}
