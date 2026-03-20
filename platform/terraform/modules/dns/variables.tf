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
  description = "Base domain for tenant subdomains (e.g. opencrane.example.com)"
  type        = string
}

variable "ingress_ip"
{
  description = "External IP of the ingress controller"
  type        = string
}
