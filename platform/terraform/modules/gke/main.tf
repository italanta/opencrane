# -----------------------------------------------------------------------------
# GKE module
#
# GKE Autopilot cluster — Google manages nodes, bin-packing, and scaling.
# Nodes scale to zero when no pods are scheduled. You pay per pod resource.
#
# By default (vpc_id/subnet_id empty) the cluster runs on the project's default
# VPC with Google-managed IP allocation — no custom networking required. Supply
# vpc_id/subnet_id (and enable_private_nodes) for a dedicated VPC with private
# nodes.
# -----------------------------------------------------------------------------

locals
{
  use_custom_vpc = var.vpc_id != "" && var.subnet_id != ""
}

# -----------------------------------------------------------------------------
# CMEK — application-layer Secrets encryption (AIR.0)
#
# By default GKE encrypts Secrets in etcd with a Google-managed key. Enabling
# database_encryption with a customer-managed Cloud KMS key (CMEK) adds an
# envelope-encryption layer the customer controls: the cluster's Secrets at rest
# (etcd) and their backups are encrypted with `gke-secrets`, and access can be
# revoked by disabling the key.
#
# IMPORTANT scope: CMEK protects etcd-at-rest and backups. It does NOT change the
# in-cluster authorization boundary — a principal who can `kubectl get secret`
# still reads the plaintext. Kubernetes RBAC remains that boundary.
#
# IMPORTANT location: the KMS key ring MUST be in the same location as the
# cluster (var.region), or GKE rejects the key.
# -----------------------------------------------------------------------------

# The container-engine-robot service agent needs encrypt/decrypt on the key.
data "google_project" "this"
{
  count      = var.enable_secrets_encryption ? 1 : 0
  project_id = var.project_id
}

resource "google_kms_key_ring" "gke"
{
  count    = var.enable_secrets_encryption ? 1 : 0
  name     = "${var.cluster_name}-gke"
  location = var.region
  project  = var.project_id
}

resource "google_kms_crypto_key" "gke_secrets"
{
  count           = var.enable_secrets_encryption ? 1 : 0
  name            = "gke-secrets"
  key_ring        = google_kms_key_ring.gke[0].id
  rotation_period = "7776000s" # 90 days

  # Destroying the key would permanently lock the encrypted etcd/backups.
  lifecycle
  {
    prevent_destroy = true
  }
}

# Grant the GKE service agent permission to use the key for envelope encryption.
resource "google_kms_crypto_key_iam_member" "gke_secrets"
{
  count         = var.enable_secrets_encryption ? 1 : 0
  crypto_key_id = google_kms_crypto_key.gke_secrets[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.this[0].number}@container-engine-robot.iam.gserviceaccount.com"
}

resource "google_container_cluster" "cluster"
{
  provider = google-beta

  name     = var.cluster_name
  project  = var.project_id
  location = var.region

  # Omitted (null) when on the default VPC so GKE picks the default network.
  network    = local.use_custom_vpc ? var.vpc_id : null
  subnetwork = local.use_custom_vpc ? var.subnet_id : null

  # Autopilot mode — no node pools to manage.
  #
  # NETWORK-POLICY ENFORCEMENT (S2 / silo Phase 1, task_d6404452): Autopilot clusters
  # run GKE Dataplane V2 (Cilium) and ENFORCE NetworkPolicy inherently — there is no
  # `network_policy {}` / `datapath_provider` knob to set here (setting them on an
  # Autopilot cluster is rejected). So the per-silo default-deny baseline the operator
  # emits (_BuildSiloBaselineNetworkPolicy) is actually enforced on any cluster created
  # by this module. DO NOT migrate this to a Standard cluster without re-adding
  # `datapath_provider = "ADVANCED_DATAPATH"` (or `network_policy { enabled = true }`),
  # or every NetworkPolicy silently becomes a no-op and the silo edge fails OPEN.
  enable_autopilot = true

  # Private cluster configuration — only when a custom VPC provides Cloud NAT.
  dynamic "private_cluster_config"
  {
    for_each = var.enable_private_nodes ? [1] : []
    content
    {
      enable_private_nodes    = true
      enable_private_endpoint = false
      master_ipv4_cidr_block  = "172.16.0.0/28"
    }
  }

  # Master authorized networks -- restrict API access
  master_authorized_networks_config
  {
    cidr_blocks
    {
      cidr_block   = "0.0.0.0/0"
      display_name = "All (restrict in production)"
    }
  }

  # IP allocation policy. With a custom VPC use the named secondary ranges; on
  # the default VPC let GKE auto-allocate (empty block).
  dynamic "ip_allocation_policy"
  {
    for_each = local.use_custom_vpc ? [1] : []
    content
    {
      cluster_secondary_range_name  = "pods"
      services_secondary_range_name = "services"
    }
  }

  dynamic "ip_allocation_policy"
  {
    for_each = local.use_custom_vpc ? [] : [1]
    content {}
  }

  # Release channel for automatic upgrades
  release_channel
  {
    channel = "REGULAR"
  }

  # CMEK application-layer Secrets encryption. Gated by enable_secrets_encryption
  # (default ON). The key MUST be in the same location as the cluster.
  dynamic "database_encryption"
  {
    for_each = var.enable_secrets_encryption ? [1] : []
    content
    {
      state    = "ENCRYPTED"
      key_name = google_kms_crypto_key.gke_secrets[0].id
    }
  }

  # The service-agent IAM grant must land before the cluster references the key.
  depends_on = [google_kms_crypto_key_iam_member.gke_secrets]

  deletion_protection = false
}
