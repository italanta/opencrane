# Hosting Architecture — On-Prem Core with Cloud Adapters

> **Status:** implemented (Phase 5). The `HostingAdapter` seam, `OnPremHostingAdapter`
> (default) + `GcpHostingAdapter`, the Terraform `core/` + `cloud/gcp/` split, and the
> Crossplane removal are all live. The scattered `storageProvider` / `crossplaneEnabled`
> branching this superseded is gone. §9 records the (completed) migration sequence; the
> Azure/AWS adapters remain agreed extension points, not yet built. TLS issuance for the
> per-UserTenant ingress is being wired via cert-manager (§6.3, plan CONN.8).
>
> **Tenancy terms:** "tenant" below means a **UserTenant** — the per-user OpenClaw gateway
> (the openclaw / `Tenant` CRD), exposed at `<user>.<ClusterTenant-domain>`. The
> **ClusterTenant** is the customer that owns the base domain. See the authoritative
> [Tenancy Model](agents/cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant).

## 1. Goals & Principles

OpenCrane must run on **vanilla Kubernetes (on-prem / self-hosted) by default**, with cloud providers as **opt-in overrides** that never leak into the core path.

1. **On-prem is the default and the baseline.** A clean Kubernetes cluster (k3d, kubeadm, RKE2, on-prem) runs the full platform with **zero cloud configuration** — PVC storage, plain ServiceAccounts, an in-cluster ingress class. No GCP/Azure/AWS env var is required or read.
2. **Cloud is an adapter, not a branch.** Every cloud-specific behaviour is encapsulated behind one interface (`HostingAdapter`) and lives in a dedicated, provider-named folder. The reconcile loop never names a cloud.
3. **One seam.** Today the operator branches on `config.storageProvider` / `config.csiDriver` / `config.crossplaneEnabled` in five files. After this change there is a single decision point: which adapter is constructed at startup.
4. **IAM-first (per `AGENTS.md`).** Each cloud adapter uses that cloud's federated workload identity (GKE Workload Identity, EKS IRSA, AKS Workload Identity). On-prem uses Kubernetes-native identity only. No static cloud credentials in the default or in any adapter.
5. **No dead multi-cloud.** The `gcs | azure-blob | s3` union is type-only today. Either a provider has a working adapter or it is not offered. Capability gaps are explicit (§5), not implied by an enum.

## 2. Pattern: GoF Adapter

We apply the classic **Adapter** pattern (Gamma et al.) to decouple the operator's reconcile loop from any specific hosting substrate.

| GoF role | In OpenCrane |
|----------|--------------|
| **Target** (the interface the client expects) | `HostingAdapter` — the provider-agnostic contract the operator depends on. |
| **Client** | The `TenantOperator` reconcile loop and the tenant resource builders. They call `HostingAdapter` only. |
| **Adaptee** (the existing, incompatible interface) | Cloud SDKs and cloud annotation conventions: `@google-cloud/storage`, Azure Blob SDK, AWS S3 SDK, `iam.gke.io/*`, `eks.amazonaws.com/role-arn`, `azure.workload.identity/*`, cloud CSI drivers. |
| **Adapter** (wraps the adaptee to satisfy the target) | `GcpHostingAdapter`, `AzureHostingAdapter`, `AwsHostingAdapter`. |
| **Default / null-object adapter** | `OnPremHostingAdapter` — satisfies the target using only vanilla Kubernetes primitives; cloud operations are no-ops. |
| **Factory** | `_BuildHostingAdapter(config)` — selects the adapter at startup; defaults to on-prem. |

The on-prem adapter doubles as a **Null Object**: cloud-only operations (external bucket provisioning) are explicit no-ops, so the reconcile loop has no conditionals.

## 3. The Target Interface

The operator depends on exactly this contract. Everything cloud-shaped is expressed as data the adapter returns, not behaviour the loop performs.

```typescript
// apps/operator/src/hosting/hosting-adapter.types.ts
import type * as k8s from "@kubernetes/client-node";

/** Supported hosting substrates. On-prem is the default. */
export enum HostingProvider
{
  OnPrem = "onprem",
  Gcp = "gcp",
  Azure = "azure",
  Aws = "aws",
}

/** Request describing the tenant whose storage is being provisioned. */
export interface TenantStorageRequest
{
  /** Tenant CR name. */
  tenantName: string;
  /** Namespace the tenant runs in. */
  namespace: string;
}

/** Result of provisioning external storage for a tenant. */
export interface TenantStorageBinding
{
  /** Provider-native storage identifier (bucket/container name), or null on-prem. */
  externalName: string | null;
}

/** The pod's persistent state volume and how it is mounted. */
export interface TenantStateVolume
{
  /** Pod volume definition (cloud CSI mount, or PVC reference on-prem). */
  volume: k8s.V1Volume;
  /** Where the volume mounts inside the tenant container. */
  volumeMount: k8s.V1VolumeMount;
  /** True when the operator must also create a PersistentVolumeClaim (on-prem path). */
  requiresPvc: boolean;
}

/** Ingress class and annotations appropriate to the hosting substrate. */
export interface IngressBinding
{
  /** Ingress class name (e.g. "nginx" on-prem, "gce" on GKE). */
  ingressClassName: string;
  /** Provider-specific ingress annotations (empty on-prem default). */
  annotations: Record<string, string>;
}

/**
 * The single contract the operator depends on for all hosting-substrate concerns.
 * Cloud specifics live behind concrete adapters; on-prem is the default implementation.
 */
export interface HostingAdapter
{
  /** Identifier of the active provider, for logging and metrics. */
  readonly provider: HostingProvider;

  /** Provision external storage for a tenant. No-op (returns null externalName) on-prem. */
  provisionTenantStorage(request: TenantStorageRequest): Promise<TenantStorageBinding>;

  /** Release external storage for a tenant. No-op on-prem. */
  deprovisionTenantStorage(tenantName: string): Promise<void>;

  /** Identity annotations merged onto the tenant ServiceAccount. Empty on-prem. */
  buildServiceAccountIdentity(tenantName: string): Record<string, string>;

  /** The tenant pod state volume + mount, plus whether a PVC must be created. */
  buildStateVolume(tenantName: string): TenantStateVolume;

  /** Ingress class + annotations for the tenant ingress. */
  buildIngressBinding(): IngressBinding;
}
```

## 4. Code Architecture

### 4.1 Folder layout (operator)

Cloud code is physically isolated; each provider is one self-contained folder. Core/shared primitives are provider-agnostic.

```
apps/operator/src/
├── hosting/
│   ├── index.ts                          # barrel: exports HostingAdapter, factory, enum, DTOs
│   ├── hosting-adapter.types.ts          # Target interface + DTOs (§3)
│   ├── hosting-adapter.factory.ts        # _BuildHostingAdapter(config) → defaults to on-prem
│   ├── core/                             # provider-agnostic building blocks
│   │   ├── pvc-state-volume.ts           # PVC-backed TenantStateVolume + V1PersistentVolumeClaim builder
│   │   └── plain-ingress-binding.ts      # in-cluster ingress class binding
│   └── adapters/
│       ├── onprem/
│       │   └── onprem-hosting.adapter.ts # DEFAULT. Vanilla k8s; cloud ops are no-ops.
│       ├── gcp/
│       │   ├── gcp-hosting.adapter.ts     # implements HostingAdapter via the clients below
│       │   ├── gcp-bucket.client.ts       # wraps @google-cloud/storage (the adaptee)
│       │   └── gcp-hosting.types.ts       # GCP-only config shape (projectId, csiDriver, ...)
│       ├── azure/
│       │   └── azure-hosting.adapter.ts   # AKS Workload Identity + Blob CSI
│       └── aws/
│           └── aws-hosting.adapter.ts     # EKS IRSA + S3 CSI / Mountpoint
├── tenants/
│   ├── operator.ts                       # reconcile loop: depends ONLY on HostingAdapter
│   └── deploy/                           # builders take the adapter, never config.storageProvider
└── config.ts                             # adds hostingProvider; cloud blocks optional
```

Rules enforced by review (and ideally an ESLint boundary):
- Nothing under `tenants/` imports from `hosting/adapters/<cloud>/**`. It imports only the `hosting` barrel (the Target interface + factory).
- `hosting/core/**` never imports a cloud SDK.
- Each `adapters/<cloud>/**` folder is the only place that provider's SDK and annotation strings appear.

### 4.2 The default: on-prem adapter

The baseline. No cloud SDK, no annotations, PVC storage, in-cluster ingress.

```typescript
// apps/operator/src/hosting/adapters/onprem/onprem-hosting.adapter.ts
import type * as k8s from "@kubernetes/client-node";

import { HostingProvider } from "../../hosting-adapter.types.js";
import type { HostingAdapter, IngressBinding, TenantStateVolume, TenantStorageBinding, TenantStorageRequest } from "../../hosting-adapter.types.js";
import { _BuildPvcStateVolume } from "../../core/pvc-state-volume.js";

/** Default hosting adapter: vanilla Kubernetes, no cloud dependency. */
export class OnPremHostingAdapter implements HostingAdapter
{
  /** @inheritdoc */
  public readonly provider: HostingProvider = HostingProvider.OnPrem;

  /** No external storage on-prem; tenant state lives on a PVC. */
  public async provisionTenantStorage(_request: TenantStorageRequest): Promise<TenantStorageBinding>
  {
    return { externalName: null };
  }

  /** Nothing to release on-prem; the PVC is garbage-collected with the tenant. */
  public async deprovisionTenantStorage(_tenantName: string): Promise<void>
  {
    return;
  }

  /** Plain ServiceAccount: no cloud identity annotations. */
  public buildServiceAccountIdentity(_tenantName: string): Record<string, string>
  {
    return {};
  }

  /** PVC-backed state volume; the operator must create the PVC. */
  public buildStateVolume(tenantName: string): TenantStateVolume
  {
    return _BuildPvcStateVolume(tenantName);
  }

  /** In-cluster ingress class with no provider annotations. */
  public buildIngressBinding(): IngressBinding
  {
    return { ingressClassName: "nginx", annotations: {} };
  }
}
```

### 4.3 A cloud adapter: GCP

The GCP adapter is the only place GKE annotations and `@google-cloud/storage` appear. Per the `cloud-provisioning` analysis, bucket creation moves **into the operator via the cloud SDK + Workload Identity** — Crossplane is no longer on the default or required path.

```typescript
// apps/operator/src/hosting/adapters/gcp/gcp-hosting.adapter.ts
import type * as k8s from "@kubernetes/client-node";

import { HostingProvider } from "../../hosting-adapter.types.js";
import type { HostingAdapter, IngressBinding, TenantStateVolume, TenantStorageBinding, TenantStorageRequest } from "../../hosting-adapter.types.js";
import type { GcpHostingConfig } from "./gcp-hosting.types.js";
import { GcpBucketClient } from "./gcp-bucket.client.js";

/** Hosting adapter for GKE: Workload Identity + GCS Fuse CSI + in-operator bucket provisioning. */
export class GcpHostingAdapter implements HostingAdapter
{
  /** @inheritdoc */
  public readonly provider: HostingProvider = HostingProvider.Gcp;

  /** GCP-only configuration (project, bucket prefix, CSI driver). */
  private readonly config: GcpHostingConfig;

  /** Wraps @google-cloud/storage — the adaptee. */
  private readonly buckets: GcpBucketClient;

  /**
   * @param config - GCP hosting configuration.
   * @param buckets - GCS client wrapper (injected for testability).
   */
  public constructor(config: GcpHostingConfig, buckets: GcpBucketClient)
  {
    this.config = config;
    this.buckets = buckets;
  }

  /** Create the tenant's GCS bucket via the cloud SDK (Workload Identity auth, idempotent). */
  public async provisionTenantStorage(request: TenantStorageRequest): Promise<TenantStorageBinding>
  {
    const bucketName = `${this.config.bucketPrefix}-${request.tenantName}`;

    // 1. Ensure the bucket exists. Idempotent so repeated reconciles are safe.
    await this.buckets.ensureBucket(bucketName);

    return { externalName: bucketName };
  }

  /** Buckets are retained on tenant deletion to avoid data loss; override via policy. */
  public async deprovisionTenantStorage(_tenantName: string): Promise<void>
  {
    return;
  }

  /** GKE Workload Identity annotation binding the KSA to a per-tenant GSA. */
  public buildServiceAccountIdentity(tenantName: string): Record<string, string>
  {
    return {
      "iam.gke.io/gcp-service-account": `openclaw-${tenantName}@${this.config.projectId}.iam.gserviceaccount.com`,
    };
  }

  /** GCS Fuse CSI volume mounting the tenant bucket. */
  public buildStateVolume(tenantName: string): TenantStateVolume
  {
    const volume: k8s.V1Volume = {
      name: "tenant-storage",
      csi: {
        driver: this.config.csiDriver,
        volumeAttributes: { bucketName: `${this.config.bucketPrefix}-${tenantName}` },
      },
    } as k8s.V1Volume;

    return {
      volume,
      volumeMount: { name: "tenant-storage", mountPath: "/data/openclaw" },
      requiresPvc: false,
    };
  }

  /** GCE ingress class with GKE-appropriate annotations. */
  public buildIngressBinding(): IngressBinding
  {
    return { ingressClassName: "gce", annotations: { "kubernetes.io/ingress.class": "gce" } };
  }
}
```

### 4.4 Factory (the single decision point)

```typescript
// apps/operator/src/hosting/hosting-adapter.factory.ts
import type { OperatorConfig } from "../config.js";
import { HostingProvider } from "./hosting-adapter.types.js";
import type { HostingAdapter } from "./hosting-adapter.types.js";
import { OnPremHostingAdapter } from "./adapters/onprem/onprem-hosting.adapter.js";
import { GcpHostingAdapter } from "./adapters/gcp/gcp-hosting.adapter.js";
import { GcpBucketClient } from "./adapters/gcp/gcp-bucket.client.js";

/**
 * Construct the hosting adapter for the configured provider.
 * Defaults to on-prem when the provider is unset or unrecognised.
 *
 * @param config - Operator configuration.
 * @returns The active hosting adapter.
 */
export function _BuildHostingAdapter(config: OperatorConfig): HostingAdapter
{
  // 1. Branch once, here, on the configured provider. Everything downstream is provider-agnostic.
  switch (config.hostingProvider)
  {
    case HostingProvider.Gcp:
      // 2. Cloud adapters are constructed with their own config + SDK client wrapper.
      return new GcpHostingAdapter(config.gcp!, new GcpBucketClient(config.gcp!.projectId));
    case HostingProvider.OnPrem:
    default:
      // 3. Default path requires no cloud configuration whatsoever.
      return new OnPremHostingAdapter();
  }
}
```

### 4.5 How the reconcile loop changes

`operator.ts` loses every cloud conditional. It holds one `HostingAdapter` and calls it:

```typescript
// 1. ServiceAccount — identity annotations come from the adapter (empty on-prem).
await _K8sApplyResource(this.coreApi, _BuildServiceAccount(this.hosting, tenant, namespace), this.log);

// 2. External storage — no-op on-prem; bucket created via cloud SDK otherwise.
await this.hosting.provisionTenantStorage({ tenantName: name, namespace });

// 3. State volume — adapter decides CSI vs PVC; create the PVC only when it asks for one.
const stateVolume = this.hosting.buildStateVolume(name);
if (stateVolume.requiresPvc)
{
  await _K8sApplyResource(this.coreApi, _BuildStatePvc(name, namespace), this.log);
}
// ... Deployment consumes stateVolume.volume / stateVolume.volumeMount
// ... Ingress consumes this.hosting.buildIngressBinding()
```

The builders (`_BuildServiceAccount`, `_BuildDeployment`, `_BuildIngress`) take the adapter (or its returned DTOs) instead of reading `config.storageProvider`. The broken `_BuildGCPBucketClaim` / Crossplane path is deleted.

### 4.6 Dependency strategy: cloud SDKs are optional and lazy-loaded

The on-prem default must not depend on any cloud SDK — at install time or at runtime. If `@google-cloud/storage` (and later the Azure/AWS SDKs) were ordinary `dependencies`, every on-prem install would drag in all of them, defeating the adapter pattern's whole purpose. Two mechanisms enforce the separation:

1. **`optionalDependencies`** — each cloud SDK is declared under `optionalDependencies` in `apps/operator/package.json`, never `dependencies`. A normal `pnpm install` fetches them for development and cloud images; an on-prem image built with `pnpm install --no-optional` omits them entirely and still runs.
2. **Lazy `import()` at the SDK boundary** — the SDK is loaded with a dynamic `await import("@google-cloud/storage")` inside the client method that uses it, not with a top-level import. The only compile-time reference is a TypeScript `import type`, which is erased and produces zero runtime code. So the static chain `factory → GcpHostingAdapter → GcpBucketClient` loads with the SDK absent; the SDK is `require`d only when a GCP bucket operation actually executes.

```typescript
// apps/operator/src/hosting/adapters/gcp/gcp-bucket.client.ts
import type { Storage } from "@google-cloud/storage"; // erased at compile time — no runtime dep

export class GcpBucketClient implements GcsBucketOperations
{
  private storage: Storage | null = null;

  /** Lazily import the optional SDK and memoise the client. */
  private async _getStorage(): Promise<Storage>
  {
    if (this.storage) return this.storage;
    const sdk = await import("@google-cloud/storage"); // loaded only on a real GCP op
    this.storage = new sdk.Storage({ projectId: this.projectId });
    return this.storage;
  }
}
```

**Net effect (verified):** with the package physically removed, the on-prem factory builds and provisions normally, the GCP adapter still *constructs*, and only a live GCP bucket operation fails — with an actionable "install the optional GCP dependency" error rather than a module-load crash at startup.

**Rule for every cloud adapter.** Each `adapters/<cloud>/**` folder declares its SDK under `optionalDependencies`, imports it only as `import type`, and loads it via dynamic `import()` at the operation boundary. This keeps the dependency graph flexible: the substrate you don't use is the substrate you don't ship. A future step may graduate each adapter into its own workspace package (`@opencrane/hosting-gcp`) for full install-time isolation — the `HostingAdapter` contract makes that a non-breaking change — but optional + lazy already delivers the runtime independence.

## 5. Capability Matrix

Explicit, not implied. A blank cell means "not implemented" — the provider is simply not selectable for that concern until built.

| Concern | On-Prem (default) | GCP | Azure | AWS |
|--------|-------------------|-----|-------|-----|
| Tenant state storage | PVC (RWO) | GCS + Fuse CSI | Blob + Blob CSI | S3 + Mountpoint CSI |
| External storage provisioning | n/a (PVC) | `@google-cloud/storage` (in-operator) | Blob SDK | S3 SDK |
| Workload identity | Kubernetes SA only | GKE Workload Identity | AKS Workload Identity | EKS IRSA |
| Ingress class | nginx | gce | azure/application-gateway | alb |
| Ingress TLS | cert-manager wildcard (§6.3) | cert-manager wildcard (§6.3) | cert-manager wildcard | cert-manager wildcard |
| Secrets backing | in-cluster Secret | in-cluster Secret (ESO optional) | in-cluster Secret (ESO optional) | in-cluster Secret (ESO optional) |
| DNS | external-dns / manual | Cloud DNS (infra layer) | Azure DNS | Route 53 |

TLS is provider-agnostic on purpose: a single k8s-native mechanism (cert-manager
issuing a wildcard cert via ACME DNS-01) works the same on every substrate, rather
than per-cloud managed certs. See §6.3.

GCP is the first fully-built cloud adapter. Azure/AWS folders exist as the agreed extension points; they ship only when their cells are real.

## 6. Infrastructure Architecture (Terraform + Helm)

The same on-prem-default / cloud-override split applies to deployment, in mirrored folders.

### 6.1 Terraform

```
platform/terraform/
├── core/                      # cloud-agnostic: namespace, opencrane Helm release, CRDs,
│                              #   optional in-cluster PostgreSQL. Runs against ANY cluster.
├── modules/                   # reusable building blocks
│   ├── gke/  cloud-sql/  networking/  artifact-registry/  dns/        # gcp building blocks
│   ├── aks/  ...                                                       # azure (future)
│   └── eks/  ...                                                       # aws (future)
└── cloud/
    ├── gcp/                   # composes modules/gke + cloud-sql + dns + core
    ├── azure/                 # (future)
    └── aws/                   # (future)
```

- **On-prem install** runs `core/` only (or just `helm install` — no Terraform required).
- **Cloud install** runs `cloud/<provider>/`, which provisions the managed cluster + data services, then applies `core/` onto it.
- The Crossplane module is removed from the default. If anyone still wants Crossplane-managed cloud resources, it becomes an optional component under `cloud/gcp/` — never in `core/`.

### 6.2 Helm

```
platform/helm/
├── Chart.yaml
├── values.yaml                # ON-PREM DEFAULTS: hosting.provider=onprem, storage.mode=pvc,
│                              #   ingress.className=nginx, ingress.tls.enabled=false,
│                              #   certManager.enabled=false, NO cloud blocks set.
└── values/
    ├── gcp.yaml               # hosting.provider=gcp, gcsfuse CSI, gce ingress, workloadIdentity
    ├── azure.yaml             # (future)
    └── aws.yaml               # (future)
```

Install examples:
```bash
# On-prem / self-hosted (default — no override file needed)
helm install opencrane platform/helm

# GCP
helm install opencrane platform/helm -f platform/helm/values/gcp.yaml
```

The chart's `hosting` block maps 1:1 onto the operator's `hostingProvider` + per-cloud config, so the Helm value selects the adapter.

Both examples above are **single-install** (one instance + its CRDs, applied in one step).
To run **multiple isolated instances in one cluster**, the CRDs are installed once
cluster-wide and each per-instance release is installed with `--skip-crds`. See
[`docs/multi-instance.md`](multi-instance.md) for the procedure and the CRD-version
compatibility contract.

### 6.3 Ingress TLS (cert-manager wildcard — plan CONN.8)

TLS is deliberately **k8s-native and provider-agnostic** rather than per-cloud managed
certs, so the same mechanism works on-prem and on any cloud. `ingress.domain` is
per-instance, so it **is** the **ClusterTenant base domain** — the customer's own domain
(e.g. `ai.client-company.com`); the wildcard `*.<domain>` covers that customer's **UserTenant**
gateway hosts (`<user>.<domain>`, e.g. `mike.ai.client-company.com`), not the ClusterTenant itself.
The control plane runs on the platform's own separate domain (e.g. `example.com`).

- **cert-manager** issues one **wildcard `*.<ingress.domain>` (+ apex) certificate** via
  ACME **DNS-01** (wildcards require DNS-01) into the `ingress.tls.secretName` Secret
  (default `opencrane-wildcard-tls`). One cert covers every `<user>.<domain>` UserTenant
  gateway, so adding a UserTenant needs no new issuance.
- The chart renders a `ClusterIssuer` + wildcard `Certificate`
  (`platform/helm/templates/cluster-issuer.yaml`) when `certManager.enabled=true` —
  `mode: selfSigned` for dev/local, `mode: acme` with a DNS-01 solver for production.
- The operator adds a `tls:` block to each **UserTenant** Ingress (one Ingress per
  UserTenant at `<name>.<ingress.domain>`, referencing the shared wildcard Secret) when
  `ingress.tls.enabled=true`, driven by `INGRESS_TLS_ENABLED` / `INGRESS_TLS_SECRET_NAME`
  env. Default off → no behaviour change.
- **Apex / control-plane gap.** The wildcard cert *covers* the apex (`<domain>`) as a SAN,
  and the intended model routes the apex to the control-plane management API. But the
  **apex→control-plane Ingress is not shipped in the chart today** — only the per-UserTenant
  Ingresses are operator-built. Routing the (cert-covered) apex to the control-plane Service
  is currently an installer/out-of-chart step.
- **Constraint:** TLS Secrets are namespace-scoped, so `certManager.certificateNamespace`
  must equal the namespace UserTenant Ingresses run in (the operator `watchNamespace`). The
  one-label-per-UserTenant, apex-as-SAN, host-only-cookie, and delegated-DNS-subzone rules
  live in plan CONN.8.

Remaining CONN.8 follow-ups: a DNS-provider onboarding CLI/API (`oc platform dns set`),
cross-namespace cert distribution if tenants ever split across namespaces, dev wildcard
hostnames via `sslip.io`/`nip.io`, and a live ACME end-to-end check.

## 7. Configuration Model

```typescript
// config.ts additions
export interface OpenClawTenantOperatorConfig
{
  /** Active hosting substrate. Defaults to on-prem. */
  hostingProvider: HostingProvider;

  /** GCP-specific config, present only when hostingProvider === Gcp. */
  gcp?: GcpHostingConfig;

  // ...existing provider-agnostic fields (ingressDomain, gatewayPort, liteLlm*, etc.)
}
```

- `HOSTING_PROVIDER` env var, default `onprem`. When unset, the platform is fully on-prem.
- Cloud config is **namespaced** under its provider key and only read by that provider's adapter. On-prem reads none of it.
- The legacy `storageProvider` / `csiDriver` / `gcpProject` / `crossplaneEnabled` flags are removed (folded into `hosting.provider` + `gcp`), consistent with the `AGENTS.md` "Delivery Direction (Pre-Production)" rule to delete superseded legacy branches rather than keep compatibility shims.

## 8. Crossplane Disposition

Per the prior investigation, Crossplane never actually provisioned buckets (no CRD, no Composition, only the IAM provider installed). This architecture **removes Crossplane from the default and required path**:

- Bucket provisioning moves into the GCP adapter via `@google-cloud/storage` + Workload Identity.
- The `BucketClaim` builder, `crossplaneEnabled` flag, `crossplane-provider.yaml`, and the Terraform `crossplane` module are deleted from the core path.
- Crossplane remains *available* as an optional, GCP-scoped component under `cloud/gcp/` for teams that prefer a Composition-based model — but it is never installed for on-prem and never on the critical path.

## 9. Migration Plan (completed in Phase 5)

Executed additive-first, cutover-last, so the build stayed green throughout. Steps 1–5
are **done**; step 6 (Azure/AWS) remains a future extension that needs no core change.

1. ✅ **Introduce the seam (additive).** Add `hosting/` with the interface, DTOs, `OnPremHostingAdapter`, and the factory. Add `hostingProvider` to config defaulting to `onprem`. Nothing consumes it yet. Build + tests stay green.
2. ✅ **Route the on-prem path through the adapter.** `operator.ts` and the deploy builders consume `HostingAdapter` for SA identity, state volume, and ingress; with the default adapter this reproduces the PVC/local behaviour exactly. Operator unit tests assert against the adapter output.
3. ✅ **Build the GCP adapter.** `GcpHostingAdapter` + `GcpBucketClient` (in-operator bucket provisioning) + `gcp-hosting.types.ts` + `values/gcp.yaml`. The Crossplane `BucketClaim` path and `crossplaneEnabled` are deleted.
4. ✅ **Split infra folders.** `terraform/core/` carved out; GCP modules under `cloud/gcp/`; `crossplane` module dropped from `core`. Installers (`platform/install.sh`, `deploy.sh`) call `core` for on-prem and `cloud/gcp` for GCP.
5. ✅ **Remove legacy flags + docs.** `storageProvider`/`csiDriver`/`gcpProject`/`crossplaneEnabled` deleted; README + `plan.md` describe on-prem-default + cloud-override.
6. ⬜ **(Future) Azure/AWS adapters.** New folders only; no core change required — the proof the seam is correct.

## 10. Testing

- **On-prem adapter:** pure unit tests (no cloud SDK) asserting PVC volume, empty identity annotations, nginx ingress, no-op provisioning. Runs in CI everywhere, including the k3d e2e.
- **GCP adapter:** unit tests with an injected fake `GcpBucketClient` (idempotency, naming, annotation shape). No live GCP needed for CI.
- **Boundary test / lint rule:** assert `tenants/**` never imports `hosting/adapters/<cloud>/**` and `hosting/core/**` imports no cloud SDK, so the separation cannot silently erode.
- **k3d e2e:** unchanged — it exercises the default on-prem adapter end-to-end, which is exactly the baseline we promise.

## 11. Open Decisions

- [ ] Bucket retention on tenant deletion: retain (current) vs. policy-driven delete — affects `deprovisionTenantStorage`.
- [ ] Secrets backing: keep in-cluster Secrets as the cross-provider default, or add an optional External Secrets Operator capability to the adapter interface.
- [ ] DNS ownership: external-dns (works on-prem + cloud uniformly) vs. per-cloud DNS modules in the infra layer.
- [ ] Whether `IngressBinding.ingressClassName` defaults belong in config (so on-prem can pick traefik/nginx) rather than hard-coded in the adapter.
- [ ] ESLint import-boundary tooling choice for enforcing §4.1 rules in CI.
```
