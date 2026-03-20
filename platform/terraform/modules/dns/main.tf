# -----------------------------------------------------------------------------
# Cloud DNS module
#
# Creates a Cloud DNS managed zone and a wildcard A record pointing to
# the ingress controller's external IP. All tenant subdomains resolve
# automatically via the wildcard.
# -----------------------------------------------------------------------------

resource "google_dns_managed_zone" "opencrane"
{
  name        = "${var.zone_name}-zone"
  project     = var.project_id
  dns_name    = "${var.domain}."
  description = "OpenCrane platform DNS zone"
}

resource "google_dns_record_set" "wildcard"
{
  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "*.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}

# Also create an A record for the apex domain (control-plane UI)
resource "google_dns_record_set" "apex"
{
  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}
