# OpenCrane Operations Runbook

This document covers the essential operational procedures for deploying, verifying, upgrading, rolling back, and responding to incidents with the OpenCrane platform.

---

## Table of Contents

1. [Installation](#1-installation)
2. [Verification](#2-verification)
3. [Upgrade Procedures](#3-upgrade-procedures)
4. [Rollback Procedures](#4-rollback-procedures)
5. [Incident Response](#5-incident-response)
6. [Projection Drift Remediation](#6-projection-drift-remediation)
7. [LiteLLM Key Lifecycle](#7-litellm-key-lifecycle)
8. [Tenant Lifecycle Operations](#8-tenant-lifecycle-operations)
9. [Observability Reference](#9-observability-reference)

---

## 1. Installation

### Prerequisites

| Requirement | Minimum version | Purpose |
|-------------|----------------|---------|
| Kubernetes | 1.27+ | Cluster runtime |
| Helm | 3.12+ | Chart installation |
| `kubectl` | ≥ cluster version | Cluster management |
| PostgreSQL | 14+ | Control-plane state |
| Node.js | 22 LTS | Image builds |
| pnpm | 9+ | Workspace builds |

### Local Installation (k3d)

```bash
# 1. Start k3d cluster
k3d cluster create opencrane --agents 1 --port "8080:80@loadbalancer"

# 2. Bootstrap the full local stack (PostgreSQL + LiteLLM + control-plane + operator)
libs/k8s-platform/tests/k3d-local.sh

# 3. Verify all pods are running
kubectl get pods -n opencrane

# 4. Run smoke tests
libs/k8s-platform/tests/k3d-e2e.sh
```

### Production installation (fleet + silos)

Use the deploy scripts rather than bare Helm commands — they set the correct value
profiles for the fleet and silo releases. See [Silo deployment model](/operators/silo-deployment).

```bash
# Step 1: install the fleet release (opencrane-system namespace)
apps/fleet-platform/deploy.sh \
    --base-domain prod.example.com \
    --cert-manager --acme-email ops@example.com --dns01-provider clouddns

# Step 2: install one silo per ClusterTenant
apps/clustertenant-platform/deploy.sh \
    --base-domain prod.example.com \
    --cluster-tenant acme
```

### GCP Production Installation (Terraform path)

```bash
# 1. Authenticate with Google Cloud
gcloud auth application-default login

# 2. Set project and region
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_REGION=us-central1

# 3. Apply Terraform infrastructure
cd libs/k8s-platform/terraform
terraform init
terraform apply -var-file environments/prod/terraform.tfvars

# 4. Get cluster credentials
gcloud container clusters get-credentials opencrane-prod --region $GOOGLE_CLOUD_REGION

# 5. Install fleet release then silo releases via deploy scripts (see above)
```

### Required Environment Variables

Set these via Helm values — the deploy scripts wire them automatically. The variables below are split by which component they apply to.

**Fleet-manager** (`opencrane-system`):

| Variable | Required | Helm key | Description |
|----------|----------|----------|-------------|
| `DATABASE_URL` | Yes | `fleetManager.database.existingSecret` | Fleet registry PostgreSQL connection string |
| `OPENCRANE_CLUSTER_TENANT_MANAGER_ENABLED` | Yes | `clusterTenantManagement.enabled` | Gates the ClusterTenant lifecycle and Zitadel-admin routes |
| `ZITADEL_MGMT_API_URL` | When CT management on | `fleetManager.zitadel.mgmtApiUrl` | Zitadel Management API URL |
| `ZITADEL_MGMT_SA_KEY` | When CT management on | `fleetManager.zitadel.existingSecret` | Zitadel SA key JSON |

**Clustertenant-manager** (each silo namespace):

| Variable | Required | Helm key | Description |
|----------|----------|----------|-------------|
| `DATABASE_URL` | Yes | `clustertenantManager.database.existingSecret` | Per-silo PostgreSQL connection string |
| `LITELLM_MASTER_KEY` | Yes (if LiteLLM enabled) | `litellm.existingSecret` | LiteLLM master API key |
| `OPENCRANE_API_TOKEN` | Yes | — | Bearer token for control-plane API auth |
| `OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD` | No | — | Drift count before alert fires (0 = disabled) |
| `OPENCRANE_DRIFT_WEBHOOK_URL` | No | — | Webhook URL for projection-drift alert delivery |

---

## 2. Verification

### Health Checks

```bash
# Fleet-manager health (opencrane-system)
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<fleet-host>/api/v1/healthz
# Expected response: {"status":"ok","db":true}

# Silo clustertenant-manager health
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/healthz
# Expected response: {"status":"ok","db":true}

# LiteLLM health (per-silo namespace)
curl http://litellm.opencrane-acme.svc.cluster.local:4000/health

# Fleet-manager logs
kubectl logs -n opencrane-system deployment/opencrane-fleet-manager --tail 50

# Silo clustertenant-manager logs (replace <ct> with the ClusterTenant name)
kubectl logs -n opencrane-<ct> deployment/opencrane-clustertenant-manager --tail 50

# List all tenants and their phases (in a specific silo)
kubectl get tenants -n opencrane-<ct>

# Check a specific tenant
kubectl describe tenant acme -n opencrane-<ct>
```

### Smoke Test Suite

```bash
# Run the full k3d e2e smoke test
libs/k8s-platform/tests/k3d-e2e.sh

# Run workspace unit tests
pnpm test

# Build all packages
pnpm build
```

### Cognee Health Check

```bash
kubectl port-forward -n opencrane service/cognee 8000:8000 &
curl http://localhost:8000/health

# Expected: HTTP 200 and a healthy status payload
```

### Harvesting Agent Status

```bash
# Check harvesting-agent metrics
kubectl port-forward -n opencrane deployment/harvesting-agent 9090:9090 &
curl http://localhost:9090/metrics

# Check harvesting-agent logs
kubectl logs -n opencrane deployment/harvesting-agent --tail 50
```

---

## 3. Upgrade Procedures

### Upgrade (fleet and silo releases)

Use the deploy scripts to upgrade — they set the correct value profiles. Upgrade the fleet release and each silo release independently.

```bash
# Upgrade the fleet release
apps/fleet-platform/deploy.sh \
    --base-domain prod.example.com \
    --reuse-values

# Upgrade a silo release
apps/clustertenant-platform/deploy.sh \
    --base-domain prod.example.com \
    --cluster-tenant acme \
    --reuse-values
```

For manual Helm upgrades (with `helm diff` review):

```bash
# 1. Pull the latest chart updates
git pull origin main

# 2. Review changes for the fleet release
helm diff upgrade opencrane-fleet apps/fleet-platform/ \
  --namespace opencrane-system \
  --reuse-values

# 3. Apply the fleet upgrade
helm upgrade opencrane-fleet apps/fleet-platform/ \
  --namespace opencrane-system \
  --reuse-values --wait --timeout 10m

# 4. Verify rollout
kubectl rollout status deployment/opencrane-fleet-manager -n opencrane-system
```

### Fleet-manager rolling restart

```bash
# Force a rolling restart of the fleet-manager (picks up config changes)
kubectl rollout restart deployment/opencrane-fleet-manager -n opencrane-system

# Monitor progress
kubectl rollout status deployment/opencrane-fleet-manager -n opencrane-system --timeout 5m
```

### OpenClaw Version Update for a Tenant

```bash
# Pin a tenant to a specific OpenClaw version (replace <ct> with the ClusterTenant name)
kubectl patch tenant acme -n opencrane-<ct> \
  --type merge \
  --patch '{"spec":{"openclawVersion":"2026.5.1"}}'

# The operator reconciles on next event or restart the pod to trigger immediately
kubectl delete pod -n opencrane-<ct> -l opencrane.io/tenant=acme
```

---

## 4. Rollback Procedures

### Helm Chart Rollback

```bash
# View fleet release history
helm history opencrane-fleet -n opencrane-system

# Roll back fleet release to the previous revision
helm rollback opencrane-fleet -n opencrane-system --wait

# View a silo release history (replace <ct> with the ClusterTenant name)
helm history opencrane-<ct> -n opencrane-<ct>

# Roll back a silo release to the previous revision
helm rollback opencrane-<ct> -n opencrane-<ct> --wait
```

### Database Migration Rollback

Prisma migrations do not have automatic down-migrations. For critical data rollbacks:

1. **Stop the clustertenant-manager** in the affected silo to prevent write conflicts:
   ```bash
   kubectl scale deployment/opencrane-clustertenant-manager -n opencrane-<ct> --replicas 0
   ```

2. **Restore from backup** (GCP Cloud SQL):
   ```bash
   gcloud sql backups restore <backup-id> \
     --restore-instance=opencrane-db \
     --backup-instance=opencrane-db
   ```

3. **Redeploy the previous version**:
   ```bash
   helm rollback opencrane-<ct> -n opencrane-<ct>
   kubectl scale deployment/opencrane-clustertenant-manager -n opencrane-<ct> --replicas 1
   ```

### Tenant Rollback (OpenClaw Version Pin)

```bash
# If a new OpenClaw version is causing failures, pin to the last known good version
# (replace <ct> with the ClusterTenant name)
kubectl patch tenant acme -n opencrane-<ct> \
  --type merge \
  --patch '{"spec":{"openclawVersion":"2026.4.15"}}'

# Delete the pod to force an immediate restart with the pinned version
kubectl delete pod -n opencrane-<ct> -l opencrane.io/tenant=acme
```

---

## 5. Incident Response

### P0: Fleet-manager is down

**Symptoms**: `GET <fleet-host>/api/v1/healthz` returns non-200; ClusterTenants cannot be created or modified.

**Response**:
1. Check pod status: `kubectl get pods -n opencrane-system`
2. Check logs: `kubectl logs -n opencrane-system deployment/opencrane-fleet-manager --tail 100`
3. Check database connectivity (fleet registry DB)
4. If database is unreachable, verify `fleetManager.database.existingSecret` and network policies
5. Roll back if a recent upgrade is suspected: `helm rollback opencrane-fleet -n opencrane-system`

### P0: Silo clustertenant-manager is down

**Symptoms**: `GET <silo-host>/api/v1/healthz` returns non-200; tenants within a silo cannot be created or modified.

**Response**:
1. Check pod status: `kubectl get pods -n opencrane-<ct>`
2. Check logs: `kubectl logs -n opencrane-<ct> deployment/opencrane-clustertenant-manager --tail 100`
3. Check database connectivity (per-silo DB)
4. Roll back if a recent upgrade is suspected: `helm rollback opencrane-<ct> -n opencrane-<ct>`

### P0: Operator is not reconciling

**Symptoms**: `kubectl get tenants -n opencrane-<ct>` shows tenants stuck in `Pending` or `Error` phase.

**Response**:
1. Check operator logs: `kubectl logs -n opencrane-<ct> deployment/opencrane-clustertenant-operator --tail 100`
2. Verify RBAC: `kubectl auth can-i get tenants.opencrane.io --as system:serviceaccount:opencrane-<ct>:opencrane-clustertenant-operator -n opencrane-<ct>`
3. Check Kubernetes API server reachability from the operator pod
4. Force reconcile by annotating the tenant:
   ```bash
   kubectl annotate tenant acme opencrane.io/reconcile-at=$(date -u +%s) -n opencrane-<ct>
   ```
5. Restart the operator if needed: `kubectl rollout restart deployment/opencrane-clustertenant-operator -n opencrane-<ct>`

### P1: LiteLLM is unreachable

**Symptoms**: Tenant pods in a silo fail to start; `LITELLM_API_KEY` injection is failing. LiteLLM is a per-silo component in `opencrane-<ct>`.

**Response**:
1. Check LiteLLM pod: `kubectl get pods -n opencrane-<ct> -l app=litellm`
2. Check LiteLLM logs: `kubectl logs -n opencrane-<ct> deployment/litellm --tail 50`
3. Verify the master key secret: `kubectl get secret opencrane-litellm -n opencrane-<ct> -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d`
4. Check database connectivity from LiteLLM
5. If LiteLLM is permanently unavailable, disable it for recovery on the affected silo:
   ```bash
   helm upgrade opencrane-<ct> apps/clustertenant-platform/ \
     --namespace opencrane-<ct> \
     --reuse-values \
     --set litellm.enabled=false \
     --wait
   ```

### P2: Projection drift alert firing

**Symptoms**: `GET /api/metrics/projection-drift` returns `alert.state: "alert"` or webhook fires.

**Response**:
1. Identify which resources are drifted: `curl .../api/metrics/projection-drift | jq .resources`
2. Run a dry-run repair to see what would change:
   ```bash
   curl -X POST .../api/tenants/repair
   curl -X POST .../api/policies/repair
   ```
3. If the dry-run output is expected, apply the repair:
   ```bash
   curl -X POST ".../api/tenants/repair?dryRun=false"
   curl -X POST ".../api/policies/repair?dryRun=false"
   ```
4. If drift persists, check for split-brain between operator and control-plane write paths

### P2: Budget overage (tenant exceeds 100% of monthly budget)

**Symptoms**: Tenant receives 429 responses from LiteLLM; spend endpoint shows `exceeded: true`.

**Response**:
1. Review spend: `curl .../api/ai-budget/:tenantName/spend`
2. Discuss with tenant owner whether to increase budget or wait for reset
3. Increase the budget by patching the Tenant CRD and revoking/regenerating the key:
   ```bash
   # replace <ct> with the ClusterTenant name
   kubectl patch tenant acme -n opencrane-<ct> \
     --type merge \
     --patch '{"spec":{"monthlyBudgetUsd":500}}'
   
   # Revoke the old key (operator will generate a new one on next reconcile)
   curl -X POST .../api/ai-budget/acme/litellm-key/revoke
   ```

---

## 6. Projection Drift Remediation

Projection drift occurs when the PostgreSQL projection rows diverge from the Kubernetes CRD source of truth.

### Detect drift

Drift is detected and repaired per silo. Replace `<silo-host>` with the URL of the affected silo's clustertenant-manager.

```bash
# Full drift report with lag metrics
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/metrics/projection-drift | jq .

# Tenant-specific drift report
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/tenants/drift | jq .

# Policy-specific drift report
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/policies/drift | jq .
```

### Repair drift

```bash
# Dry-run repair (shows what would change, does not write)
curl -X POST -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/tenants/repair | jq .

# Apply repair (write changes to PostgreSQL)
curl -X POST -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  "https://<silo-host>/api/v1/tenants/repair?dryRun=false" | jq .

# Repair AccessPolicy projections
curl -X POST -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  "https://<silo-host>/api/v1/policies/repair?dryRun=false" | jq .
```

---

## 7. LiteLLM Key Lifecycle

LiteLLM keys are managed per silo. Replace `<silo-host>` with the clustertenant-manager URL of the relevant silo, and `<ct>` with the ClusterTenant name.

### View active key for a tenant

```bash
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/ai-budget/acme/litellm-key | jq .
```

### Revoke and regenerate a key

```bash
# Revoke the current key
curl -X POST -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/ai-budget/acme/litellm-key/revoke

# The operator will generate a new key on the next reconcile cycle.
# Force reconcile by deleting the tenant pod:
kubectl delete pod -n opencrane-<ct> -l opencrane.io/tenant=acme
```

### View tenant spend

```bash
curl -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/ai-budget/acme/spend | jq .
```

---

## 8. Tenant Lifecycle Operations

Tenant lifecycle operations target a **silo's clustertenant-manager**. Replace `<silo-host>` with the URL of the target silo and `<ct>` with the ClusterTenant name.

### Create a tenant

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  -H "Content-Type: application/json" \
  https://<silo-host>/api/v1/tenants \
  -d '{
    "name": "acme",
    "displayName": "ACME Corp",
    "email": "owner@acme.com",
    "team": "engineering",
    "monthlyBudgetUsd": 200
  }'
```

### Suspend a tenant

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/tenants/acme/suspend
```

### Resume a tenant

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/tenants/acme/resume
```

### Delete a tenant

```bash
curl -X DELETE \
  -H "Authorization: Bearer $OPENCRANE_TOKEN" \
  https://<silo-host>/api/v1/tenants/acme
```

> **Note**: Deletion removes the Kubernetes deployment and service but retains the tenant's encryption key Secret for data recovery.

### Apply a skill allowlist to a tenant

```bash
kubectl patch tenant acme -n opencrane-<ct> \
  --type merge \
  --patch '{"spec":{"skillAllowlist":["company-policy","engineering-tools"]}}'
```

### Apply MCP server restrictions to a tenant

```bash
kubectl patch tenant acme -n opencrane-<ct> \
  --type merge \
  --patch '{"spec":{"mcpPolicy":{"deny":["external-search"],"allow":["skills","retrieval"]}}}'
```

---

## 9. Observability Reference

### Key metrics endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Overall health check (DB connectivity) |
| `GET /api/metrics/server` | CPU, memory, storage, active tenant count |
| `GET /api/metrics/projection-drift` | CRD vs PostgreSQL mismatch counts and lag |
| `GET /api/tenants/:name/datasets` | Tenant dataset membership projection |
| `GET /api/ai-budget/:tenant/spend` | LiteLLM spend vs budget for a tenant |
| `GET http://harvesting-agent:9090/metrics` | Ingest lag, success rates by source |
| `GET http://harvesting-agent:9090/healthz` | Harvesting agent liveness |

### Structured log fields (pino)

All components emit structured JSON logs with these standard fields:

| Field | Description |
|-------|-------------|
| `name` | Service name (e.g. `ctrl`, `operator`, `harvesting-agent`) |
| `component` | Sub-component name |
| `level` | Log level (10=trace, 20=debug, 30=info, 40=warn, 50=error) |
| `name` | Tenant name when relevant |
| `err` | Serialized error object on failures |

### Alerting integration

Set `OPENCRANE_DRIFT_WEBHOOK_URL` to a Slack incoming webhook or PagerDuty events URL. The drift alert fires a `POST` with this payload:

```json
{
  "event": "opencrane.projection_drift.alert",
  "severity": "warning",
  "message": "Projection drift threshold exceeded: 5 mismatches detected",
  "payload": { "...": "full drift metrics snapshot" }
}
```

---

*Last updated: 2026-05-28 — document this runbook in the same commit as any procedure change.*
