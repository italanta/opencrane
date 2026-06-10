# -----------------------------------------------------------------------------
# App Deploy module
#
# Deploys in-cluster PostgreSQL (Bitnami), the OpenCrane Helm chart, and
# a Kubernetes Job for Prisma database migrations. This is the final step
# that brings the application online after infrastructure provisioning.
# -----------------------------------------------------------------------------

# ---- In-cluster PostgreSQL via Bitnami Helm chart ----

resource "random_password" "db_password"
{
  length  = 32
  special = false
}

resource "helm_release" "postgresql"
{
  name             = "opencrane-db"
  namespace        = var.namespace
  create_namespace = true
  repository       = "oci://registry-1.docker.io/bitnamicharts"
  chart            = "postgresql"
  version          = "16.4.1"
  wait             = true
  timeout          = 600

  set
  {
    name  = "auth.username"
    value = "opencrane"
  }

  set_sensitive
  {
    name  = "auth.password"
    value = random_password.db_password.result
  }

  set
  {
    name  = "auth.database"
    value = "opencrane"
  }

  set
  {
    name  = "primary.persistence.size"
    value = "10Gi"
  }

  set
  {
    name  = "primary.resources.requests.cpu"
    value = "250m"
  }

  set
  {
    name  = "primary.resources.requests.memory"
    value = "256Mi"
  }
}

# ---- Kubernetes Secret with DATABASE_URL for the control-plane ----

resource "kubernetes_secret" "database_url"
{
  metadata
  {
    name      = "opencrane-db"
    namespace = var.namespace
  }

  data =
  {
    DATABASE_URL = "postgresql://opencrane:${random_password.db_password.result}@opencrane-db-postgresql.${var.namespace}.svc.cluster.local:5432/opencrane"
  }

  depends_on = [helm_release.postgresql]
}

# ---- Static ingress IP (reserved so DNS can point to it) ----

resource "google_compute_global_address" "ingress_ip"
{
  name    = "${var.release_name}-ingress-ip"
  project = var.project_id
}

# ---- OpenCrane Helm chart ----

resource "helm_release" "opencrane"
{
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = "${path.module}/../../../helm"
  wait             = true
  timeout          = 600

  # Operator image
  set
  {
    name  = "operator.image.repository"
    value = "${var.registry_url}/operator"
  }

  set
  {
    name  = "operator.image.tag"
    value = var.image_tag
  }

  set
  {
    name  = "operator.image.pullPolicy"
    value = "Always"
  }

  # Control-plane image
  set
  {
    name  = "controlPlane.image.repository"
    value = "${var.registry_url}/control-plane"
  }

  set
  {
    name  = "controlPlane.image.tag"
    value = var.image_tag
  }

  set
  {
    name  = "controlPlane.image.pullPolicy"
    value = "Always"
  }

  # Database — use the in-cluster secret
  set
  {
    name  = "controlPlane.database.existingSecret"
    value = kubernetes_secret.database_url.metadata[0].name
  }

  set
  {
    name  = "controlPlane.database.secretKey"
    value = "DATABASE_URL"
  }

  # Ingress
  set
  {
    name  = "ingress.domain"
    value = var.domain
  }

  set
  {
    name  = "ingress.className"
    value = "gce"
  }

  set
  {
    name  = "ingress.annotations.kubernetes\\.io/ingress\\.global-static-ip-name"
    value = google_compute_global_address.ingress_ip.name
  }

  # Storage
  set
  {
    name  = "tenant.storage.provider"
    value = "gcs"
  }

  set
  {
    name  = "tenant.storage.bucketPrefix"
    value = "opencrane"
  }

  set
  {
    name  = "tenant.storage.csiDriver"
    value = "gcsfuse.csi.storage.gke.io"
  }

  set
  {
    name  = "tenant.storage.gcpProject"
    value = var.project_id
  }

  # Observability
  set
  {
    name  = "observability.cloudLogging"
    value = "true"
  }

  # Shared skills PVC
  set
  {
    name  = "sharedSkills.pvc.storageClass"
    value = "standard-rwx"
  }

  depends_on = [
    kubernetes_secret.database_url,
    helm_release.postgresql,
  ]
}

# ---- Database migration Job ----

resource "kubernetes_job" "db_migrate"
{
  metadata
  {
    name      = "opencrane-db-migrate"
    namespace = var.namespace
  }

  spec
  {
    backoff_limit = 3

    template
    {
      metadata
      {
        labels =
        {
          app = "opencrane-db-migrate"
        }
      }

      spec
      {
        restart_policy = "OnFailure"

        containers
        {
          name    = "migrate"
          image   = "${var.registry_url}/control-plane:${var.image_tag}"
          command = ["npx", "prisma", "migrate", "deploy"]

          working_dir = "/app/apps/control-plane"

          env
          {
            name = "DATABASE_URL"
            value_from
            {
              secret_key_ref
              {
                name = kubernetes_secret.database_url.metadata[0].name
                key  = "DATABASE_URL"
              }
            }
          }
        }
      }
    }
  }

  wait_for_completion = true

  timeouts
  {
    create = "5m"
  }

  depends_on = [
    helm_release.postgresql,
    kubernetes_secret.database_url,
  ]
}
