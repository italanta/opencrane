# -----------------------------------------------------------------------------
# Root outputs
# -----------------------------------------------------------------------------

output "cluster_name"
{
  description = "GKE cluster name"
  value       = module.gke.cluster_name
}

output "cluster_endpoint"
{
  description = "GKE cluster endpoint"
  value       = module.gke.cluster_endpoint
  sensitive   = true
}

output "registry_url"
{
  description = "Artifact Registry URL for Docker images"
  value       = module.artifact_registry.repository_url
}

output "ingress_ip"
{
  description = "External IP for the ingress controller"
  value       = module.app_deploy.ingress_ip
}

output "control_plane_url"
{
  description = "URL for the OpenCrane control-plane UI"
  value       = module.app_deploy.control_plane_url
}

output "dns_name_servers"
{
  description = "Name servers — delegate your domain to these"
  value       = module.dns.name_servers
}

output "database_url"
{
  description = "PostgreSQL connection string"
  value       = "postgresql://opencrane:${module.app_deploy.database_password}@${module.app_deploy.database_host}:5432/opencrane"
  sensitive   = true
}

output "kubeconfig_command"
{
  description = "Command to configure kubectl"
  value       = "gcloud container clusters get-credentials ${module.gke.cluster_name} --region ${var.region} --project ${var.project_id}"
}
