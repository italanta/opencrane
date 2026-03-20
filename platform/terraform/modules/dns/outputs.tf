output "name_servers"
{
  description = "DNS zone name servers (delegate your domain to these)"
  value       = google_dns_managed_zone.opencrane.name_servers
}

output "dns_zone_name"
{
  description = "Cloud DNS zone resource name"
  value       = google_dns_managed_zone.opencrane.name
}
