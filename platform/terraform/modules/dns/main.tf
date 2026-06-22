# -----------------------------------------------------------------------------
# Cloud DNS module — fixed-wildcard topology
#
# Owns the platform's managed zone and the FIXED, install-time records:
#   - `*.<domain>`          → ingress IP  (resolves every ORG APEX `<org>.<domain>`)
#   - `<domain>` (apex)     → ingress IP
#   - control-plane host    → ingress IP  (the fixed super-operator host, distinct
#                                           from the org wildcard)
#
# Per-ORG records (`*.<org>.<domain>`, which resolve the per-user level
# `<user>.<org>.<domain>`) are NOT created here at install — they are added at
# org-provision time by the cluster-tenants operator through the `OrgDomainProvisioner`
# seam (apps/control-plane/src/core/cluster-tenants/org-domain-provisioner.types.ts).
# `google_dns_record_set.org_wildcard` below is the exact shape that hook emits, and
# can also be driven from `var.org_wildcards` to pre-provision specific orgs from
# Terraform. The platform `*.<domain>` record alone does NOT cover that extra label.
# -----------------------------------------------------------------------------

resource "google_dns_managed_zone" "opencrane"
{
  name        = "${var.zone_name}-zone"
  project     = var.project_id
  dns_name    = "${var.domain}."
  description = "OpenCrane platform DNS zone (fixed-wildcard topology)"
}

# Platform org-wildcard: resolves every org apex `<org>.<domain>` to the ingress IP.
resource "google_dns_record_set" "wildcard"
{
  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "*.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}

# Apex record for the base domain.
resource "google_dns_record_set" "apex"
{
  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}

# Fixed super-operator / control-plane host (distinct from the org wildcard). Defaults
# to `platform.<domain>`; matches ingress.controlPlaneHost in the chart.
resource "google_dns_record_set" "control_plane"
{
  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "${coalesce(var.control_plane_host, "platform.${var.domain}")}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}

# -----------------------------------------------------------------------------
# Per-org wildcard records — the SHAPE the operator's DNS hook emits per org.
#
# Driven by `var.org_wildcards` (a set of org names). LEFT EMPTY by default so this
# module does not pre-empt the operator; populate it only to pre-provision specific
# orgs from Terraform. For each org `<org>` it creates `*.<org>.<domain>` → ingress IP,
# which resolves every `<user>.<org>.<domain>` UserTenant gateway under that org.
# -----------------------------------------------------------------------------
resource "google_dns_record_set" "org_wildcard"
{
  for_each = var.org_wildcards

  project      = var.project_id
  managed_zone = google_dns_managed_zone.opencrane.name
  name         = "*.${each.value}.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [var.ingress_ip]
}
