# -----------------------------------------------------------------------------
# App Deploy module
#
# Deploys in-cluster PostgreSQL (CloudNativePG), the OpenCrane Helm chart, and
# a Kubernetes Job for Prisma database migrations. This is the final step
# that brings the application online after infrastructure provisioning.
# -----------------------------------------------------------------------------

# ---- In-cluster PostgreSQL via CloudNativePG Operator ----

resource "random_password" "db_password"
{
  length  = 32
  special = false
}

resource "helm_release" "cnpg"
{
  name             = "cnpg"
  namespace        = var.namespace
  create_namespace = true
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = "0.22.0"
  wait             = true
  timeout          = 600

  set
  {
    name  = "monitoring.podMonitor.enabled"
    value = "false"
  }
}

resource "kubernetes_secret" "db_creds"
{
  metadata
  {
    name      = "opencrane-db-creds"
    namespace = var.namespace
  }

  data =
  {
    username = "opencrane"
    password = random_password.db_password.result
  }
}

resource "kubernetes_manifest" "postgresql_cluster"
{
  manifest = {
    apiVersion = "postgresql.cnpg.io/v1"
    kind       = "Cluster"
    metadata = {
      name      = "opencrane-db"
      namespace = var.namespace
    }
    spec = {
      instances = 1
      imageName = "ghcr.io/cloudnative-pg/postgresql:16"
      storage = {
        size = "10Gi"
      }
      resources = {
        requests = {
          cpu    = "250m"
          memory = "256Mi"
        }
      }
      bootstrap = {
        initdb = {
          database = "opencrane"
          secret = {
            name = kubernetes_secret.db_creds.metadata[0].name
          }
        }
      }
    }
  }

  depends_on = [
    helm_release.cnpg,
    kubernetes_secret.db_creds,
  ]
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
    DATABASE_URL = "postgresql://opencrane:${random_password.db_password.result}@opencrane-db-rw.${var.namespace}.svc.cluster.local:5432/opencrane"
  }

  depends_on = [kubernetes_manifest.postgresql_cluster]
}

# ---- Kubernetes Secret with dsn for the Obot MCP Gateway ----

resource "kubernetes_secret" "opencrane_obot"
{
  metadata
  {
    name      = "opencrane-obot"
    namespace = var.namespace
  }

  data =
  {
    dsn = "postgresql://opencrane:${random_password.db_password.result}@opencrane-db-rw.${var.namespace}.svc.cluster.local:5432/opencrane"
  }

  depends_on = [kubernetes_manifest.postgresql_cluster]
}

# ---- Static ingress IP (reserved so DNS can point to it) ----

resource "google_compute_global_address" "ingress_ip"
{
  name    = "${var.release_name}-ingress-ip"
  project = var.project_id
}

# ---- cert-manager via Helm chart (CONN.8) ----

resource "helm_release" "cert_manager"
{
  name             = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = "v1.15.1"
  wait             = true
  timeout          = 600

  set
  {
    name  = "crds.enabled"
    value = "true"
  }
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

  # Hosting provider. Default is plain-k8s on GKE: standard PVC tenant storage,
  # k8s Secrets, GKE default StorageClass. The GCS-backed tenant storage extras
  # (GCS Fuse CSI + Workload Identity) are opt-in via enable_gcs_storage.
  set
  {
    name  = "hosting.provider"
    value = var.enable_gcs_storage ? "gcp" : "onprem"
  }

  # GCP-only tenant storage settings — rendered only when enable_gcs_storage=true.
  dynamic "set"
  {
    for_each = var.enable_gcs_storage ? {
      "hosting.gcp.projectId"   = var.project_id
      "hosting.gcp.bucketPrefix" = var.bucket_prefix
      "hosting.gcp.csiDriver"   = "gcsfuse.csi.storage.gke.io"
    } : {}
    content
    {
      name  = set.key
      value = set.value
    }
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
    kubernetes_secret.opencrane_obot,
    kubernetes_manifest.postgresql_cluster,
    helm_release.cert_manager,
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
    kubernetes_manifest.postgresql_cluster,
    kubernetes_secret.database_url,
  ]
}
