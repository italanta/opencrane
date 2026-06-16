# Local, VM or VPS

Run all of OpenCrane on a **single machine** — your laptop, a VM, or a VPS.
Everything (control plane, operator, assistants, database) runs in one lightweight
Kubernetes node. Great for trying it out, a demo, or a small team.

Two paths: a throwaway cluster on your **laptop**, or an always-on **VM/VPS**.

---

## Option A — Laptop (k3d)

A disposable local cluster. Nothing leaves your machine.

**You'll need:** [Docker](https://docs.docker.com/get-docker/), `kubectl`, `helm`,
and [`k3d`](https://k3d.io). **You configure:** nothing.

**Steps**

```bash
# 1. From the repo root — creates a k3d cluster and installs the full stack
./platform/install.sh local
```

```bash
# 2. Reach the control plane (no public domain locally — port-forward it)
kubectl -n opencrane-system port-forward svc/opencrane-control-plane 8080:80

# 3. Point the CLI at it
export OPENCRANE_URL=http://localhost:8080
export OPENCRANE_TOKEN=<token>      # see "Get an access token" below
oc auth me
```

Add `--profile strict` to validate prod-style chart inputs locally. Tear down with
`k3d cluster delete opencrane-local`.

---

## Option B — VM or VPS (k3s)

An always-on, public deployment on one Linux host, using
[k3s](https://k3s.io) (a tiny production-grade Kubernetes).

::: tip What you need to configure
- A **Linux host** with a public IP, and `sudo` + `helm` on it.
- A **domain** you control (e.g. `opencrane.example.com`).
- Two **DNS records** pointing at the host's IP (step 3).
- The host's **firewall** open on ports **80 and 443**.
:::

**Steps**

```bash
# 1. Get the code on the host
git clone https://github.com/italanta/opencrane.git && cd opencrane

# 2. Install k3s + OpenCrane in one go
sudo ./platform/vps-deploy.sh --domain opencrane.example.com
```

What step 2 does: installs k3s (one-node cluster, with its built-in `local-path`
storage and Traefik ingress), then installs in-cluster PostgreSQL, the OpenCrane
chart, and runs database migrations.

```text
# 3. Add these DNS records at your registrar, both → the host's public IP:
#    opencrane.example.com        A    <host-ip>      (the control plane)
#    *.opencrane.example.com      A    <host-ip>      (each assistant's subdomain)
```

```bash
# 4. Confirm the control plane is reachable
curl -fsS https://admin.opencrane.example.com/healthz
```

For HTTPS/certificates, see [Set up your domain](/guide/dns).

::: tip When to move to a cluster
A single machine is great up to a point. When you need high availability, more
capacity, or auto-scaling, the **same install** works on a managed cluster — see
[Cluster deployment](/guide/deploy-cluster).
:::

---

## Get an access token

Admin actions use a bearer token. Mint one against the running control plane:

```bash
oc tokens create --name bootstrap     # or: kubectl create token … for the SA
```

(On first run, follow your control plane's documented bootstrap-token step.)

## Next

→ **[Set up your domain](/guide/dns)** → **[Create your first assistant](/guide/first-tenant)**
→ then **[choose a model provider](/guide/budgets)** (`oc providers set …`).
