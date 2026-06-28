# Local, VM or VPS

Run all of OpenCrane on a **single machine** — your laptop, a VM, or a VPS. This is
the fastest way to try it, demo it, or serve a small team. Everything (control plane,
operator, assistants, database) runs in one lightweight Kubernetes node.

## On your laptop

The bundled local test script spins up a local [k3d](https://k3d.io) cluster and
installs the full stack:

```bash
# 1. Start a k3d cluster
k3d cluster create opencrane --agents 1 --port "8080:80@loadbalancer"

# 2. Bootstrap the full local stack
libs/k8s-platform/tests/k3d-local.sh
```

That's enough to create assistants and explore the `oc` CLI. Tear it down anytime;
nothing leaves your machine.

## On a VM or VPS

For an always-on single server (a cloud VM, or a box under your desk), use
[k3s](https://k3s.io) — a tiny, production-grade Kubernetes that's perfect for one
node:

```bash
# 1. Install k3s (gives you a one-node cluster + kubectl)
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 2. Install OpenCrane — fleet release (cluster bootstrap + fleet-manager)
apps/fleet-platform/deploy.sh --base-domain <your-domain>

# 3. Install a silo release for your organisation
apps/clustertenant-platform/deploy.sh \
  --base-domain <your-domain> \
  --cluster-tenant <org-name>
```

Point your domain at the server's IP (see [Set up your domain](/guide/dns)) and you
have a real, public deployment on a single host.

::: tip One-command single-tenant install
For a server running exactly one organisation you can use the single-tenant
orchestrator, which runs the fleet pass then the silo pass for you:

```bash
libs/k8s-platform/deploy-single-tenant.sh \
  --base-domain <your-domain> \
  --org-name <org> --org-owner-email owner@example.com
```
:::

::: tip When to move to a cluster
A single machine is great up to a point. When you need high availability, more
capacity, or auto-scaling, the same deploy scripts work on a managed Kubernetes
cluster — see [Cluster deployment](/guide/deploy-cluster).
:::

## Next

→ **[Set up your domain](/guide/dns)** → **[Create your first assistant](/guide/first-tenant)**
