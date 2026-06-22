#!/usr/bin/env bash
# =============================================================================
# OpenCrane — install onto ANY Kubernetes cluster
#
# Installs OpenCrane onto the cluster your current kubectl context points at:
# CloudNativePG (in-cluster PostgreSQL) → secrets → the OpenCrane Helm chart →
# DB migrations. Uses the published ghcr.io/opencrane images and the cluster's
# default StorageClass — pure, provider-agnostic Kubernetes.
#
# This is the shared core. vps-deploy.sh and gke-deploy.sh provision a cluster
# and then call this script.
#
# Usage:
#   ./platform/k8s-deploy.sh [--domain DOMAIN] [--namespace NS] [--release NAME]
#                            [--image-tag TAG] [--storage-class SC]
#                            [--control-plane-tag TAG] [--operator-tag TAG]
#                            [--tenant-tag TAG]
#                            [--oidc-issuer-url URL] [--oidc-client-id ID]
#                            [--oidc-redirect-uri URI]
#                            [--platform-operator-seed-email EMAIL]
#                            [--values FILE] [--set k=v ...]
#
# --image-tag pins all three platform images (control-plane, operator, tenant)
# to the same tag. To roll a SINGLE component to a different build, pass the
# matching per-component flag (e.g. --control-plane-tag sha-abc123); it overrides
# --image-tag for that component only. ALWAYS bump component images this way —
# never `kubectl set image` / `kubectl patch` a managed deployment. An imperative
# patch creates a `kubectl-*` field manager that owns the image field on the live
# object and makes every later `helm upgrade` fail with a field-ownership conflict.
#
# The platform-operator seed email bootstraps the FIRST platform operator: the
# caller whose VERIFIED OIDC email equals it becomes a platform operator. It is a
# per-cluster INSTALL parameter — DEFAULTS TO EMPTY, which grants operator to
# nobody (fail-closed). Also accepted via the OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL
# env var. Never commit a real owner email into the repo.
#
# Prereqs: kubectl (pointed at the target cluster) and helm.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$SCRIPT_DIR/helm"

NAMESPACE="opencrane-system"
RELEASE="opencrane"
IMAGE_TAG="latest"
CONTROL_PLANE_TAG=""    # empty → falls back to IMAGE_TAG
OPERATOR_TAG=""         # empty → falls back to IMAGE_TAG
TENANT_TAG=""           # empty → falls back to IMAGE_TAG
DOMAIN=""
STORAGE_CLASS=""        # empty → cluster default StorageClass
VALUES_FILE=""
EXTRA_SET=()

# OIDC + per-cluster operator bootstrap. All default empty (OIDC stays disabled and the
# seed grants operator to nobody — fail-closed). The seed also accepts an env var so a
# secret manager / CI can supply it without it appearing on the command line.
OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI:-}"
PLATFORM_OPERATOR_SEED_EMAIL="${OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL:-}"

DB_CLUSTER="opencrane-db"
DB_SECRET="opencrane-db"
DB_USER="opencrane"
DB_NAME="opencrane"
TIMEOUT="${TIMEOUT_SECONDS:-300}"

log()  { echo -e "\033[0;32m[k8s-deploy]\033[0m $1"; }
warn() { echo -e "\033[1;33m[k8s-deploy]\033[0m $1"; }
err()  { echo -e "\033[0;31m[k8s-deploy]\033[0m $1" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="$2"; shift 2 ;;
    --namespace)     NAMESPACE="$2"; shift 2 ;;
    --release)       RELEASE="$2"; shift 2 ;;
    --image-tag)        IMAGE_TAG="$2"; shift 2 ;;
    --control-plane-tag) CONTROL_PLANE_TAG="$2"; shift 2 ;;
    --operator-tag)     OPERATOR_TAG="$2"; shift 2 ;;
    --tenant-tag)       TENANT_TAG="$2"; shift 2 ;;
    --storage-class) STORAGE_CLASS="$2"; shift 2 ;;
    --oidc-issuer-url)   OIDC_ISSUER_URL="$2"; shift 2 ;;
    --oidc-client-id)    OIDC_CLIENT_ID="$2"; shift 2 ;;
    --oidc-redirect-uri) OIDC_REDIRECT_URI="$2"; shift 2 ;;
    --platform-operator-seed-email) PLATFORM_OPERATOR_SEED_EMAIL="$2"; shift 2 ;;
    --values)        VALUES_FILE="$2"; shift 2 ;;
    --set)           EXTRA_SET+=(--set "$2"); shift 2 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               err "Unknown flag: $1"; exit 1 ;;
  esac
done

for c in kubectl helm; do command -v "$c" >/dev/null 2>&1 || { err "Missing required command: $c"; exit 1; }; done
kubectl cluster-info >/dev/null 2>&1 || { err "kubectl can't reach a cluster. Point your context at the target cluster first."; exit 1; }

_gen_secret() { openssl rand -hex 16 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32; }
DB_PASSWORD="${DB_PASSWORD:-$(_gen_secret)}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-$(_gen_secret)}"

log "Target cluster: $(kubectl config current-context)"
log "Namespace: $NAMESPACE   Release: $RELEASE   Image tag: $IMAGE_TAG"

# 1. In-cluster PostgreSQL via the CloudNativePG operator.
log "Installing CloudNativePG operator…"
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace "$NAMESPACE" --create-namespace --wait \
  --set-string monitoring.podMonitor.enabled=false

log "Creating database credentials…"
kubectl create secret generic "${DB_CLUSTER}-creds" -n "$NAMESPACE" \
  --from-literal=username="$DB_USER" --from-literal=password="$DB_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Provisioning the PostgreSQL cluster…"
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${DB_CLUSTER}
  namespace: ${NAMESPACE}
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  storage:
    size: 10Gi$( [[ -n "$STORAGE_CLASS" ]] && printf '\n    storageClass: %s' "$STORAGE_CLASS" )
  bootstrap:
    initdb:
      database: ${DB_NAME}
      secret:
        name: ${DB_CLUSTER}-creds
      postInitApplicationSQL:
        - CREATE DATABASE obot OWNER ${DB_USER};
        - CREATE DATABASE litellm OWNER ${DB_USER};
EOF

log "Waiting for the database to become ready…"
kubectl wait --for=condition=Ready "cluster/${DB_CLUSTER}" -n "$NAMESPACE" --timeout="${TIMEOUT}s"

# 2. Connection + LiteLLM secrets the chart expects.
DB_HOST="${DB_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local:5432"

kubectl create secret generic "$DB_SECRET" -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/${DB_NAME}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-obot -n "$NAMESPACE" \
  --from-literal=dsn="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/obot" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-litellm-db -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/litellm" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-litellm -n "$NAMESPACE" \
  --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" --dry-run=client -o yaml | kubectl apply -f -

# 3. The OpenCrane chart.
log "Installing the OpenCrane Helm release '$RELEASE'…"
helm_args=(upgrade --install "$RELEASE" "$CHART_DIR" --namespace "$NAMESPACE" --create-namespace
  --set "controlPlane.database.existingSecret=$DB_SECRET"
  --set "litellm.existingDatabaseSecret=opencrane-litellm-db"
  --set "litellm.existingSecret=opencrane-litellm")
# Per-component tags override the unified --image-tag so a single component can be
# rolled through Helm (which keeps Helm the sole owner of the image field). Each
# falls back to IMAGE_TAG when its flag is unset, preserving the all-same default.
CP_TAG="${CONTROL_PLANE_TAG:-$IMAGE_TAG}"
OP_TAG="${OPERATOR_TAG:-$IMAGE_TAG}"
TN_TAG="${TENANT_TAG:-$IMAGE_TAG}"
[[ -n "$CP_TAG" ]] && helm_args+=(--set "controlPlane.image.tag=$CP_TAG")
[[ -n "$OP_TAG" ]] && helm_args+=(--set "operator.image.tag=$OP_TAG")
[[ -n "$TN_TAG" ]] && helm_args+=(--set "tenant.image.tag=$TN_TAG")
[[ -n "$DOMAIN" ]]    && helm_args+=(--set "ingress.domain=$DOMAIN")
# OIDC human-login (control-plane only). Rendered iff an issuer URL is given; otherwise
# the chart emits no OIDC env and the control-plane stays in token/development mode.
[[ -n "$OIDC_ISSUER_URL" ]]   && helm_args+=(--set "controlPlane.oidc.issuerUrl=$OIDC_ISSUER_URL")
[[ -n "$OIDC_CLIENT_ID" ]]    && helm_args+=(--set "controlPlane.oidc.clientId=$OIDC_CLIENT_ID")
[[ -n "$OIDC_REDIRECT_URI" ]] && helm_args+=(--set "controlPlane.oidc.redirectUri=$OIDC_REDIRECT_URI")
# Per-cluster platform-operator SEED. Set ONLY when a non-empty value is supplied; an
# empty seed is never passed, so the chart grants operator to nobody (fail-closed).
if [[ -n "$PLATFORM_OPERATOR_SEED_EMAIL" ]]; then
  helm_args+=(--set-string "controlPlane.oidc.platformOperatorSeedEmail=$PLATFORM_OPERATOR_SEED_EMAIL")
  warn "Seeding platform operator for the cluster (verified OIDC email match). Remove the seed once a group mapping is in place."
fi
[[ -n "$VALUES_FILE" ]] && helm_args+=(--values "$VALUES_FILE")
helm_args+=("${EXTRA_SET[@]}")
helm "${helm_args[@]}"

# 4. Wait for the core workloads.
# Database migrations run automatically in the control-plane's `db-migrate`
# initContainer (prisma migrate deploy) before the server starts — so the
# rollout below also gates on a successful migration. Any `helm upgrade` or
# pod restart re-runs it idempotently; no separate migration Job needed.
kubectl rollout status "deployment/${RELEASE}-operator" -n "$NAMESPACE" --timeout="${TIMEOUT}s"
kubectl rollout status "deployment/${RELEASE}-control-plane" -n "$NAMESPACE" --timeout="${TIMEOUT}s"

log "Done. OpenCrane is installed in namespace '$NAMESPACE'."
[[ -n "$DOMAIN" ]] && log "Point your DNS at the ingress, then visit https://${DOMAIN}"
log "Ingress: kubectl get ingress -n $NAMESPACE"
