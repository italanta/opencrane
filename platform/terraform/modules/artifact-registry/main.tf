# -----------------------------------------------------------------------------
# Artifact Registry module
#
# Creates a Docker repository in Artifact Registry for OpenCrane images.
# -----------------------------------------------------------------------------

resource "google_artifact_registry_repository" "opencrane"
{
  provider = google-beta

  repository_id = var.repository_id
  project       = var.project_id
  location      = var.region
  format        = "DOCKER"
  description   = "OpenCrane platform container images"

  cleanup_policies
  {
    id     = "keep-recent"
    action = "KEEP"

    most_recent_versions
    {
      keep_count = 10
    }
  }
}
