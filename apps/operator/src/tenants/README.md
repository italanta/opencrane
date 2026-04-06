# tenants

Watches Tenant custom resources and reconciles the corresponding Kubernetes workloads.

## Public API

| Export | Description |
|--------|-------------|
| `TenantOperator` | The reconcile loop class. |
| `_CreateTenantOperator(kc, config, log)` | Factory — wires all K8s clients and helpers from a KubeConfig. Use this in entry-points; inject helpers directly in tests. |
| `IdleChecker` | Periodic checker that auto-suspends tenants idle beyond the configured timeout. |

## Layout

```
tenants/
  operator.ts      — TenantOperator class + _CreateTenantOperator factory
  index.ts         — public barrel (re-exports the three symbols above)
  README.md        — this file
  internal/        — implementation details, not part of the public API
    idle-checker.ts
    idle-policy.ts
    tenant-cleanup.ts
    tenant-domains.ts
    tenant-encryption-keys.ts
    tenant-litellm-keys.ts
    tenant-resource-builder.ts
    tenant-status-writer.ts
    types.ts
```

Files under `internal/` are not exported from `index.ts`. Tests import them directly.
