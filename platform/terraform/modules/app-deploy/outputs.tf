output "ingress_ip"
{
  description = "External IP address of the ingress controller"
  value       = google_compute_global_address.ingress_ip.address
}

output "database_host"
{
  description = "In-cluster PostgreSQL service hostname"
  value       = "opencrane-db-rw.${var.namespace}.svc.cluster.local"
}

output "control_plane_url"
{
  description = "URL for the OpenCrane control-plane UI"
  value       = "https://${var.domain}"
}

output "database_password"
{
  description = "In-cluster PostgreSQL database password"
  value       = random_password.db_password.result
  sensitive   = true
}
