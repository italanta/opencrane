# Set up your domain

Every employee assistant gets its own web address — `alice.opencrane.example.com`,
`bob.opencrane.example.com`, and so on. To make that work (with HTTPS), you point a
domain at OpenCrane and let it handle certificates.

You do this once.

## 1. Point your domain at OpenCrane

Add two DNS records at your domain provider, both pointing at your cluster's ingress
address:

| Record | Example | Purpose |
|--------|---------|---------|
| Apex | `opencrane.example.com` | The control plane |
| Wildcard | `*.opencrane.example.com` | Every assistant's subdomain |

The wildcard is what lets a new assistant appear at its own address instantly,
without you touching DNS again.

## 2. Turn on automatic HTTPS

OpenCrane issues a wildcard TLS certificate for you using Let's Encrypt. Because the
certificate is a wildcard, it's validated through your DNS provider — so OpenCrane
needs permission to create a temporary verification record. Give it that with one
command:

```bash
oc platform dns set \
  --provider cloudflare \
  --zone opencrane.example.com \
  --email you@example.com \
  --token-file ./cloudflare-token.txt
```

- `--provider` — your DNS host (`cloudflare`, `route53`, `digitalocean`, …)
- `--zone` — the domain being secured
- `--email` — where Let's Encrypt sends renewal notices
- `--token-file` — a file holding an API token scoped to edit that zone

Check it anytime:

```bash
oc platform dns show
```

Certificates renew automatically from here on.

::: tip Just testing locally?
On a laptop install you can skip all of this — local mode doesn't need real DNS or
public certificates.
:::

## Next

Your domain is ready. → **[Create your first employee assistant](/guide/first-tenant)**
