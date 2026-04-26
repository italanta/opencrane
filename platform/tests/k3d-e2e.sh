#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-opencrane-e2e}"
NAMESPACE="${NAMESPACE:-opencrane-system}"
RELEASE_NAME="${RELEASE_NAME:-opencrane}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-240}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"

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

# 4. Import images into the k3d cluster runtime.
echo "[e2e] Importing images into k3d"
k3d image import opencrane/operator:e2e --cluster "$CLUSTER_NAME"
k3d image import opencrane/tenant:e2e --cluster "$CLUSTER_NAME"

# 5. Install Helm chart with k3d-safe overrides.
echo "[e2e] Installing Helm release '$RELEASE_NAME'"
helm upgrade --install "$RELEASE_NAME" "$ROOT_DIR/platform/helm" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --values "$ROOT_DIR/platform/tests/values-k3d-e2e.yaml"

# Wait for operator deployment (skip helm --wait because local-path PVCs don't bind
# until a pod mounts them, creating a chicken-and-egg with Helm's readiness checks).
kubectl rollout status deployment/opencrane-operator -n "$NAMESPACE" --timeout=120s

# Wait for LiteLLM when cost routing is enabled by chart values.
if kubectl get deployment/opencrane-litellm -n "$NAMESPACE" >/dev/null 2>&1; then
  kubectl rollout status deployment/opencrane-litellm -n "$NAMESPACE" --timeout=120s
fi

# 6. Create a Tenant CR and let the operator reconcile child resources.
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

# 7. Assert core reconciled resources exist.
kubectl get serviceaccount openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get configmap openclaw-e2e-config -n "$NAMESPACE" >/dev/null
kubectl get deployment openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get service openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get ingress openclaw-e2e -n "$NAMESPACE" >/dev/null
kubectl get secret openclaw-e2e-encryption-key -n "$NAMESPACE" >/dev/null

# 8. Assert status fields were written by the operator.
INGRESS_HOST="$(kubectl get tenant e2e -n "$NAMESPACE" -o jsonpath='{.status.ingressHost}')"
if [[ "$INGRESS_HOST" != "e2e.opencrane.local" ]]; then
  echo "[e2e] Unexpected ingress host: $INGRESS_HOST"
  exit 1
fi

echo "[e2e] PASS: Helm install + Tenant reconcile smoke test succeeded"
