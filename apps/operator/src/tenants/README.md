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
  deploy/          — functional resource builders
    1-service-account.ts
    2-config-map.ts
    3-deployment.ts
    4-service.ts
    5-ingress.ts
    ingress-host.ts
    tenant-labels.ts
    readme.md
  models/          — tenant interfaces
    tenant.interface.ts
    tenant-spec.interface.ts
    tenant-status.interface.ts
  runtime/         — runtime evaluators and long-running loops
    idle-checker.ts
    idle-policy.ts
  destroy/         — tenant resource deletion helpers
    tenant-cleanup.ts
  internal/        — implementation details, not part of the public API
    tenant-encryption-keys.ts
    tenant-litellm-keys.ts
    tenant-status-writer.ts
```

Files under `internal/` are not exported from `index.ts`. Tests import them directly.
