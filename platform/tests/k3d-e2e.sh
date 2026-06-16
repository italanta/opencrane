#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-opencrane-e2e}"
NAMESPACE="${NAMESPACE:-opencrane-system}"
RELEASE_NAME="${RELEASE_NAME:-opencrane}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-240}"
DB_STORAGE_GB="${DB_STORAGE_GB:-10}"
DISK_HEADROOM_GB="${DISK_HEADROOM_GB:-2}"
MIN_FREE_GB="${MIN_FREE_GB:-$(( DB_STORAGE_GB + DISK_HEADROOM_GB ))}"
DB_RELEASE_NAME="${DB_RELEASE_NAME:-opencrane-db}"
DB_SECRET_NAME="${DB_SECRET_NAME:-opencrane-db}"
DB_PASSWORD="${DB_PASSWORD:-opencrane-e2e-password}"
LOCAL_PROFILE="${LOCAL_PROFILE:-}"
LITELLM_SECRET_NAME="${LITELLM_SECRET_NAME:-opencrane-litellm}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-}"

function _require_cmd()
{
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[e2e] Missing required command: $cmd"
    exit 1
  fi
}

function _require_docker_healthy()
{
  if ! docker info >/dev/null 2>&1; then
    echo "[e2e] Docker daemon is not reachable. Start Colima/Docker and retry."
    exit 1
  fi
}

function _require_free_space()
{
  local free_kb
  local min_free_kb

  free_kb="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
  min_free_kb="$(( MIN_FREE_GB * 1024 * 1024 ))"

  if [[ -z "$free_kb" || "$free_kb" -lt "$min_free_kb" ]]; then
    echo "[e2e] Insufficient free disk space for image builds."
    echo "[e2e] Baseline includes DB storage (${DB_STORAGE_GB}GiB) + headroom (${DISK_HEADROOM_GB}GiB)."
    echo "[e2e] Required: ${MIN_FREE_GB}GiB, Available: $(( free_kb / 1024 / 1024 ))GiB"
    exit 1
  fi
}

function _cleanup()
{
  if [[ "$KEEP_CLUSTER" == "1" ]]; then
    echo "[e2e] KEEP_CLUSTER=1, leaving k3d cluster '$CLUSTER_NAME' running"
    return
  fi

  echo "[e2e] Deleting k3d cluster '$CLUSTER_NAME'"
  k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
}

function _wait_for_tenant_running()
{
  local deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

  while [[ $(date +%s) -lt $deadline ]]; do
    local phase
    phase="$(kubectl get tenant e2e -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [[ "$phase" == "Running" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "[e2e] Timed out waiting for Tenant status.phase=Running"
  kubectl get tenant e2e -n "$NAMESPACE" -o yaml || true
  return 1
}

trap _cleanup EXIT

# 1. Pre-flight — fail fast when required CLIs are missing.
_require_cmd docker
_require_cmd kubectl
_require_cmd helm
_require_cmd k3d
_require_docker_healthy
_require_free_space

# 2. Build local images so e2e does not depend on pre-published GHCR tags.
echo "[e2e] Building operator image"
docker build -f "$ROOT_DIR/apps/operator/deploy/Dockerfile" -t opencrane/operator:e2e "$ROOT_DIR"

echo "[e2e] Building tenant image"
docker build -f "$ROOT_DIR/apps/tenant/deploy/Dockerfile" -t opencrane/tenant:e2e "$ROOT_DIR"

# 3. Create a fresh cluster for deterministic test runs.
echo "[e2e] Recreating k3d cluster '$CLUSTER_NAME'"
k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER_NAME" --agents 1

# 4a. Pre-pulling the official CloudNativePG database image.
echo "[e2e] Pre-pulling official CloudNativePG database image"
docker pull ghcr.io/cloudnative-pg/postgresql:16

# 4b. Import images into the k3d cluster runtime.
echo "[e2e] Importing images into k3d"
k3d image import opencrane/operator:e2e --cluster "$CLUSTER_NAME"
k3d image import opencrane/tenant:e2e --cluster "$CLUSTER_NAME"
k3d image import ghcr.io/cloudnative-pg/postgresql:16 --cluster "$CLUSTER_NAME"

# 5. Install in-cluster PostgreSQL and publish the DATABASE_URL secret expected by the chart.
echo "[e2e] Installing CloudNativePG Engine Operator into control plane"
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --wait \
  --set-string monitoring.podMonitor.enabled=false

echo "[e2e] Bootstrapping credentials secret for PostgreSQL"
kubectl create secret generic "${DB_RELEASE_NAME}-creds" \
  -n "$NAMESPACE" \
  --from-literal=username=opencrane \
  --from-literal=password="$DB_PASSWORD" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "[e2e] Applying CloudNativePG configuration layer"
cat <<EOF | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${DB_RELEASE_NAME}
  namespace: ${NAMESPACE}
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  storage:
    size: ${DB_STORAGE_GB}Gi
    storageClass: local-path
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
  bootstrap:
    initdb:
      database: opencrane
      secret:
        name: ${DB_RELEASE_NAME}-creds
      postInitApplicationSQL:
        - CREATE DATABASE obot OWNER opencrane;
        - CREATE DATABASE litellm OWNER opencrane;
EOF

echo "[e2e] Waiting for Control-Plane Database Engine to stabilize..."
kubectl wait --for=condition=Ready cluster/"${DB_RELEASE_NAME}" -n "$NAMESPACE" --timeout="${TIMEOUT_SECONDS}s"

# Note: CNPG creates a service structured as [cluster-name]-rw for write/read routes
kubectl create secret generic "$DB_SECRET_NAME" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/opencrane" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl create secret generic "opencrane-obot" \
  -n "$NAMESPACE" \
  --from-literal=dsn="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/obot" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl create secret generic "opencrane-litellm-db" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/litellm" \
  --dry-run=client \
  -o yaml | kubectl apply -f -


if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  if [[ -z "$LITELLM_MASTER_KEY" ]]; then
    echo "[e2e] LOCAL_PROFILE=strict requires LITELLM_MASTER_KEY to be set and non-empty"
    echo "[e2e] Example: LOCAL_PROFILE=strict LITELLM_MASTER_KEY=dev-e2e-key platform/tests/k3d-e2e.sh"
    exit 1
  fi

  kubectl create secret generic "$LITELLM_SECRET_NAME" \
    -n "$NAMESPACE" \
    --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
fi

# 6. Install Helm chart with k3d-safe overrides wired to the in-cluster database.
echo "[e2e] Installing Helm release '$RELEASE_NAME'"
helm upgrade --install "$RELEASE_NAME" "$ROOT_DIR/platform/helm" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --values "$ROOT_DIR/platform/tests/values-k3d-e2e.yaml" \
  --set "litellm.existingDatabaseSecret=opencrane-litellm-db"

# Wait for operator deployment (skip helm --wait because local-path PVCs don't bind
# until a pod mounts them, creating a chicken-and-egg with Helm's readiness checks).
kubectl rollout status deployment/opencrane-operator -n "$NAMESPACE" --timeout=120s

# Wait for LiteLLM when cost routing is enabled by chart values.
if kubectl get deployment/opencrane-litellm -n "$NAMESPACE" >/dev/null 2>&1; then
  kubectl rollout status deployment/opencrane-litellm -n "$NAMESPACE" --timeout=240s
fi

# 7. Create a Tenant CR and let the operator reconcile child resources.
echo "[e2e] Creating Tenant CR"
cat <<EOF | kubectl apply -f -
apiVersion: opencrane.io/v1alpha1
kind: Tenant
metadata:
  name: e2e
  namespace: ${NAMESPACE}
spec:
  displayName: E2E Tenant
  email: e2e@example.com
  team: engineering
EOF

_wait_for_tenant_running

# 8. Assert core reconciled resources exist.
kubectl get serviceaccount openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get configmap openclaw-e2e-config -n "$NAMESPACE" >/dev/null
kubectl get deployment openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get service openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get ingress openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get secret openclaw-e2e-encryption-key -n "$NAMESPACE" >/dev/null

# 9. Assert status fields were written by the operator.
INGRESS_HOST="$(kubectl get tenant e2e -n "$NAMESPACE" -o jsonpath='{.status.ingressHost}')"
if [[ "$INGRESS_HOST" != "e2e.opencrane.local" ]]; then
  echo "[e2e] Unexpected ingress host: $INGRESS_HOST"
  exit 1
fi

echo "[e2e] PASS: Helm install + Tenant reconcile smoke test succeeded"
