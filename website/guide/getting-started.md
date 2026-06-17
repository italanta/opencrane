# Install OpenCrane

OpenCrane is **plain Kubernetes**. If you can run a Kubernetes cluster, you can run
OpenCrane — there's no special cloud dependency. Pick the path that fits you:

| Path | Best for | Guide |
|------|----------|-------|
| **Local, VM or VPS** | Trying it out, a demo, or a small team on a single machine | [Local, VM or VPS →](/guide/deploy-local) |
| **Cluster** | Production, scale, high availability | [Cluster deployment →](/guide/deploy-cluster) |

Both install the same way — the only difference is the size and shape of the
Kubernetes underneath.

## Connect the command-line tool

However you deploy, everything in these guides uses the `oc` CLI. Point it at your
control plane:

```bash
export OPENCRANE_URL=https://<your-domain>
export OPENCRANE_TOKEN=<your-access-token>

oc auth me        # confirms you're connected
```

## Then

1. **[Set up your domain](/guide/dns)** — point DNS at OpenCrane and turn on HTTPS.
2. **[Create your first assistant](/guide/first-tenant)**.
3. **[Connect to OpenClaw](/guide/connect)**.
