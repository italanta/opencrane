# @opencrane/operator

Kubernetes operator that watches `Tenant` and `AccessPolicy` custom resources and creates the Kubernetes objects needed to match them.

## Responsibilities

| Domain | What it does |
|--------|-------------|
| **Tenants** | Creates/updates each tenant's ServiceAccount, BucketClaim, encryption key Secret, ConfigMap, Deployment, Service, and Ingress |
| **Policies** | Watches `AccessPolicy` CRs from the cluster API and converts them into `NetworkPolicy` and optional `CiliumNetworkPolicy` resources |
| **Storage** | Creates per-tenant cloud buckets through Crossplane `BucketClaim`; falls back to PVC in local/non-cloud setups |
| **Infra** | Shared watch/retry and Kubernetes apply/delete helpers used by reconcilers |

## Where policies come from

`AccessPolicy` resources are written to Kubernetes first, then this operator reacts to those CR events.

Common sources are:

1. Control-plane API route: `POST /api/policies`, `PUT /api/policies/:name`, `DELETE /api/policies/:name`
2. Direct Kubernetes apply: `kubectl apply -f access-policy.yaml`

The operator does not create policy intent itself. It only watches `opencrane.io/v1alpha1` `accesspolicies` and reconciles the matching network resources.

## Source layout

```
src/
├── index.ts                         # Entry point: bootstrap + signal handlers
├── config.ts                        # OperatorConfig interface + loadOperatorConfig()
├── shared/
│   └── watch-runner.ts              # Reusable watch loop with reconnect/backoff
├── infra/
│   └── k8s.ts                       # applyResource, deleteResource (server-side apply)
├── storage/
│   ├── provider.ts                  # StorageProvider interface + buildBucketClaim
│   └── provider.test.ts
├── tenants/
│   ├── types.ts                     # TenantSpec, TenantStatus, Tenant
│   ├── tenant-domains.ts            # Tenant hostname/domain conventions
│   ├── tenant-resource-builder.ts   # Pure builders for tenant K8s resources
│   ├── tenant-status-writer.ts      # Tenant status patch helper
│   ├── tenant-cleanup.ts            # Tenant resource deletion helper
│   ├── idle-checker.ts              # Idle auto-suspend loop
│   ├── idle-policy.ts               # Pure idle decision helpers
│   ├── operator.ts                  # Tenant watch orchestration + reconcile flow
│   └── operator.test.ts
├── policies/
│   ├── types.ts                     # AccessPolicySpec, AccessPolicy
│   ├── policy-resource-builder.ts   # Pure builders for policy resources
│   └── operator.ts                  # Policy watch orchestration + reconcile flow
└── __tests__/
  └── fixtures.ts                  # Shared test helpers: defaultConfig, _makeTenant()
```

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCH_NAMESPACE` | `""` (all) | Namespace to scope the watch to |
| `TENANT_DEFAULT_IMAGE` | `ghcr.io/opencrane/tenant:latest` | Fallback container image for tenant pods |
| `INGRESS_DOMAIN` | `opencrane.local` | Base domain for `{tenant}.{domain}` ingress hosts |
| `INGRESS_CLASS_NAME` | `nginx` | Kubernetes ingress class name |
| `SHARED_SKILLS_PVC_NAME` | `opencrane-shared-skills` | PVC mounted read-only into every tenant pod |
| `GATEWAY_PORT` | `18789` | OpenClaw gateway port inside tenant pods |
| `STORAGE_PROVIDER` | `""` | Cloud storage: `gcs`, `azure-blob`, `s3`, or empty for PVC fallback |
| `BUCKET_PREFIX` | `opencrane` | Prefix for bucket names (`{prefix}-{tenantName}`) |
| `GCP_PROJECT` | `""` | GCP project ID for Workload Identity annotations |
| `CSI_DRIVER` | `""` | CSI driver for mounting cloud storage (e.g. `gcsfuse.csi.storage.gke.io`) |
| `CROSSPLANE_ENABLED` | `false` | Set `"true"` to create Crossplane BucketClaims |

## Tenant lifecycle

```
Tenant CR created/updated
  └── suspended: false  →  reconcileTenant()
  │     1. ServiceAccount (+ Workload Identity annotation if GCS)
  │     2. BucketClaim   (if Crossplane + storage provider configured)
  │     3. Encryption key Secret (created once, never rotated automatically)
  │     4. ConfigMap     (merged base config + spec.configOverrides)
  │     5. Deployment    (1 replica, GCS Fuse CSI or PVC storage)
  │     6. Service       (ClusterIP on gatewayPort)
  │     7. Ingress       ({name}.{domain})
  │     8. Status → Running
  │
  └── suspended: true   →  suspendTenant()
        Deployment replicas → 0, Status → Suspended

Tenant CR deleted
  └── cleanupTenant()
        Removes: Ingress, Service, Deployment, ConfigMap, ServiceAccount
        Retains: BucketClaim (data), encryption key Secret (recovery)
```

## Development

```bash
# From repo root
pnpm build          # compile TypeScript
pnpm test           # run vitest
```

## Docker

Built from `deploy/Dockerfile` using the repo root as build context:

```bash
docker build -f apps/operator/deploy/Dockerfile -t ghcr.io/opencrane/operator:latest .
```
