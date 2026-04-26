# Deploy Build Pipeline

This folder contains the functional deployment builders used by the tenant reconcile loop.
Each numbered file maps to the exact apply order in `TenantOperator.reconcileTenant`.

## Build Process

1. `_BuildServiceAccount` in `1-service-account.ts`
Reason: the Deployment references this ServiceAccount; it must exist before pod scheduling.

2. `_BuildConfigMap` in `2-config-map.ts`
Reason: the Deployment mounts this config file at startup.

3. `_BuildStatePvc` in `3-state-pvc.ts`
Reason: local-storage mode needs a per-tenant PVC before pod scheduling.

4. `_BuildDeployment` in `3-deployment.ts`
Reason: starts the tenant workload after identity, secrets, and config primitives are ready.

5. `_BuildService` in `4-service.ts`
Reason: exposes the running pod set on the gateway port.

6. `_BuildIngress` in `5-ingress.ts`
Reason: routes external host traffic to the Service once backend networking exists.

## Shared Helpers

- `tenant-labels.ts`: `_BuildTenantLabels` used by all builders for consistent metadata.
- `ingress-host.ts`: `_BuildIngressHost` used by Ingress generation and status reporting.
- `index.ts`: stable export surface for all deploy functions.

## Notes

- These functions are pure builders: they only return Kubernetes objects.
- Actual server-side apply is done by the operator using `applyResource(...)`.
- BucketClaim creation is handled separately in storage provider code and is not part of this folder.
