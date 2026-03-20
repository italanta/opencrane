variable "project_id"
{
  description = "GCP project ID"
  type        = string
}

variable "region"
{
  description = "GCP region"
  type        = string
}

variable "repository_id"
{
  description = "Artifact Registry repository name"
  type        = string
  default     = "opencrane"
}
