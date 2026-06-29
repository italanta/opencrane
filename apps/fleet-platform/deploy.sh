#!/usr/bin/env bash
# =============================================================================
# OpenCrane — MULTI-TENANT deploy profile
#
# A thin profile over the shared install core (k8s-deploy.sh). It installs the
# multi-tenant platform on the cluster your kubectl context points at: the SAME
# prereqs as single-tenant (in-cluster PostgreSQL, ingress-nginx, Cognee, optional
# cert-manager) PLUS the self-service ClusterTenant manager + billing ON, and the
# fleet wildcard wiring (the per-org `*.<org>.<base>` DNS + TLS the operator
# provisions at org-creation time). NO org is seeded — callers self-serve a billing
# account then create their own organisations.
#
# All cluster work lives in k8s-deploy.sh so the two profiles CANNOT diverge — this
# script only presets the multi-tenant value flags and forwards everything else.
#
# Usage:
#   apps/fleet-platform/deploy.sh \
#       --base-domain dev.opencrane.ai \
#       [--ingress-ip 34.1.2.3] [--dns-managed-zone my-zone] \
#       [ANY k8s-deploy.sh flag, e.g. --cert-manager --acme-email … --dns01-provider clouddns]
#
# --base-domain is required (the platform wildcard base every org is served under).
# --ingress-ip / --dns-managed-zone wire the operator's per-org DNS side effect. When
# --ingress-ip is OMITTED the core auto-derives it from the ingress-nginx LoadBalancer
# (--auto-ingress-ip); on-prem with no LB it stays unset and the operator skips the DNS
# write (per-org Certificate still applied). Add --verify for an advisory post-deploy check.
#
# Prereqs: kubectl (pointed at the target cluster) and helm.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared deploy engine now lives in the k8s-platform lib; the FLEET chart is co-located here.
CORE="$SCRIPT_DIR/../../libs/k8s-platform/k8s-deploy.sh"
export OPENCRANE_CHART_DIR="$SCRIPT_DIR"

BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
INGRESS_IP=""
DNS_MANAGED_ZONE=""
PASSTHROUGH=()
PROVISION=""        # optional: local|gke|vps — provision a cluster first (else use current context)
PROVISION_ARGS=()   # provisioner-specific flags (--project-id/--region/--cluster/--yes)

err() { echo -e "\033[0;31m[multi-tenant]\033[0m $1" >&2; }

# Parse only the profile-specific flags; everything else is forwarded verbatim to the
# shared core (so every k8s-deploy.sh flag works here unchanged).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ingress-ip)        INGRESS_IP="$2"; shift 2 ;;
    --dns-managed-zone)  DNS_MANAGED_ZONE="$2"; shift 2 ;;
    --base-domain)       BASE_DOMAIN="$2"; PASSTHROUGH+=(--base-domain "$2"); shift 2 ;;
    --provision)         PROVISION="$2"; shift 2 ;;
    --project-id|--region|--cluster) PROVISION_ARGS+=("$1" "$2"); shift 2 ;;
    --yes)               PROVISION_ARGS+=("$1"); shift ;;
    -h|--help)           grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                   PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ -n "$BASE_DOMAIN" ]] || { err "--base-domain is required (the platform wildcard base every org is served under)."; exit 1; }

# Operator bootstrap is MANDATORY for the multi-tenant profile. The fleet seeds NO org, so
# the first platform operator must be granted by a verified seed email OR an IdP group mapping.
# With neither, the deploy grants operator to nobody (fail-closed) and the fleet/super-admin UI
# is inaccessible to everyone — fail fast rather than ship a dead control plane (issue #100).
_have_operator_bootstrap() {
  [[ -n "${OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL:-}" || -n "${OPENCRANE_PLATFORM_OPERATOR_GROUPS:-}" ]] && return 0
  # Match the flag AND require a non-empty VALUE after it — an empty value (e.g.
  # `--platform-operator-seed-email ""`) is dropped downstream by k8s-deploy.sh, so the
  # flag's mere presence is not enough (would otherwise let a no-operator deploy through).
  local i
  for ((i = 0; i < ${#PASSTHROUGH[@]}; i++)); do
    case "${PASSTHROUGH[$i]}" in
      --platform-operator-seed-email|--platform-operator-groups)
        [[ $((i + 1)) -lt ${#PASSTHROUGH[@]} && -n "${PASSTHROUGH[$((i + 1))]}" ]] && return 0
        ;;
    esac
  done
  return 1
}
_have_operator_bootstrap || {
  err "multi-tenant deploy requires a platform-operator bootstrap. Set one of:
    --platform-operator-seed-email EMAIL   (or OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL)
    --platform-operator-groups CSV         (or OPENCRANE_PLATFORM_OPERATOR_GROUPS)
  Without it the fleet grants operator to nobody and the control-plane UI is inaccessible."
  exit 1
}

# MULTI-TENANT value profile: self-service manager + billing ON (the defaults, set
# explicitly so the profile is self-documenting and robust to a changed default), NO
# seeded org, and the fleet wildcard wiring. multiInstance stays at its default off —
# multi-TENANT (many orgs in one install) is distinct from multi-INSTANCE (many isolated
# installs in one cluster).
PROFILE_SET=(
  --set "fleetManager.clusterTenantApi.enabled=true"
  --set "billing.enabled=true"
  --set "ingress.tls.enabled=true"
)
[[ -n "$DNS_MANAGED_ZONE" ]] && PROFILE_SET+=(--set "ingress.dnsManagedZone=$DNS_MANAGED_ZONE")
# When --ingress-ip is given, pin it; otherwise ask the core to auto-derive it from the
# ingress-nginx LoadBalancer once installed (so per-org *.<org>.<base> records resolve
# without hand-copying the IP). An on-prem install with no LB simply leaves it unset.
if [[ -n "$INGRESS_IP" ]]; then
  PROFILE_SET+=(--set "ingress.externalIp=$INGRESS_IP")
else
  PROFILE_SET+=(--auto-ingress-ip)
fi

# Optionally provision a cluster first (--provision local|gke|vps), then deploy onto it. Without
# --provision, deploy onto the current kubectl context. Provisioning lives in the k8s-platform lib
# (this absorbs the old install.sh / gke-deploy.sh / vps-deploy.sh).
if [[ -n "$PROVISION" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/../../libs/k8s-platform/provision.sh"
  _provision_cluster "$PROVISION" ${PROVISION_ARGS[@]+"${PROVISION_ARGS[@]}"}
  [[ ${#PROVISION_DEPLOY_SET[@]} -gt 0 ]] && PROFILE_SET+=("${PROVISION_DEPLOY_SET[@]}")
fi

echo -e "\033[0;32m[multi-tenant]\033[0m Profile: multi-tenant platform on $BASE_DOMAIN (self-service orgs + billing ON)"
exec "$CORE" "${PROFILE_SET[@]}" "${PASSTHROUGH[@]}"
