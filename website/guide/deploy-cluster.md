# Cluster deployment

For production, run OpenCrane on a managed Kubernetes cluster. Because OpenCrane is
**plain Kubernetes** — standard storage (PVC), standard ingress, in-cluster
PostgreSQL, Kubernetes Secrets — **any conformant cluster works the same way**:

```bash
helm install opencrane platform/helm --set ingress.domain=<your-domain>
```

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

1. **Have a cluster** — create one with your provider, or use an existing one. Make
   sure `kubectl` points at it.
2. **Make images reachable** — pull OpenCrane's images from a registry your cluster
   can read (the public images, your own mirror, or your provider's registry).
3. **Install** — `helm install opencrane platform/helm --set ingress.domain=<your-domain>`.
4. **Point your domain** at the ingress — see [Set up your domain](/guide/dns).

## Google Cloud (GKE) ✅

GKE is treated as a standard Kubernetes cluster — no GCP-only features required.

```bash
# 1. Create a cluster (Autopilot manages the nodes for you)
gcloud container clusters create-auto opencrane --region <region>
gcloud container clusters get-credentials opencrane --region <region>

# 2. Install OpenCrane
helm install opencrane platform/helm --set ingress.domain=<your-domain>
```

Then [point your domain](/guide/dns) at the ingress IP. That's it — same chart,
standard Kubernetes.

::: details Optional GCP-native extras
If you *want* deeper GCP integration — GCS-backed tenant storage with Workload
Identity, Secret Manager via External Secrets, or Cloud DNS for automatic records —
those are available as opt-in overlays. They aren't required, and the default GKE
deploy stays plain Kubernetes. See [Hosting & deployment](/operators/hosting).
:::

## AWS (EKS) 🚧

**TODO.** A first-class EKS guide isn't written yet. Since OpenCrane is plain
Kubernetes, a standard EKS cluster with an ingress controller and a default
StorageClass should work with the same `helm install`. Tried it? A write-up
contribution would land you in the table above.

## Azure (AKS) 🚧

**TODO.** No first-class AKS guide yet — same story as EKS: standard cluster,
standard `helm install`. Contributions welcome.

## Alibaba Cloud (ACK) 🙌

**Looking for contributors.** We'd love a tested ACK path. If you run OpenCrane on
Alibaba Cloud Container Service for Kubernetes, please open a PR with the steps.

## Next

→ **[Set up your domain](/guide/dns)** → **[Create your first assistant](/guide/first-tenant)**
