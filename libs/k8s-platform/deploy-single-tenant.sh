#!/usr/bin/env bash
# =============================================================================
# OpenCrane — SINGLE-TENANT deploy (orchestrates the two per-role charts)
#
# Installs a one-organisation platform on the cluster your kubectl context points at.
# Since the chart split (Option 2) there is no single co-located chart — a single-tenant
# install is the FLEET chart + ONE SILO chart, driven here in two passes:
#
#   1. FLEET chart (apps/fleet-platform): cluster bootstrap (CRDs, cert-manager issuer,
#      external-secrets, otel, monitoring, docs, main-network default-deny) + the
#      fleet-manager, with self-service OFF and exactly ONE ClusterTenant SEEDED. The
#      fleet operator reconciles that CR and binds the org namespace `opencrane-<org>`.
#   2. SILO chart (apps/clustertenant-platform): the org's control-plane + runtime planes,
#      installed into `opencrane-<org>` (delegated to that app's deploy.sh).
#
# Both passes run through the shared engine (libs/k8s-platform/k8s-deploy.sh) so cluster
# work cannot diverge; this script only presets the single-tenant value flags + ordering.
#
# Usage:
#   libs/k8s-platform/deploy-single-tenant.sh \
#       --base-domain dev.opencrane.ai \
#       --org-name acme --org-owner-email owner@acme.example \
#       [--org-display-name "Acme Inc"] [--org-tier shared|dedicatedNodes|dedicatedCluster] \
#       [ANY k8s-deploy.sh flag, e.g. --cert-manager --acme-email … --dns01-provider clouddns]
#
# --base-domain, --org-name and --org-owner-email are required (the org cannot be seeded
# without an identity + a name + a domain to serve it at).
#
# Prereqs: kubectl (pointed at the target cluster) and helm.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE="$SCRIPT_DIR/k8s-deploy.sh"
FLEET_CHART="$REPO_ROOT/apps/fleet-platform"
SILO_DEPLOY="$REPO_ROOT/apps/clustertenant-platform/deploy.sh"

ORG_NAME=""
ORG_DISPLAY_NAME=""
ORG_OWNER_EMAIL=""
ORG_TIER="shared"
BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
PASSTHROUGH=()

err() { echo -e "\033[0;31m[single-tenant]\033[0m $1" >&2; }
log() { echo -e "\033[0;32m[single-tenant]\033[0m $1"; }

# Parse only the profile-specific flags; everything else is forwarded verbatim to BOTH
# passes (so every k8s-deploy.sh flag — cert-manager, dns01, etc. — works here unchanged).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --org-name)          ORG_NAME="$2"; shift 2 ;;
    --org-display-name)  ORG_DISPLAY_NAME="$2"; shift 2 ;;
    --org-owner-email)   ORG_OWNER_EMAIL="$2"; shift 2 ;;
    --org-tier)          ORG_TIER="$2"; shift 2 ;;
    --base-domain)       BASE_DOMAIN="$2"; shift 2 ;;
    -h|--help)           grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                   PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ -n "$BASE_DOMAIN" ]]     || { err "--base-domain is required (the org is served at <org-name>.<base-domain>)."; exit 1; }
[[ -n "$ORG_NAME" ]]        || { err "--org-name is required (the seeded organisation name)."; exit 1; }
[[ -n "$ORG_OWNER_EMAIL" ]] || { err "--org-owner-email is required (the org's single owner)."; exit 1; }

# --- Pass 1: the FLEET chart — bootstrap + fleet-manager, self-service OFF, ONE org seeded. ---
log "Pass 1/2: fleet chart (cluster bootstrap + fleet-manager; self-service OFF; seeding org '$ORG_NAME')"
FLEET_SET=(
  --base-domain "$BASE_DOMAIN"
  --set "fleetManager.clusterTenantApi.enabled=false"
  --set "billing.enabled=false"
  --set "multiInstance.enabled=false"
  --set "clusterTenant.seed.name=$ORG_NAME"
  --set "clusterTenant.seed.ownerEmail=$ORG_OWNER_EMAIL"
  --set "clusterTenant.seed.tier=$ORG_TIER"
)
[[ -n "$ORG_DISPLAY_NAME" ]] && FLEET_SET+=(--set "clusterTenant.seed.displayName=$ORG_DISPLAY_NAME")
OPENCRANE_CHART_DIR="$FLEET_CHART" "$CORE" "${FLEET_SET[@]}" "${PASSTHROUGH[@]}"

# --- Pass 2: the SILO chart for that one org (its control-plane + planes in opencrane-<org>). ---
# The fleet operator (pass 1) binds opencrane-<org>; the silo install converges into it (the
# operator's namespace apply is idempotent, so either ordering of the namespace settles).
log "Pass 2/2: silo chart for org '$ORG_NAME' (control-plane + planes in opencrane-$ORG_NAME)"
exec "$SILO_DEPLOY" --base-domain "$BASE_DOMAIN" --cluster-tenant "$ORG_NAME" "${PASSTHROUGH[@]}"
