# DNS configuration

This is the operator-facing companion to **[Set up your domain](/guide/dns)**. The guide
walks an admin through the happy path; this page documents the model, the full API/CLI
surface, the cert-manager resources OpenCrane creates, and the per-provider and
multi-instance options.

## The model: one platform wildcard, one host per org

OpenCrane uses **one base domain** (`<base>`, e.g. `weownai.eu`) and a single platform
wildcard `*.<base>`. The wildcard's DNS record and TLS certificate are set up **once, at
install**, and that is the only DNS work the platform needs: a new org adds **no** DNS
record and **no** certificate.

| Name | Where it points | Set how often |
|------|-----------------|---------------|
| Control-plane host `platform.<base>` → ingress | platform DNS | once, at install |
| Apex `<base>` → ingress | platform DNS | once, at install |
| Platform wildcard `*.<base>` → ingress (resolves **every org host** `<org>.<base>`) | platform DNS | once, at install |
| New org `acme.<base>` resolves **and** gets HTTPS | — | automatic, zero DNS work |

Each org is served at its **own single host** `<org>.<base>` (e.g. `acme.weownai.eu`).
Because that host is one label under the base, the platform wildcard `*.<base>` already
covers both its DNS and its TLS — so there is **no per-org record and no per-org
certificate**.

There are **no per-user subdomains**. Every user in an org connects through that one org
host; an in-cluster **identity-routing proxy** authenticates the session (via the control
plane's `/auth/gateway-resolve`) and reverse-proxies each user's gateway WebSocket to their
own pod. The app UI, `/api/*`, and the gateway WS are all served same-origin under
`<org>.<base>`. See **[Connection security](/security/connection-security)** for the proxy
and its anti-CSWSH controls.

```
                              *.weownai.eu  (one wildcard: DNS + TLS, set once)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
   platform.weownai.eu        acme.weownai.eu             beta.weownai.eu
   (control plane)            (org "acme")                (org "beta")
                                    │                            │
                          identity-routing proxy  ── routes each session ──▶ that user's pod
```

### Why a provider token is still needed (the platform wildcard)

The platform `*.<base>` certificate is a **wildcard**, and a wildcard can only be validated
with the **ACME DNS-01 challenge** — cert-manager briefly creates a `_acme-challenge.<zone>`
`TXT` record. The provider token you supply is used for **exactly that, and only that**:
writing and removing that temporary validation record for the one platform wildcard.
cert-manager then auto-renews (~every 60 days) using the same token. Per-org hosts ride this
same wildcard cert, so they need **no** DNS-01 and **no** token of their own.

### Optional: a customer-vanity domain (CNAME)

A customer who wants their **own** domain (e.g. `ai.client-company.com`) does **not**
delegate or transfer it — they add a single `CNAME` at their own provider pointing it at
their org host:

```
# At the customer's DNS provider, for org "acme" on base "weownai.eu":
ai.client-company.com.   CNAME   acme.weownai.eu.
```

Then set the org's `vanityDomain` (`oc cluster-tenant update acme --vanity-domain
ai.client-company.com`, or the `vanityDomain` field on the API). OpenCrane issues a small
**per-org certificate** whose only SAN is the vanity host, so it is browser-trusted. Because
the CNAME resolves to the ingress, that certificate is issued by the ordinary **HTTP-01**
challenge — no DNS-01 and no access to the customer's DNS. The vanity domain is an
**overlay**: the org is always also reachable at its canonical `<org>.<base>` host.

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
| `--zone` | yes | The platform wildcard **base** the cert covers (e.g. `weownai.eu`) — every org is served at `<org>.<base>` under it |
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
   solver block). cert-manager then issues/renews the **platform** wildcard `*.<base>`
   certificate (plus the apex and the control-plane host) into the Secret the chart
   references (`ingress.tls.secretName`, default `opencrane-wildcard-tls`).

This authorises the issuer **on the zone** and issues the one platform wildcard. Per **org**
nothing more is needed — `<org>.<base>` rides the platform `*.<base>` cert. The only per-org
certificate is for a **customer-vanity** host, which the cluster-tenants operator issues via
HTTP-01 (see "Optional: a customer-vanity domain" above). The certificate appearing in a
Secret happens on a live cluster with real DNS; this endpoint's job is to author and apply
the issuer + Secret correctly.

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
- [Hosting & deployment](/operators/hosting) — ingress class and providers
- [Connection security](/security/connection-security) — the identity-routing gateway proxy
- [Running multiple instances](/advanced/multi-instance) — namespaced issuers
- [CLI reference](/reference/cli) · [API overview](/reference/api-overview)
