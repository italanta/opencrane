# Install OpenCrane

OpenCrane runs on a Kubernetes cluster you control. This page gets it running. Don't
worry if you're not a Kubernetes expert — the defaults do the heavy lifting.

## Try it on your laptop first

The quickest way to kick the tyres, with everything bundled in:

```bash
./platform/install.sh local
```

That's enough to create assistants and explore the `oc` command-line tool locally.
When you're ready for real users, install it on a cluster.

## Install on a cluster

```bash
helm install opencrane platform/helm \
  --set ingress.domain=opencrane.example.com \
  --set controlPlane.database.existingSecret=opencrane-db
```

`ingress.domain` is **your OpenCrane address**. Your control plane lives at the top
(`admin.opencrane.example.com`) and each person's assistant gets its own subdomain,
like `alice.opencrane.example.com`.

For storage, cloud, and other options, see [Hosting & deployment](/operators/hosting).

## Connect the command-line tool

Everything in these guides uses `oc`. Point it at your control plane:

```bash
export OPENCRANE_URL=https://admin.opencrane.example.com
export OPENCRANE_TOKEN=<your-access-token>

oc auth me        # confirms you're connected
```

## Next: set up your domain

Because every assistant gets its own subdomain, the next step is pointing your domain
name at OpenCrane and turning on HTTPS.

→ **[Set up your domain](/guide/dns)**
