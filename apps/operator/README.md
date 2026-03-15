# @opencrane/operator

Kubernetes operator that reconciles `Tenant` and `AccessPolicy` custom resources into real cluster workloads. It watches CRD events and drives every per-tenant pod to the desired state declared in the CR.

## Responsibilities

| Domain | What it does |
|--------|-------------|
| **Tenants** | Watches `Tenant` CRs; creates/updates ServiceAccount, BucketClaim, encryption-key Secret, ConfigMap, Deployment, Service, Ingress per tenant |
| **Policies** | Watches `AccessPolicy` CRs; reconciles them into `NetworkPolicy` and (optionally) `CiliumNetworkPolicy` |
| **Storage** | Provisions per-tenant GCS buckets via Crossplane `BucketClaim`; falls back to PVC in non-cloud environments |
| **Infra** | Generic Kubernetes `apply`/`delete` helpers used by all reconcilers |

## Source layout

```
src/
├── index.ts                  # Entry point: bootstrap + signal handlers
├── config.ts                 # OperatorConfig interface + loadOperatorConfig()
├── infra/
│   └── k8s.ts                # applyResource, deleteResource (server-side apply)
├── storage/
│   ├── provider.ts           # StorageProvider interface + buildBucketClaim
│   └── provider.test.ts
├── tenants/
│   ├── types.ts              # TenantSpec, TenantStatus, Tenant
│   ├── operator.ts           # TenantOperator class
│   └── operator.test.ts
├── policies/
│   ├── types.ts              # AccessPolicySpec, AccessPolicy
│   └── operator.ts           # PolicyOperator class
└── __tests__/
    └── fixtures.ts           # Shared test helpers: defaultConfig, _makeTenant()
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
