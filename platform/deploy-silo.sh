#!/usr/bin/env bash
# =============================================================================
# OpenCrane — per-ClusterTenant SILO deploy profile (S6 / ADR 0002)
#
# A thin profile over the shared install core (k8s-deploy.sh). It installs ONE
# per-ClusterTenant silo — the dedicated stack a single ClusterTenant runs on shared
# nodes: its own operator + Obot + skill-registry + LiteLLM + Cognee + a role=silo
# control-plane + per-CT networking + a per-CT database (one CNPG cluster IN THIS
# SILO'S NAMESPACE, serving the silo control-plane + its planes). deploymentRole=silo.
#
# The CLUSTER-WIDE infra (ingress-nginx, external-dns, the CloudNativePG operator,
# cert-manager) is installed ONCE by the CENTRAL release (deploy-multi-tenant.sh); a
# silo reuses it, so this profile passes --no-ingress-nginx --no-external-dns
# --no-db-operator and does not re-install cert-manager. The silo's own namespaced
# resources (its CNPG Cluster CR, planes, per-org ingress + Certificate) are still
# applied and reconciled by the cluster-wide operators.
#
# The self-service ClusterTenant manager + billing are OFF (a silo serves exactly one
# ClusterTenant; the fleet is managed by the central super-admin control-plane).
#
# Usage:
#   ./platform/deploy-silo.sh \
#       --base-domain dev.opencrane.ai \
#       --cluster-tenant acme \
#       [--namespace opencrane-acme] [--ingress-ip 34.1.2.3] \
#       [ANY k8s-deploy.sh flag]
#
# --base-domain and --cluster-tenant are required. The silo is installed into namespace
# `opencrane-<cluster-tenant>` unless --namespace overrides it. When --ingress-ip is
# omitted the core auto-derives it from the cluster-wide ingress-nginx LoadBalancer.
#
# Prereqs: kubectl (pointed at the target cluster) and helm; the CENTRAL release already
# installed (it brings up the cluster-wide infra this silo reuses).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$SCRIPT_DIR/k8s-deploy.sh"

CLUSTER_TENANT=""
NAMESPACE=""
INGRESS_IP=""
BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
PASSTHROUGH=()

err() { echo -e "\033[0;31m[silo]\033[0m $1" >&2; }

# Parse only the profile-specific flags; everything else is forwarded verbatim to the core.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster-tenant)  CLUSTER_TENANT="$2"; shift 2 ;;
    --namespace)       NAMESPACE="$2"; shift 2 ;;
    --ingress-ip)      INGRESS_IP="$2"; shift 2 ;;
    --base-domain)     BASE_DOMAIN="$2"; PASSTHROUGH+=(--base-domain "$2"); shift 2 ;;
    -h|--help)         grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                 PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ -n "$BASE_DOMAIN" ]]     || { err "--base-domain is required (the platform wildcard base this silo is served under)."; exit 1; }
[[ -n "$CLUSTER_TENANT" ]]  || { err "--cluster-tenant is required (the ClusterTenant this silo serves)."; exit 1; }

# The silo lives in its own namespace so its per-CT DB + planes are isolated from every other
# silo and from the central release. Default `opencrane-<cluster-tenant>`; --namespace overrides.
[[ -n "$NAMESPACE" ]] || NAMESPACE="opencrane-${CLUSTER_TENANT}"

# SILO value profile: deploymentRole=silo (renders the per-CT stack), self-service manager +
# billing OFF, multi-instance OFF. The cluster-wide infra is the central release's job, so skip
# re-installing the ingress controller, external-dns and the CNPG operator (the silo's own CNPG
# Cluster CR is still applied and reconciled by the cluster-wide operator).
PROFILE_SET=(
  --deployment-role silo
  --namespace "$NAMESPACE"
  --no-ingress-nginx
  --no-external-dns
  --no-db-operator
  --set "clusterTenantManager.enabled=false"
  --set "billing.enabled=false"
  --set "multiInstance.enabled=false"
  --set "ingress.tls.enabled=true"
)
# Pin the cluster ingress IP when given; otherwise derive it from the cluster-wide ingress-nginx
# LoadBalancer (installed by the central release) so the silo's per-org hosts resolve.
if [[ -n "$INGRESS_IP" ]]; then
  PROFILE_SET+=(--set "ingress.externalIp=$INGRESS_IP")
else
  PROFILE_SET+=(--auto-ingress-ip)
fi

echo -e "\033[0;32m[silo]\033[0m Profile: silo for ClusterTenant '$CLUSTER_TENANT' in namespace '$NAMESPACE' on $BASE_DOMAIN"
exec "$CORE" "${PROFILE_SET[@]}" "${PASSTHROUGH[@]}"
