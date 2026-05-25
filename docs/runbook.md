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
./platform/tests/k3d-local.sh

# 3. Verify all pods are running
kubectl get pods -n opencrane

# 4. Run smoke tests
./platform/tests/k3d-e2e.sh
```

### GCP Production Installation

```bash
# 1. Authenticate with Google Cloud
gcloud auth application-default login

# 2. Set project and region
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_REGION=us-central1

# 3. Apply Terraform infrastructure
cd platform/terraform
terraform init
terraform apply -var-file environments/prod/terraform.tfvars

# 4. Get cluster credentials
gcloud container clusters get-credentials opencrane-prod --region $GOOGLE_CLOUD_REGION

# 5. Install OpenCrane Helm chart
helm upgrade --install opencrane platform/helm/ \
  --namespace opencrane --create-namespace \
  --values platform/helm/values-gcp.yaml \
  --set litellm.existingSecret=opencrane-litellm \
  --wait --timeout 10m

# 6. Run Prisma migrations
kubectl exec -n opencrane deployment/control-plane -- \
  npx prisma migrate deploy
```

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `LITELLM_MASTER_KEY` | Yes (if LiteLLM enabled) | LiteLLM master API key |
| `LITELLM_ENDPOINT` | Yes (if LiteLLM enabled) | LiteLLM service URL (default: `http://litellm:4000`) |
| `OPENCRANE_API_TOKEN` | Yes | Bearer token for control-plane API auth |
| `NAMESPACE` | No | Kubernetes namespace (default: `default`) |
| `OPENCRANE_PROJECTION_DRIFT_ALERT_THRESHOLD` | No | Drift count before alert fires (0 = disabled) |
| `OPENCRANE_DRIFT_WEBHOOK_URL` | No | Webhook URL for projection-drift alert delivery |

---

## 2. Verification

### Health Checks

```bash
# Control-plane health
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/healthz

# Expected response: {"status":"ok","db":true}

# LiteLLM health
curl http://litellm.opencrane.svc.cluster.local:4000/health

# Operator logs
kubectl logs -n opencrane deployment/operator --tail 50

# List all tenants and their phases
kubectl get tenants -n opencrane

# Check a specific tenant
kubectl describe tenant acme -n opencrane
```

### Smoke Test Suite

```bash
# Run the full k3d e2e smoke test
./platform/tests/k3d-e2e.sh

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

### Control-plane Upgrade (Helm)

```bash
# 1. Pull the latest chart updates
git pull origin main

# 2. Review changes
helm diff upgrade opencrane platform/helm/ \
  --namespace opencrane \
  --values platform/helm/values-gcp.yaml

# 3. Apply the upgrade
helm upgrade opencrane platform/helm/ \
  --namespace opencrane \
  --values platform/helm/values-gcp.yaml \
  --wait --timeout 10m

# 4. Run database migrations if needed
kubectl exec -n opencrane deployment/control-plane -- \
  npx prisma migrate deploy

# 5. Verify rollout
kubectl rollout status deployment/control-plane -n opencrane
kubectl rollout status deployment/operator -n opencrane
```

### Operator Rolling Restart

```bash
# Force a rolling restart of the operator (picks up config changes)
kubectl rollout restart deployment/operator -n opencrane

# Monitor progress
kubectl rollout status deployment/operator -n opencrane --timeout 5m
```

### OpenClaw Version Update for a Tenant

```bash
# Pin a tenant to a specific OpenClaw version
kubectl patch tenant acme -n opencrane \
  --type merge \
  --patch '{"spec":{"openclawVersion":"2026.5.1"}}'

# The operator reconciles on next event or restart the pod to trigger immediately
kubectl delete pod -n opencrane -l opencrane.io/tenant=acme
```

---

## 4. Rollback Procedures

### Helm Chart Rollback

```bash
# View Helm release history
helm history opencrane -n opencrane

# Roll back to the previous release
helm rollback opencrane -n opencrane --wait

# Roll back to a specific revision
helm rollback opencrane 3 -n opencrane --wait
```

### Database Migration Rollback

Prisma migrations do not have automatic down-migrations. For critical data rollbacks:

1. **Stop the control-plane** to prevent write conflicts:
   ```bash
   kubectl scale deployment/control-plane -n opencrane --replicas 0
   ```

2. **Restore from backup** (GCP Cloud SQL):
   ```bash
   gcloud sql backups restore <backup-id> \
     --restore-instance=opencrane-db \
     --backup-instance=opencrane-db
   ```

3. **Redeploy the previous control-plane version**:
   ```bash
   helm rollback opencrane -n opencrane
   kubectl scale deployment/control-plane -n opencrane --replicas 1
   ```

### Tenant Rollback (OpenClaw Version Pin)

```bash
# If a new OpenClaw version is causing failures, pin to the last known good version
kubectl patch tenant acme -n opencrane \
  --type merge \
  --patch '{"spec":{"openclawVersion":"2026.4.15"}}'

# Delete the pod to force an immediate restart with the pinned version
kubectl delete pod -n opencrane -l opencrane.io/tenant=acme
```

---

## 5. Incident Response

### P0: Control-plane is down

**Symptoms**: `GET /healthz` returns non-200; tenants cannot be created or modified.

**Response**:
1. Check pod status: `kubectl get pods -n opencrane`
2. Check logs: `kubectl logs -n opencrane deployment/control-plane --tail 100`
3. Check database connectivity: `kubectl exec -n opencrane deployment/control-plane -- npx prisma db pull`
4. If database is unreachable, verify `DATABASE_URL` secret and network policies
5. Roll back if a recent upgrade is suspected: `helm rollback opencrane -n opencrane`

### P0: Operator is not reconciling

**Symptoms**: `kubectl get tenants` shows tenants stuck in `Pending` or `Error` phase.

**Response**:
1. Check operator logs: `kubectl logs -n opencrane deployment/operator --tail 100`
2. Verify RBAC: `kubectl auth can-i get tenants.opencrane.io --as system:serviceaccount:opencrane:operator`
3. Check Kubernetes API server reachability from the operator pod
4. Force reconcile by annotating the tenant:
   ```bash
   kubectl annotate tenant acme opencrane.io/reconcile-at=$(date -u +%s) -n opencrane
   ```
5. Restart the operator if needed: `kubectl rollout restart deployment/operator -n opencrane`

### P1: LiteLLM is unreachable

**Symptoms**: Tenant pods fail to start; `LITELLM_API_KEY` injection is failing.

**Response**:
1. Check LiteLLM pod: `kubectl get pods -n opencrane -l app=litellm`
2. Check LiteLLM logs: `kubectl logs -n opencrane deployment/litellm --tail 50`
3. Verify the master key secret: `kubectl get secret opencrane-litellm -n opencrane -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d`
4. Check database connectivity from LiteLLM
5. If LiteLLM is permanently unavailable, disable it for recovery:
   ```bash
   helm upgrade opencrane platform/helm/ \
     --namespace opencrane \
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
   kubectl patch tenant acme -n opencrane \
     --type merge \
     --patch '{"spec":{"monthlyBudgetUsd":500}}'
   
   # Revoke the old key (operator will generate a new one on next reconcile)
   curl -X POST .../api/ai-budget/acme/litellm-key/revoke
   ```

---

## 6. Projection Drift Remediation

Projection drift occurs when the PostgreSQL projection rows diverge from the Kubernetes CRD source of truth.

### Detect drift

```bash
# Full drift report with lag metrics
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/metrics/projection-drift | jq .

# Tenant-specific drift report
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/tenants/drift | jq .

# Policy-specific drift report
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/policies/drift | jq .
```

### Repair drift

```bash
# Dry-run repair (shows what would change, does not write)
curl -X POST -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/tenants/repair | jq .

# Apply repair (write changes to PostgreSQL)
curl -X POST -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  "https://control.opencrane.io/api/tenants/repair?dryRun=false" | jq .

# Repair AccessPolicy projections
curl -X POST -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  "https://control.opencrane.io/api/policies/repair?dryRun=false" | jq .
```

---

## 7. LiteLLM Key Lifecycle

### View active key for a tenant

```bash
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/ai-budget/acme/litellm-key | jq .
```

### Revoke and regenerate a key

```bash
# Revoke the current key
curl -X POST -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/ai-budget/acme/litellm-key/revoke

# The operator will generate a new key on the next reconcile cycle.
# Force reconcile by deleting the tenant pod:
kubectl delete pod -n opencrane -l opencrane.io/tenant=acme
```

### View tenant spend

```bash
curl -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/ai-budget/acme/spend | jq .
```

---

## 8. Tenant Lifecycle Operations

### Create a tenant

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  -H "Content-Type: application/json" \
  https://control.opencrane.io/api/tenants \
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
  -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/tenants/acme/suspend
```

### Resume a tenant

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/tenants/acme/resume
```

### Delete a tenant

```bash
curl -X DELETE \
  -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  https://control.opencrane.io/api/tenants/acme
```

> **Note**: Deletion removes the Kubernetes deployment and service but retains the tenant's GCS bucket and encryption key Secret for data recovery.

### Apply a skill allowlist to a tenant

```bash
kubectl patch tenant acme -n opencrane \
  --type merge \
  --patch '{"spec":{"skillAllowlist":["company-policy","engineering-tools"]}}'
```

### Apply MCP server restrictions to a tenant

```bash
kubectl patch tenant acme -n opencrane \
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
