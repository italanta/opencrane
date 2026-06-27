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
#   ./platform/deploy-multi-tenant.sh \
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
CORE="$SCRIPT_DIR/k8s-deploy.sh"

BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
INGRESS_IP=""
DNS_MANAGED_ZONE=""
PASSTHROUGH=()

err() { echo -e "\033[0;31m[multi-tenant]\033[0m $1" >&2; }

# Parse only the profile-specific flags; everything else is forwarded verbatim to the
# shared core (so every k8s-deploy.sh flag works here unchanged).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ingress-ip)        INGRESS_IP="$2"; shift 2 ;;
    --dns-managed-zone)  DNS_MANAGED_ZONE="$2"; shift 2 ;;
    --base-domain)       BASE_DOMAIN="$2"; PASSTHROUGH+=(--base-domain "$2"); shift 2 ;;
    -h|--help)           grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                   PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ -n "$BASE_DOMAIN" ]] || { err "--base-domain is required (the platform wildcard base every org is served under)."; exit 1; }

# MULTI-TENANT value profile: self-service manager + billing ON (the defaults, set
# explicitly so the profile is self-documenting and robust to a changed default), NO
# seeded org, and the fleet wildcard wiring. multiInstance stays at its default off —
# multi-TENANT (many orgs in one install) is distinct from multi-INSTANCE (many isolated
# installs in one cluster).
PROFILE_SET=(
  --set "clusterTenantManager.enabled=true"
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

echo -e "\033[0;32m[multi-tenant]\033[0m Profile: multi-tenant platform on $BASE_DOMAIN (self-service orgs + billing ON)"
exec "$CORE" "${PROFILE_SET[@]}" "${PASSTHROUGH[@]}"
