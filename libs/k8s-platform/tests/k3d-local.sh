#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
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
LANGFUSE_SECRET_NAME="${LANGFUSE_SECRET_NAME:-opencrane-langfuse}"
LANGFUSE_NEXTAUTH_SECRET="${LANGFUSE_NEXTAUTH_SECRET:-opencrane-local-langfuse-nextauth-secret}"
LANGFUSE_SALT="${LANGFUSE_SALT:-opencrane-local-langfuse-salt}"
LANGFUSE_ENCRYPTION_KEY="${LANGFUSE_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-pk-lf-opencrane-local-public-key}"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-sk-lf-opencrane-local-secret-key}"
LANGFUSE_ADMIN_PASSWORD="${LANGFUSE_ADMIN_PASSWORD:-opencrane-local-langfuse-admin-password}"
LANGFUSE_CH_PASSWORD="${LANGFUSE_CH_PASSWORD:-opencrane-local-langfuse-clickhouse-password}"

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
      echo "$ROOT_DIR/libs/k8s-platform/tests/values-k3d-local.yaml"
      ;;
    strict)
      echo "$ROOT_DIR/libs/k8s-platform/tests/values-k3d-strict.yaml"
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
docker build -f "$ROOT_DIR/apps/fleet-operator/deploy/Dockerfile" -t opencrane/operator:local "$ROOT_DIR"

echo "[local] Building tenant image"
docker build -f "$ROOT_DIR/apps/tenant/deploy/Dockerfile" -t opencrane/tenant:local "$ROOT_DIR"

echo "[local] Building control-plane image"
docker build -f "$ROOT_DIR/apps/clustertenant-operator/deploy/Dockerfile" -t opencrane/clustertenant-manager:local "$ROOT_DIR"

echo "[local] Building skill-registry image"
docker build -f "$ROOT_DIR/apps/skill-registry/deploy/Dockerfile" -t opencrane/skill-registry:local "$ROOT_DIR"

# 3. Create a fresh cluster for a deterministic full-stack install.
echo "[local] Recreating k3d cluster '$CLUSTER_NAME'"
k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER_NAME" --agents 1

# 4a. Pre-pulling the official CloudNativePG database image.
echo "[local] Pre-pulling official CloudNativePG database image"
docker pull ghcr.io/cloudnative-pg/postgresql:16

# 4b. Import locally built images into the k3d runtime.
echo "[local] Importing images into k3d"
k3d image import opencrane/operator:local --cluster "$CLUSTER_NAME"
k3d image import opencrane/tenant:local --cluster "$CLUSTER_NAME"
k3d image import opencrane/clustertenant-manager:local --cluster "$CLUSTER_NAME"
k3d image import opencrane/skill-registry:local --cluster "$CLUSTER_NAME"
k3d image import ghcr.io/cloudnative-pg/postgresql:16 --cluster "$CLUSTER_NAME"

echo "[local] Using profile '$LOCAL_PROFILE' with values '$VALUES_FILE'"

# 5. Install in-cluster PostgreSQL and publish the DATABASE_URL secret expected by the chart.
echo "[local] Installing CloudNativePG Engine Operator into control plane"
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --wait \
  --set-string monitoring.podMonitor.enabled=false

echo "[local] Bootstrapping credentials secret for PostgreSQL"
kubectl create secret generic "${DB_RELEASE_NAME}-creds" \
  -n "$NAMESPACE" \
  --from-literal=username=opencrane \
  --from-literal=password="$DB_PASSWORD" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "[local] Applying CloudNativePG configuration layer"
cat <<EOF | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${DB_RELEASE_NAME}
  namespace: ${NAMESPACE}
spec:
  instances: 1
  enablePDB: false
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  storage:
    size: 10Gi
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
        # The silo (clustertenant) control-plane is a SEPARATE Prisma client from the fleet
        # registry — they cannot share a database (each owns its own _prisma_migrations).
        - CREATE DATABASE silo OWNER opencrane;
        $( if grep -A 5 "langfuse:" "$VALUES_FILE" 2>/dev/null | grep -A 5 "inCluster:" | grep -q "enabled: true"; then echo "        - CREATE DATABASE langfuse OWNER opencrane;"; fi )
EOF

echo "[local] Waiting for Control-Plane Database Engine to stabilize..."
kubectl wait --for=condition=Ready cluster/"${DB_RELEASE_NAME}" -n "$NAMESPACE" --timeout="${TIMEOUT_SECONDS}s"

# Note: CNPG creates a service structured as [cluster-name]-rw for write/read routes
kubectl create secret generic "$DB_SECRET_NAME" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/opencrane" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

# Silo control-plane DB secret (separate database; see CREATE DATABASE silo above).
kubectl create secret generic "opencrane-silo-db" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/silo" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "[local] Bootstrapping credentials secret for Obot MCP Gateway"
kubectl create secret generic "opencrane-silo-obot" \
  -n "$NAMESPACE" \
  --from-literal=dsn="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/obot" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "[local] Bootstrapping credentials secret for LiteLLM database"
kubectl create secret generic "opencrane-litellm-db" \
  -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://opencrane:${DB_PASSWORD}@${DB_RELEASE_NAME}-rw.${NAMESPACE}.svc.cluster.local:5432/litellm" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

if grep -A 5 "langfuse:" "$VALUES_FILE" 2>/dev/null | grep -A 5 "inCluster:" | grep -q "enabled: true"; then
  echo "[local] Bootstrapping credentials secret for Langfuse"
  kubectl create secret generic "opencrane-langfuse" \
    -n "$NAMESPACE" \
    --from-literal=NEXTAUTH_SECRET="$LANGFUSE_NEXTAUTH_SECRET" \
    --from-literal=SALT="$LANGFUSE_SALT" \
    --from-literal=ENCRYPTION_KEY="$LANGFUSE_ENCRYPTION_KEY" \
    --from-literal=CLICKHOUSE_PASSWORD="$LANGFUSE_CH_PASSWORD" \
    --from-literal=LANGFUSE_INIT_PROJECT_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
    --from-literal=LANGFUSE_INIT_PROJECT_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
    --from-literal=LANGFUSE_INIT_USER_PASSWORD="$LANGFUSE_ADMIN_PASSWORD" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
fi

if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  kubectl create secret generic "$LITELLM_SECRET_NAME" \
    -n "$NAMESPACE" \
    --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
fi

# 5b. Install cert-manager if enabled in the resolved values file to support in-cluster TLS certificate generation.
if grep -A 5 "certManager:" "$VALUES_FILE" 2>/dev/null | grep -q "enabled: true"; then
  echo "[local] Installing cert-manager"
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --set crds.enabled=true \
    --wait
fi

# 6. Install the FLEET chart (fleet-manager + cluster bootstrap) wired to the in-cluster registry DB.
echo "[local] Installing fleet release '$RELEASE_NAME'"
helm_args=(
  upgrade
  --install
  "$RELEASE_NAME"
  "$ROOT_DIR/apps/fleet-platform"
  --namespace
  "$NAMESPACE"
  --create-namespace
  --values
  "$VALUES_FILE"
  --set
  "fleetManager.database.existingSecret=$DB_SECRET_NAME"
  --set
  "fleetManager.clusterTenantApi.enabled=false"
  --set
  "litellm.existingDatabaseSecret=opencrane-litellm-db"
)

if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  helm_args+=(--set "litellm.existingSecret=$LITELLM_SECRET_NAME")
else
  helm_args+=(--set-string "litellm.masterKey=$LITELLM_MASTER_KEY")
fi

# Per-cluster platform-operator seed (optional). Passed to Helm only when non-empty,
# so a default local install grants operator to nobody (fail-closed). Set via the
# OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL env (e.g. from the wizard).
if [[ -n "${OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL:-}" ]]; then
  helm_args+=(--set-string "fleetManager.oidc.platformOperatorSeedEmail=${OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL}")
  echo "[local] Seeding platform operator (verified OIDC email match) for this cluster"
fi

helm "${helm_args[@]}"

# 6b. Install the SILO chart (clustertenant-manager + the in-silo TenantOperator + planes) into the
#     SAME namespace for this single-machine full stack. The two charts' resource sets are disjoint,
#     so co-installing them in one namespace is safe; each self-migrates its own DB via its db-migrate
#     initContainer (fleet → registry DB, silo → the separate `silo` DB) — no manual migration Job.
echo "[local] Installing silo release 'opencrane-silo'"
silo_args=(
  upgrade
  --install
  opencrane-silo
  "$ROOT_DIR/apps/clustertenant-platform"
  --namespace
  "$NAMESPACE"
  --values
  "$VALUES_FILE"
  --set
  "clustertenantManager.database.existingSecret=opencrane-silo-db"
  --set
  "litellm.existingDatabaseSecret=opencrane-litellm-db"
)
if [[ "$LOCAL_PROFILE" == "strict" ]]; then
  silo_args+=(--set "litellm.existingSecret=$LITELLM_SECRET_NAME")
else
  silo_args+=(--set-string "litellm.masterKey=$LITELLM_MASTER_KEY")
fi
helm "${silo_args[@]}"

# 7. Wait for the platform workloads that depend on the database.
_wait_for_rollout "deployment/opencrane-fleet-manager"
_wait_for_rollout "deployment/opencrane-silo-clustertenant-manager"

if kubectl get deployment/opencrane-silo-litellm -n "$NAMESPACE" >/dev/null 2>&1; then
  _wait_for_rollout "deployment/opencrane-silo-litellm"
fi

echo "[local] PASS: local full-stack install succeeded"
echo "[local] Cluster: $CLUSTER_NAME"
echo "[local] Namespace: $NAMESPACE"
echo "[local] Control plane: http://localhost (expose with kubectl port-forward if needed)"
