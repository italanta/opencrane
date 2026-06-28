#!/usr/bin/env bash
# =============================================================================
# OpenCrane — SINGLE-TENANT deploy profile
#
# A thin profile over the shared install core (k8s-deploy.sh). It installs ONE
# organisation on the cluster your kubectl context points at: prereqs (in-cluster
# PostgreSQL, ingress-nginx, Cognee, optional cert-manager) + control-plane auth +
# the operator + exactly ONE config-seeded ClusterTenant. The self-service
# ClusterTenant manager and billing are OFF (a single-tenant box has no self-service
# org creation), and multi-cluster / fleet wildcard is OFF.
#
# All cluster work lives in k8s-deploy.sh so the two profiles CANNOT diverge — this
# script only presets the single-tenant value flags and forwards everything else.
#
# Usage:
#   ./platform/deploy-single-tenant.sh \
#       --base-domain dev.opencrane.ai \
#       --org-name acme --org-owner-email owner@acme.example \
#       [--org-display-name "Acme Inc"] [--org-tier shared|dedicatedNodes|dedicatedCluster] \
#       [ANY k8s-deploy.sh flag, e.g. --cert-manager --acme-email … --dns01-provider clouddns]
#
# --base-domain, --org-name and --org-owner-email are required (the org cannot be
# seeded without an identity + a name + a domain to serve it at).
#
# Prereqs: kubectl (pointed at the target cluster) and helm.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$SCRIPT_DIR/k8s-deploy.sh"

ORG_NAME=""
ORG_DISPLAY_NAME=""
ORG_OWNER_EMAIL=""
ORG_TIER="shared"
BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
PASSTHROUGH=()

err() { echo -e "\033[0;31m[single-tenant]\033[0m $1" >&2; }

# Parse only the profile-specific flags; everything else is forwarded verbatim to the
# shared core (so every k8s-deploy.sh flag works here unchanged).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --org-name)          ORG_NAME="$2"; shift 2 ;;
    --org-display-name)  ORG_DISPLAY_NAME="$2"; shift 2 ;;
    --org-owner-email)   ORG_OWNER_EMAIL="$2"; shift 2 ;;
    --org-tier)          ORG_TIER="$2"; shift 2 ;;
    --base-domain)       BASE_DOMAIN="$2"; PASSTHROUGH+=(--base-domain "$2"); shift 2 ;;
    -h|--help)           grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                   PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ -n "$BASE_DOMAIN" ]]     || { err "--base-domain is required (the org is served at <org-name>.<base-domain>)."; exit 1; }
[[ -n "$ORG_NAME" ]]        || { err "--org-name is required (the seeded organisation name)."; exit 1; }
[[ -n "$ORG_OWNER_EMAIL" ]] || { err "--org-owner-email is required (the org's single owner)."; exit 1; }

# SINGLE-TENANT value profile: self-service manager + billing OFF, ONE org seeded, and
# multi-cluster/fleet OFF (multiInstance stays at its default off). The shared core
# applies these via Helm exactly as the multi-tenant profile applies its own.
PROFILE_SET=(
  --set "fleetManager.clusterTenantApi.enabled=false"
  --set "billing.enabled=false"
  --set "multiInstance.enabled=false"
  --set "clusterTenant.seed.name=$ORG_NAME"
  --set "clusterTenant.seed.ownerEmail=$ORG_OWNER_EMAIL"
  --set "clusterTenant.seed.tier=$ORG_TIER"
)
[[ -n "$ORG_DISPLAY_NAME" ]] && PROFILE_SET+=(--set "clusterTenant.seed.displayName=$ORG_DISPLAY_NAME")

echo -e "\033[0;32m[single-tenant]\033[0m Profile: single-tenant org '$ORG_NAME' (owner $ORG_OWNER_EMAIL, tier $ORG_TIER) on $BASE_DOMAIN"
exec "$CORE" "${PROFILE_SET[@]}" "${PASSTHROUGH[@]}"
