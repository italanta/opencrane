#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-opencrane-local}"
NAMESPACE="${NAMESPACE:-opencrane-system}"
RELEASE_NAME="${RELEASE_NAME:-opencrane}"
KEEP_CLUSTER="${KEEP_CLUSTER:-1}"
LOCAL_PROFILE="${LOCAL_PROFILE:-default}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
MIN_FREE_GB="${MIN_FREE_GB:-12}"
DB_RELEASE_NAME="${DB_RELEASE_NAME:-opencrane-db}"
DB_SECRET_NAME="${DB_SECRET_NAME:-opencrane-db}"
DB_PASSWORD="${DB_PASSWORD:-opencrane-local-password}"
LITELLM_SECRET_NAME="${LITELLM_SECRET_NAME:-opencrane-litellm}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-opencrane-local-master-key}"

function _require_cmd()
{
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[local] Missing required command: $cmd"
    exit 1
  fi
}

function _require_docker_healthy()
{
  if ! docker info >/dev/null 2>&1; then
    echo "[local] Docker daemon is not reachable. Start Colima/Docker and retry."
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
    echo "[local] Insufficient free disk space for image builds."
    echo "[local] Required: ${MIN_FREE_GB}GiB, Available: $(( free_kb / 1024 / 1024 ))GiB"
    exit 1
  fi
}

function _cleanup()
{
  if [[ "$KEEP_CLUSTER" == "1" ]]; then
    echo "[local] KEEP_CLUSTER=1, leaving k3d cluster '$CLUSTER_NAME' running"
    return
  fi

  echo "[local] Deleting k3d cluster '$CLUSTER_NAME'"
  k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
}

function _wait_for_rollout()
{
  local resource="$1"

  kubectl rollout status "$resource" -n "$NAMESPACE" --timeout="${TIMEOUT_SECONDS}s"
}

function _wait_for_job()
{
  local job_name="$1"

  kubectl wait --for=condition=complete "job/$job_name" -n "$NAMESPACE" --timeout="${TIMEOUT_SECONDS}s"
}

function _resolve_values_file()
{
  case "$LOCAL_PROFILE" in
    default)
      echo "$ROOT_DIR/platform/tests/values-k3d-local.yaml"
      ;;
    strict)
      echo "$ROOT_DIR/platform/tests/values-k3d-strict.yaml"
      ;;
    *)
      echo "[local] Unknown LOCAL_PROFILE: $LOCAL_PROFILE"
      echo "[local] Supported profiles: default, strict"
      exit 1
      ;;
  esac
}

trap _cleanup EXIT

VALUES_FILE="$(_resolve_values_file)"

# 1. Pre-flight — fail fast when required CLIs are missing.
_require_cmd docker
_require_cmd kubectl
_require_cmd helm
_require_cmd k3d
_require_docker_healthy
_require_free_space

# 2. Build local images so the cluster does not depend on published registries.
echo "[local] Building operator image"
docker build -f "$ROOT_DIR/apps/operator/deploy/Dockerfile" -t opencrane/operator:local "$ROOT_DIR"

echo "[local] Building tenant image"
docker build -f "$ROOT_DIR/apps/tenant/deploy/Dockerfile" -t opencrane/tenant:local "$ROOT_DIR"

echo "[local] Building control-plane image"
docker build -f "$ROOT_DIR/apps/control-plane/deploy/Dockerfile" -t opencrane/control-plane:local "$ROOT_DIR"

# 3. Create a fresh cluster for a deterministic full-stack install.
echo "[local] Recreating k3d cluster '$CLUSTER_NAME'"
k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER_NAME" --agents 1

# 4. Import locally built images into the k3d runtime.
echo "[local] Importing images into k3d"
k3d image import opencrane/operator:local --cluster "$CLUSTER_NAME"
k3d image import opencrane/tenant:local --cluster "$CLUSTER_NAME"
k3d image import opencrane/control-plane:local --cluster "$CLUSTER_NAME"

echo "[local] Using profile '$LOCAL_PROFILE' with values '$VALUES_FILE'"

# 5. Install in-cluster PostgreSQL and publish the DATABASE_URL secret expected by the chart.
echo "[local] Installing PostgreSQL release '$DB_RELEASE_NAME'"
helm upgrade --install "$DB_RELEASE_NAME" oci://registry-1.docker.io/bitnamicharts/postgresql \
  --version 16.4.1 \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --wait \
  --set auth.username=opencrane \
  --set auth.password="$DB_PASSWORD" \
  --set auth.database=opencrane \
  --set primary.persistence.size=10Gi \
  --set primary.persistence.storageClass=local-path \
  --set primary.resources.requests.cpu=250m \
  --set primary.resources.requests.memory=256Mi

kubectl create secret generic "$DB_SECRET_NAME" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-postgresql.${NAMESPACE}.svc.cluster.local:5432/opencrane" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  kubectl create secret generic "$LITELLM_SECRET_NAME" \
    -n "$NAMESPACE" \
    --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
fi

# 6. Install the OpenCrane chart with local-strict overrides wired to the in-cluster database.
echo "[local] Installing Helm release '$RELEASE_NAME'"
helm_args=(
  upgrade
  --install
  "$RELEASE_NAME"
  "$ROOT_DIR/platform/helm"
  --namespace
  "$NAMESPACE"
  --create-namespace
  --values
  "$VALUES_FILE"
  --set
  "controlPlane.database.existingSecret=$DB_SECRET_NAME"
  --set
  "litellm.existingDatabaseSecret=$DB_SECRET_NAME"
)

if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  helm_args+=(--set "litellm.existingSecret=$LITELLM_SECRET_NAME")
else
  helm_args+=(--set-string "litellm.masterKey=$LITELLM_MASTER_KEY")
fi

helm "${helm_args[@]}"

# 7. Run schema migrations so the control-plane and LiteLLM share an initialized database.
echo "[local] Running Prisma migrations"
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: opencrane-db-migrate
  namespace: ${NAMESPACE}
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: opencrane/control-plane:local
          imagePullPolicy: IfNotPresent
          command: ["npx", "prisma", "migrate", "deploy"]
          workingDir: /app/apps/control-plane
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${DB_SECRET_NAME}
                  key: DATABASE_URL
EOF

_wait_for_job "opencrane-db-migrate"

# 8. Wait for the platform workloads that depend on the database.
_wait_for_rollout "deployment/opencrane-operator"
_wait_for_rollout "deployment/opencrane-control-plane"

if kubectl get deployment/opencrane-litellm -n "$NAMESPACE" >/dev/null 2>&1; then
  _wait_for_rollout "deployment/opencrane-litellm"
fi

echo "[local] PASS: local full-stack install succeeded"
echo "[local] Cluster: $CLUSTER_NAME"
echo "[local] Namespace: $NAMESPACE"
echo "[local] Control plane: http://localhost (expose with kubectl port-forward if needed)"