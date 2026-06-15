# Kubernetes & Cluster Security

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.
>
> These are the operational Kubernetes rules that implement the identity philosophy in
> [`architecture.md`](./architecture.md). Helm/Terraform ownership of these resources is described
> in [`infra.md`](./infra.md).

> **Full cluster topology** — physical cluster, Helm template inventory, plane wiring, namespace
> model, network topology, isolation tiers, and multi-instance shape — is in
> [`cluster-architecture.md`](./cluster-architecture.md). This file covers the coding rules and the
> operator's runtime behaviour.

## Cluster Architecture Context

How the operator actually shapes the cluster (verified June 2026):

- **Six CRDs** in `platform/helm/crds/`: `Tenant`, `ClusterTenant` (cluster-scoped), `AccessPolicy`, `MCPServer`, `SkillRegistry`, `Schedule`. CRDs use `spec`/`status` subresources — spec is user-owned, status is operator-owned (patched via `*StatusWriter` / `patchNamespacedCustomObjectStatus`).
- **Operator reconcile is an idempotent ~10-step sequence per Tenant** (`apps/operator/src/tenants/operator.ts`): resolve parent ClusterTenant → enforce isolation (PSA labels + ResourceQuota + LimitRange) → resolve effective AccessPolicy (precedence: explicit `policyRef` > selector > default > none) → ServiceAccount (+ Workload Identity annotation on GKE) → external storage → per-tenant AES-256 key Secret → LiteLLM virtual key (best-effort) → ConfigMap → state volume → single-replica Deployment + Service + Ingress → patch status. **All applies are server-side (fieldManager `openclane-operator`)** so re-runs are safe.
- **Watch loop auto-reconnects** with 5s backoff (`shared/watch-runner.ts`); the K8s API closes streams every ~5–10 min — treat reconnects as normal, never as an error path.
- **Namespace isolation is enforced per-ClusterTenant**: PSA *restricted* profile labels, a `ResourceQuota` (cpu/mem/pods/storage/gpu), and a `LimitRange` (per-container defaults — required because the quota constrains `requests.*`). Pod placement: `nodeSelector` + `tolerations` are stamped only when the parent's `compute.mode = dedicated`; shared mode is left unconstrained (byte-for-byte baseline preserved).
- **Delete is non-destructive for data**: removing a Tenant deletes Deployment/ConfigMap/Service/Ingress/PVC but **retains GCS buckets and the encryption-key Secret**. Suspend (`spec.suspended=true`) scales to 0 replicas and keeps all state.
- **`PolicyOperator`** builds a standard `NetworkPolicy` (CIDR + port egress, DNS always allowed first) from each AccessPolicy, plus an optional `CiliumNetworkPolicy` for FQDN/domain filtering — Cilium apply failures are logged and skipped gracefully (standard NetworkPolicy still applies).

## Defaults

- New services should get a dedicated Kubernetes service account.
- New services should get a dedicated cloud service account when they need cloud API access.
- Disable service account token automount unless Kubernetes API access is explicitly required.
- Scope IAM and RBAC to the smallest role that satisfies the workload.
- Prefer machine-to-machine identity over shared secrets.

## Internal Routes Without Auth Middleware

When a route is intentionally excluded from `___AuthMiddleware` and relies on Kubernetes NetworkPolicy for access control instead, the router function must:

1. State this explicitly in its JSDoc with a bolded note.
2. Include a `@see` tag pointing to the Helm NetworkPolicy template that enforces the restriction.
3. Include a second `@see` pointing to the deployment template that wires the caller.

```typescript
/**
 * Internal router for widget delivery.
 *
 * **This router is NOT behind `___AuthMiddleware`.**
 * Access is enforced by Kubernetes NetworkPolicy.
 *
 * @see platform/helm/templates/networkpolicy-planes.yaml — policy restricting
 *   which pods can reach the control-plane service.
 * @see platform/helm/templates/widget-consumer-deployment.yaml — deployment
 *   that sets WIDGET_URL to this endpoint.
 */
export function _RegisterInternalWidgets(prisma: PrismaClient): Router { ... }
```

> Network reachability does not imply authorization — see
> [OpenCrane-Specific Direction](./architecture.md#opencrane-specific-direction).

The plane-to-plane boundary is `platform/helm/templates/networkpolicy-planes.yaml`: control-plane ingress is allowed only from ingress-nginx, the operator, Obot gateway, skill-registry, and tenant pods (for contract re-pull); the OCI store accepts the control-plane only. Because `/api/internal/*` has no auth middleware, this NetworkPolicy is the **only** boundary protecting it — path-based filtering is impossible, so never widen these selectors casually.

## Workload Identity & Projected Tokens

- **Cloud identity (GKE):** the operator stamps the KSA annotation `iam.gke.io/gcp-service-account: openclaw-{tenant}@{project}.iam.gserviceaccount.com` (`apps/operator/src/hosting/adapters/gcp/`). The GSA↔KSA IAM binding is set up outside the operator (Terraform). On-prem the annotation is empty and storage provisioning is a no-op.
- **In-cluster identity:** tenant pods mount up to three audience-bound projected SA tokens read-only under `/var/run/opencrane/tokens/` — `obot-gateway.token`, `skill-registry.token`, `control-plane.token`. TTL is `projectedTokenTtlSeconds` (env-driven); kubelet rotates them with no pod restart. These are real and actively consumed, not aspirational.
- **`WATCH_NAMESPACE` fail-closed:** with `multiInstance.requireWatchNamespace=true` the operator refuses to start if `WATCH_NAMESPACE` is unset — prevents one instance from reconciling another's tenants. Empty means watch-all (legacy single-install only).
