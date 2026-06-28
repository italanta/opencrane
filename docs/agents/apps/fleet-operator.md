# App: fleet-operator (`@opencrane/fleet-operator`)

> Deep-dive for `apps/fleet-operator`. Index: [`../app-specific.md`](../app-specific.md). Cluster context:
> [`../cluster-architecture.md`](../cluster-architecture.md). Verified June 2026.

The Kubernetes operator: a set of resilient watch loops that reconcile OpenCrane CRs into running
workloads. Pure `@kubernetes/client-node` + a custom watch runner — no controller-runtime framework.

**Two distinct roles** (terminology per
[`cluster-architecture.md` → Tenancy Model](../cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant)):

1. **Builds UserTenant workloads** — per `Tenant` CR (the **UserTenant**, a per-user OpenClaw agent gateway)
   it creates the Deployment / Service / Ingress (+ ConfigMap, Secrets, SA). One UserTenant Ingress lands
   at `<name>.<ingress.domain>` under the parent ClusterTenant's wildcard.
2. **Enforces ClusterTenant isolation** — for the parent **ClusterTenant** (the customer/isolation unit)
   it provisions/uses the bound namespace and stamps the PSA `restricted` label, `ResourceQuota`,
   `LimitRange`, and dedicated-node scheduling.

## Boot & Controllers (`src/index.ts`)

`main()` loads config, builds the K8s client + hosting adapter, and starts independent loops; SIGTERM/SIGINT shut them down. Loops:

| Controller | Watches / cadence | Does |
|------------|-------------------|------|
| **TenantOperator** (`tenants/operator.ts`) | `Tenant` (UserTenant) CRs (`WATCH_NAMESPACE` or all) | The main reconcile pipeline (below). |
| **PolicyOperator** (`policies/operator.ts`) | AccessPolicy CRs | Builds NetworkPolicy (+ optional CiliumNetworkPolicy) from egress/domain rules. |
| **IdleChecker** (`tenants/runtime/idle-checker.ts`) | interval | Auto-suspends UserTenants idle past `IDLE_TIMEOUT_MINUTES` (sets `spec.suspended=true`). Disabled when ≤0. |
| **ObotHealthChecker** (`mcp-gateway/obot-health-checker.ts`) | ~30s | Polls Obot `/healthz`; tracks consecutive failures; non-blocking. |
| **RuntimePlaneDriftRepairer** (`runtime-planes/drift-repairer.ts`) | ~60s | Repairs env-var drift on the Obot + skill-registry Deployments (image/replicas left to Helm). |
| **TenantUpdateWithCanaryStrategyController** (`tenant-rollout/`) | ~15min, opt-in | When `OPENCRANE_AUTO_UPDATE_ENABLED`, canary-rolls new tenant images from the npm registry. |

## Reconcile Pipeline (`tenants/operator.ts`, idempotent)

Runs once per `Tenant` CR (a **UserTenant**). Each step uses server-side apply
(`fieldManager: openclane-operator`) so re-runs are safe:

1. **Resolve parent ClusterTenant** — ref-less → install namespace; with `clusterTenantRef` → parent's `status.boundNamespace` (fails if unbound).
2. **Enforce isolation** (only with a ref) — Namespace (PSA restricted) → ResourceQuota → LimitRange.
3. **Resolve effective AccessPolicy** — precedence `policyRef` > unique selector match > `DEFAULT_TENANT_POLICY_REF` > none; `>1` selector match = `PolicyConflict` → Error.
4. **ServiceAccount** `openclaw-{name}` — identity annotations from the hosting adapter (Workload Identity on GKE, empty on-prem).
5. **External storage** — GCP: idempotent GCS bucket; on-prem: no-op.
6. **Encryption-key Secret** — AES-256, generated once, never rotated.
7. **LiteLLM virtual-key Secret** — best-effort; backend failures log but don't block.
8. **ConfigMap** — base OpenClaw config + `spec.configOverrides` + the managed-runtime contract (plane URLs, capabilities) + workspace templates.
9. **State volume** — GCS Fuse CSI mount (GCP) or PVC (on-prem) — adapter decides.
10. **Deployment + Service + Ingress** — single replica, hardened pod (runAsNonRoot, drop ALL caps, readOnlyRootFilesystem, seccomp), 3 projected audience-bound tokens, liveness on the gateway port; the UserTenant Ingress host is `{name}.{INGRESS_DOMAIN}` (a host under the parent ClusterTenant's base domain) with optional shared wildcard TLS.
11. **Patch `status`** — phase `Running`, pod name, ingress host, policy resolution source/state, `lastReconciled`.

Step 1 (resolve parent ClusterTenant) and step 2 (enforce isolation) are where the operator acts on the
**ClusterTenant** customer boundary; steps 4–11 build the **UserTenant** workload itself.

**Delete** removes child resources but **retains buckets + encryption key** (data-loss prevention). **Suspend** scales to 0 and keeps state. Errors set `phase: Error` + message and re-throw to the watch loop.

## Hosting Adapter (`src/hosting/`)

A `HostingAdapter` interface (`provisionTenantStorage`, `buildServiceAccountIdentity`, `buildStateVolume`, `buildIngressBinding`, …) selected by `HOSTING_PROVIDER`. **OnPrem** (default): no-op storage, empty identity, PVC volume, `nginx` ingress class. **Gcp**: GCS bucket `{prefix}-{name}`, Workload Identity annotation, GCS Fuse CSI volume, `gce` ingress class. Azure/AWS are stubs. This is the single seam for cloud-specific behaviour — keep provider logic out of the reconcile pipeline.

## Watch Runner (`shared/watch-runner.ts`)

Generic loop with 5s reconnect backoff. The K8s API closes watch streams every ~5–10 min; reconnect is normal. Per-event handler errors are caught and logged, never crashing the loop.

## Key Env (`src/config.ts`)

`WATCH_NAMESPACE`, `REQUIRE_WATCH_NAMESPACE` (fail-closed guard), `TENANT_DEFAULT_IMAGE`, `INGRESS_DOMAIN`, `GATEWAY_PORT`, `IDLE_TIMEOUT_MINUTES`, `LITELLM_ENABLED`/`_ENDPOINT`/`_MASTER_KEY`, `DEFAULT_TENANT_POLICY_REF`, `PROJECTED_TOKEN_TTL_SECONDS`, `HOSTING_PROVIDER` (+ `GCP_*`), `MCP_GATEWAY_URL`/`SKILL_REGISTRY_URL`/`CONTROL_PLANE_INTERNAL_URL` (Helm injects release-prefixed values — the in-code defaults are dev fallbacks only).

## Aspirational / stubs

Azure & AWS adapters are stubs. MCP allow/deny lists and skill allowlists in the specs are advisory (the gateway/registry planes enforce, not the operator). Encryption-key rotation is deliberately deferred.
