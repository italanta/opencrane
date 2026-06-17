# DNS configuration

This is the operator-facing companion to **[Set up your domain](/guide/dns)**. The guide
walks an admin through the happy path; this page documents the model, the full API/CLI
surface, the cert-manager resources OpenCrane creates, and the per-provider and
multi-instance options.

## The model: delegate once, manage from the platform

OpenCrane is designed so DNS is a **one-time delegation** at your provider, after which
every assistant is reachable with no further record changes:

| Step | Where | How often |
|------|-------|-----------|
| Apex `A`/`CNAME` → ingress address | your DNS provider | once |
| Wildcard `*.<zone>` `A`/`CNAME` → ingress address | your DNS provider | once |
| `oc platform dns set …` (provider token for DNS-01) | the platform | once |
| New assistant `alice.<zone>` resolves **and** gets HTTPS | automatic | every assistant, zero touch |

Two records and one token, set once. The provider stays the source of truth for the
*delegation*; the platform owns everything underneath it.

### Why a wildcard

A wildcard record (`*.<zone>`) resolves **every** name at that level to the cluster
ingress address, so `alice.<zone>`, `bob.<zone>` and any future assistant resolve the
moment they are created — without adding a record per assistant. All names land on the
same ingress; the ingress controller then routes by the HTTP `Host:` header to the right
tenant. DNS gets the request to the cluster; the ingress decides *which* assistant.

### Why a provider token is still needed

The wildcard solves **routing**, but HTTPS needs a certificate valid for the name in the
browser. OpenCrane issues a single wildcard certificate (`*.<zone>`) via Let's Encrypt,
and a wildcard certificate can only be validated with the **ACME DNS-01 challenge** —
cert-manager must briefly create a `_acme-challenge.<zone>` `TXT` record. The provider
token you supply is used for **exactly that, and only that**: writing and removing that
temporary validation record. cert-manager then auto-renews the certificate (~every 60
days) using the same token. Per-assistant Ingresses reference the shared wildcard cert
Secret, so adding an assistant needs no new issuance.

::: tip This page is about the wildcard model
Programmatic, record-level management (real per-host `A`/`CNAME` records, custom/vanity
domains, dropping the wildcard) is an `external-dns` extension that reuses the same
provider token. It is an open decision — see the DNS-ownership item in
[Hosting & deployment](/operators/hosting).
:::

## Configure it

### CLI

```bash
oc platform dns set \
  --provider cloudflare \
  --zone ai.example.com \
  --email you@example.com \
  --token-file ./cloudflare-token.txt
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--provider` | yes | DNS-01 solver provider key (`cloudflare`, `digitalocean`, `route53`, `rfc2136`, …) |
| `--zone` | yes | Base/delegated zone the wildcard cert covers (e.g. `ai.example.com`) |
| `--email` | yes | ACME account contact address (renewal notices) |
| `--server` | no | ACME directory URL (defaults to Let's Encrypt production) |
| `--issuer-name` | no | Issuer name to create/update (defaults to `opencrane-issuer`) |
| `--token-file` | no | File holding the provider API token, for token-based providers |
| `--solver-config-file` | no | JSON file with a raw provider solver block, for non-token providers |

The token and solver config are read from **files**, never passed as arguments, so
secrets never land in shell history or process listings.

Inspect the current configuration at any time:

```bash
oc platform dns show
```

### Providers

| Provider | Credential | How to supply |
|----------|-----------|---------------|
| `cloudflare` | scoped API token | `--token-file` |
| `digitalocean` | API token | `--token-file` |
| `route53` | IAM keys / role | `--solver-config-file` |
| `rfc2136` | TSIG key | `--solver-config-file` |

Token-based providers (`cloudflare`, `digitalocean`) store the token in a Secret the
solver references. Any other provider supplies its solver block verbatim via
`--solver-config-file` — a JSON object rendered under the provider key. For example, an
`rfc2136` solver config:

```json
{
  "nameserver": "10.0.0.53:53",
  "tsigKeyName": "opencrane-key",
  "tsigAlgorithm": "HMACSHA256",
  "tsigSecretSecretRef": { "name": "rfc2136-tsig", "key": "tsig-secret" }
}
```

The token must be scoped to **edit the delegated zone only** — DNS-01 needs nothing more
than creating and removing `TXT` records in that zone.

## API surface

The CLI is a thin client over a platform-admin endpoint mounted at
`/api/v1/platform/dns` (behind the auth middleware). It is API-first: the CLI is one
client, not a privileged path.

### `PUT /api/v1/platform/dns`

Capture a provider config and apply the cert-manager issuer (+ credentials Secret).

```json
{
  "provider": "cloudflare",
  "zone": "ai.example.com",
  "email": "you@example.com",
  "server": null,
  "issuerName": "opencrane-issuer",
  "apiToken": "<token>",
  "solverConfig": null
}
```

`provider`, `zone` and `email` are required. On success it returns the applied summary:

```json
{
  "status": "configured",
  "issuerName": "opencrane-issuer",
  "issuerKind": "ClusterIssuer",
  "issuerNamespace": null,
  "provider": "cloudflare",
  "zone": "ai.example.com",
  "secretName": "opencrane-dns01-cloudflare"
}
```

| Status | When |
|--------|------|
| `400` `VALIDATION_ERROR` | `provider`, `zone` or `email` missing |
| `422` `DNS_PROVIDER_MISCONFIGURED` | token-based provider with no token, or non-token provider with no solver block |

### `GET /api/v1/platform/dns`

Report the configured issuer (non-secret fields only). Optional `issuerName` query
parameter selects which issuer to inspect.

```json
{
  "configured": true,
  "issuerName": "opencrane-issuer",
  "issuerKind": "ClusterIssuer",
  "issuerNamespace": null,
  "provider": "cloudflare",
  "email": "you@example.com",
  "server": "https://acme-v02.api.letsencrypt.org/directory"
}
```

When no issuer exists (or the cert-manager CRDs are not installed) it returns
`configured: false`. Auth and permission errors are **not** masked as unconfigured — only
a genuine 404 reports `configured: false`.

## What gets created in the cluster

`PUT` idempotently upserts two resources (create, or replace on conflict, so a rotated
token takes effect on re-apply):

1. **A credentials Secret** — `opencrane-dns01-<provider>` (token-based providers only),
   holding the provider token under the `api-token` key.
2. **A cert-manager issuer** — an ACME DNS-01 issuer referencing that Secret (or the raw
   solver block). cert-manager then issues/renews the wildcard `*.<zone>` certificate
   into the Secret that per-tenant Ingresses reference (`ingress.tls.secretName`,
   default `opencrane-wildcard-tls`).

The certificate appearing in the wildcard Secret happens on a live cluster with real DNS;
this endpoint's job is to author and apply the two resources correctly.

## Issuer kind: single vs multi-instance

The issuer kind is environment-driven, so the same code serves a single install and
multiple instances sharing one cluster:

| Env var | Default | Effect |
|---------|---------|--------|
| `PLATFORM_DNS_ISSUER_KIND` | `ClusterIssuer` | `ClusterIssuer` = one cluster-wide issuer (solver Secret in the cert-manager namespace). `Issuer` = a per-instance namespaced issuer, so two instances never fight over one cluster-singleton. |
| `PLATFORM_DNS_ISSUER_NAMESPACE` | the pod's `NAMESPACE` | Namespace for a namespaced `Issuer` and its solver Secret (ignored for `ClusterIssuer`). |
| `CERT_MANAGER_NAMESPACE` | `cert-manager` | Namespace a cluster-wide `ClusterIssuer`'s solver Secret is written to. |

In multi-instance mode the Helm chart wires `PLATFORM_DNS_ISSUER_KIND=Issuer`. See
[Running multiple instances](/advanced/multi-instance).

## Local and dev installs

On a laptop install you can skip all of this — local mode does not need real DNS or public
certificates, and dev uses `sslip.io`-style hosts that resolve without a provider.

## See also

- [Set up your domain](/guide/dns) — the step-by-step admin walkthrough
- [Hosting & deployment](/operators/hosting) — ingress class, providers, the external-dns decision
- [Running multiple instances](/advanced/multi-instance) — namespaced issuers
- [CLI reference](/reference/cli) · [API overview](/reference/api-overview)
