# Cluster deployment

For production, run OpenCrane on a managed Kubernetes cluster. Because OpenCrane is
**plain Kubernetes** — standard storage (PVC), standard ingress, in-cluster
PostgreSQL, Kubernetes Secrets — **any conformant cluster works the same way**.

There are no required cloud-specific features. A managed cluster is just a Kubernetes
cluster someone else runs the nodes for.

## Provider support

| Provider | Managed Kubernetes | Status |
|----------|--------------------|--------|
| **Google Cloud** | GKE | ✅ Supported |
| **AWS** | EKS | 🚧 TODO |
| **Azure** | AKS | 🚧 TODO |
| **Alibaba Cloud** | ACK | 🙌 Looking for contributors |

"Supported" means there's a documented, tested path below. The others are plain
Kubernetes too, so OpenCrane should run on them today — they just don't have a
first-class guide yet. Contributions welcome.

## The shape of any cluster deploy

A working cluster requires **two Helm releases** installed in order:

1. **Have a cluster** — create one with your provider, or use an existing one. Make
   sure `kubectl` points at it.
2. **Make images reachable** — pull OpenCrane's images from a registry your cluster
   can read (the public images, your own mirror, or your provider's registry).
3. **Install the fleet release** (`apps/fleet-platform`, chart `opencrane-fleet`) — this
   installs the cluster-wide bootstrap (CRDs, cert-manager issuer, ingress-nginx,
   external-dns, CNPG operator) plus the fleet-manager.
4. **Install one silo release per org** (`apps/clustertenant-platform`, chart
   `opencrane-silo`) — the per-org control plane and runtime planes.
5. **Point your domain** at the ingress — see [Set up your domain](/guide/dns).

## Two deploy profiles

Two thin profile scripts over the shared install core
(`libs/k8s-platform/k8s-deploy.sh`) pick the posture for you so the profiles cannot
diverge:

| Profile | Script | What you get |
|---------|--------|--------------|
| **Single-tenant** (default) | `libs/k8s-platform/deploy-single-tenant.sh` | One organisation, seeded at install. Self-service org creation + billing are **off**; the script runs the fleet pass then the silo pass in one call. |
| **Multi-tenant fleet** | `apps/fleet-platform/deploy.sh` + `apps/clustertenant-platform/deploy.sh` | The full self-service platform — any signed-in user can create an org; fleet wildcard + the ClusterTenant manager are on; silo releases installed separately per org. |

```bash
# Single-tenant: one org served at <org-name>.<base-domain>
libs/k8s-platform/deploy-single-tenant.sh \
  --base-domain dev.opencrane.ai \
  --org-name acme --org-owner-email owner@acme.example

# Multi-tenant fleet: step 1 — fleet release (cluster-wide bootstrap + fleet-manager)
apps/fleet-platform/deploy.sh \
  --base-domain opencrane.example.com \
  --cert-manager --acme-email ops@example.com --dns01-provider clouddns

# Multi-tenant fleet: step 2 — silo release per org (repeat for each ClusterTenant)
apps/clustertenant-platform/deploy.sh \
  --base-domain opencrane.example.com \
  --cluster-tenant acme
```

Both forward every shared-core flag (cert-manager mode, OIDC, image tags, …) verbatim.

## Check the cluster first (`--preflight`)

Before installing, run a read-only environment check that fails **fast** with exact
remediation rather than leaving a half-installed, crash-looping cluster:

```bash
apps/fleet-platform/deploy.sh --base-domain <your-domain> --cert-manager \
  --acme-email you@org --dns01-provider clouddns --preflight
```

It verifies a default StorageClass exists, a NetworkPolicy-enforcing CNI is present,
the first-party images are pullable, your base domain's NS delegation resolves, and the
DNS-write capability shared by external-dns + cert-manager DNS-01 is in place. It makes
**no** changes; re-run without `--preflight` to install.

## Google Cloud (GKE) ✅

GKE is treated as a standard Kubernetes cluster — no GCP-only features required.

```bash
# 1. Create a cluster (Autopilot manages the nodes for you)
gcloud container clusters create-auto opencrane --region <region>
gcloud container clusters get-credentials opencrane --region <region>

# 2. Install the fleet release
apps/fleet-platform/deploy.sh --base-domain <your-domain>

# 3. Install a silo release per org
apps/clustertenant-platform/deploy.sh \
  --base-domain <your-domain> \
  --cluster-tenant <org-name>
```

Then [point your domain](/guide/dns) at the ingress IP.

::: details Optional GCP-native extras
If you *want* deeper GCP integration — GCS-backed tenant storage with Workload
Identity, Secret Manager via External Secrets, or Cloud DNS for automatic records —
those are available as opt-in overlays. They aren't required, and the default GKE
deploy stays plain Kubernetes. See [Hosting & deployment](/operators/hosting).
:::

## AWS (EKS) 🚧

**TODO.** A first-class EKS guide isn't written yet. Since OpenCrane is plain
Kubernetes, a standard EKS cluster with an ingress controller and a default
StorageClass should work with the deploy scripts. Tried it? A write-up
contribution would land you in the table above.

## Azure (AKS) 🚧

**TODO.** No first-class AKS guide yet — same story as EKS: standard cluster, run the
deploy scripts. Contributions welcome.

## Alibaba Cloud (ACK) 🙌

**Looking for contributors.** We'd love a tested ACK path. If you run OpenCrane on
Alibaba Cloud Container Service for Kubernetes, please open a PR with the steps.

## Next

→ **[Set up your domain](/guide/dns)** → **[Create your first assistant](/guide/first-tenant)**
