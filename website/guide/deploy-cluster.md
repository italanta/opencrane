# Cluster deployment

For production, run OpenCrane on a managed Kubernetes cluster. OpenCrane is **plain
Kubernetes** — standard storage (PVC), standard ingress, in-cluster PostgreSQL,
Kubernetes Secrets — so **any conformant cluster works the same way**. No
cloud-specific features are required.

## Provider support

| Provider | Managed Kubernetes | Status |
|----------|--------------------|--------|
| **Google Cloud** | GKE | ✅ Supported (guided script) |
| **AWS** | EKS | 🚧 TODO |
| **Azure** | AKS | 🚧 TODO |
| **Alibaba Cloud** | ACK | 🙌 Looking for contributors |

Everything below the GKE section uses the **same** `k8s-deploy.sh` — the only
provider-specific part is *creating the cluster*. AWS/Azure/Alibaba have no
first-class guide yet, but the generic steps work on them today.

---

## Any cluster — `k8s-deploy.sh`

Use this when you **already have a cluster** (or created one with your provider's
console/CLI).

::: tip What you need to configure
- A **Kubernetes cluster**, with `kubectl` set to its context (`kubectl config current-context`).
- `helm` installed locally.
- An **ingress controller** — the chart uses the `nginx` ingress class by default
  (e.g. install [ingress-nginx](https://kubernetes.github.io/ingress-nginx/)).
- A **default StorageClass** (for the PostgreSQL volume — most clusters have one).
- A **domain** + DNS (step 4).
:::

**Steps**

```bash
# 1. Confirm kubectl points at the right cluster
kubectl config current-context

# 2. Make sure an ingress controller is installed (skip if you already have one)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace

# 3. Install OpenCrane (CNPG Postgres → chart → migrations, using published images)
./platform/k8s-deploy.sh --domain opencrane.example.com
```

```bash
# 4. Point DNS at the ingress's external IP
kubectl get svc -n ingress-nginx ingress-nginx-controller    # copy EXTERNAL-IP
#    opencrane.example.com     A   <ingress-ip>
#    *.opencrane.example.com   A   <ingress-ip>
```

Useful flags: `--namespace`, `--image-tag`, `--storage-class`, `--values <file>`,
and `--set key=value` (passed straight to Helm).

---

## Google Cloud (GKE) ✅ — `gke-deploy.sh`

GKE is treated as a standard cluster. One script provisions a plain cluster with
Terraform, then installs OpenCrane.

::: tip What you need to configure
- `gcloud` (authenticated), `terraform`, `kubectl`, `helm`.
- A **GCP project** with **billing enabled**.
- A **domain** + DNS (step 4). An **ingress controller** (step 3) — GKE ships none
  for the `nginx` class.
:::

**Steps**

```bash
# 1. Authenticate
gcloud auth login
gcloud auth application-default login

# 2. Provision a plain GKE cluster + install OpenCrane (only project id is required)
./platform/gke-deploy.sh \
  --project-id YOUR_GCP_PROJECT \
  --region europe-west1 \
  --domain opencrane.example.com
```

What step 2 does: enables the `container` + `compute` APIs, `terraform apply`
creates a GKE cluster on the project's **default VPC** (nothing else), fetches
credentials, then installs OpenCrane with the published images.

```bash
# 3. Install an ingress controller (GKE has none for the nginx class)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace

# 4. Point DNS at the ingress IP (kubectl get svc -n ingress-nginx …), as above.
```

::: details Optional GCP-native extras
Want deeper GCP integration? GCS-backed tenant storage + Workload Identity, Secret
Manager via External Secrets, Cloud DNS records, a dedicated VPC, or Artifact
Registry are all **opt-in** Terraform toggles (`enable_gcs_storage`,
`enable_cloud_dns`, `enable_custom_vpc`, `enable_artifact_registry`) plus the
`values/gcp-extras.yaml` Helm overlay. The default deploy stays plain Kubernetes.
See [Hosting & deployment](/operators/hosting).
:::

---

## AWS (EKS) 🚧 · Azure (AKS) 🚧

**No first-class guide yet** — but EKS/AKS are plain Kubernetes. Create the cluster
with your provider, ensure an ingress controller + default StorageClass, then run
the generic **`k8s-deploy.sh`** steps above. Tried it? A write-up contribution would
land your provider in the table as ✅.

## Alibaba Cloud (ACK) 🙌

**Looking for contributors.** We'd love a tested ACK path — same generic
`k8s-deploy.sh` flow. Please open a PR with the steps.

---

## After any cluster install

1. **[Set up your domain & HTTPS](/guide/dns)** — DNS records and certificates.
2. **[Get a token and create your first assistant](/guide/first-tenant)**.
3. **[Choose a model provider](/guide/budgets)** — `oc providers set claude <key>`.
