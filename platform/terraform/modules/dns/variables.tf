variable "project_id"
{
  description = "GCP project ID"
  type        = string
}

variable "zone_name"
{
  description = "Cloud DNS zone name (resource name, not the domain)"
  type        = string
  default     = "opencrane"
}

variable "domain"
{
  description = "Platform org-wildcard base domain. Orgs are <org>.<domain>, users <user>.<org>.<domain> (e.g. weownai.eu)."
  type        = string
}

variable "ingress_ip"
{
  description = "External IP of the ingress controller"
  type        = string
}

variable "control_plane_host"
{
  description = "Fixed super-operator / control-plane host (distinct from the org wildcard). Empty → defaults to platform.<domain>."
  type        = string
  default     = ""
}

variable "org_wildcards"
{
  description = "Org names to pre-provision a per-org wildcard record (*.<org>.<domain>) for. Empty by default — the cluster-tenants operator owns per-org records at provision time."
  type        = set(string)
  default     = []
}
