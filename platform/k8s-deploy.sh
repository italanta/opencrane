#!/usr/bin/env bash
# =============================================================================
# OpenCrane — install onto ANY Kubernetes cluster
#
# Installs OpenCrane onto the cluster your current kubectl context points at:
# CloudNativePG (in-cluster PostgreSQL) → secrets → the OpenCrane Helm chart →
# DB migrations. Uses the published ghcr.io/opencrane images and the cluster's
# default StorageClass — pure, provider-agnostic Kubernetes.
#
# This is the shared core. vps-deploy.sh and gke-deploy.sh provision a cluster
# and then call this script.
#
# Usage:
#   ./platform/k8s-deploy.sh [--base-domain DOMAIN] [--namespace NS] [--release NAME]
#                            [--image-tag TAG] [--storage-class SC]
#                            [--control-plane-tag TAG] [--operator-tag TAG]
#                            [--tenant-tag TAG]
#                            [--oidc-issuer-url URL] [--oidc-client-id ID]
#                            [--oidc-redirect-uri URI] [--oidc-client-secret SECRET]
#                            [--oidc-session-secret SECRET]
#                            [--platform-operator-seed-email EMAIL]
#                            [--preflight]
#                            [--no-ingress-nginx]
#                            [--no-external-dns]
#                            [--cert-manager] [--acme-email EMAIL]
#                            [--dns01-provider clouddns] [--dns01-credentials FILE]
#                            [--dns01-project PROJECT_ID] [--dns-writer-gsa EMAIL]
#                            [--values FILE] [--set k=v ...]
#
# TLS / cert-manager (Step 2.5) has THREE modes:
#   off (default)  — no cert-manager install; the chart renders no issuer/cert.
#                    Use when TLS is terminated elsewhere (LB, external ingress).
#   selfSigned     — `--cert-manager` alone. Installs cert-manager and a self-signed
#                    ClusterIssuer. Issues instantly, no DNS challenge, NOT browser-
#                    trusted. For dev / k3d / bare-IP clusters.
#   acme (DNS-01)  — `--cert-manager --acme-email you@org --dns01-provider clouddns
#                    [--dns01-credentials FILE]`. Installs cert-manager, waits on the
#                    webhook, runs a DNS-01 preflight that FAILS FAST with the exact
#                    remediation, then issues a browser-trusted wildcard via Let's
#                    Encrypt. Wildcards REQUIRE DNS-01 (HTTP-01 cannot issue them).
#                    On GKE Workload Identity pass --dns-writer-gsa EMAIL (Terraform output
#                    dns_writer_service_account_email): the cert-manager + external-dns
#                    controller SAs are annotated with this SHARED GSA, which must already be
#                    bound roles/dns.admin. For an external zone pass a SA-key file via
#                    --dns01-credentials instead (a Secret is created in the cert-manager NS).
#
# This step installs only the PLATFORM-WILDCARD issuer + cert. Per-org certs are a
# runtime concern of the ClusterTenant reconciler, NOT an install concern.
#
# --base-domain is the platform org-wildcard BASE domain (e.g. dev.opencrane.ai). It is
# a first-class, VALIDATED install input (lowercase FQDN, ≥2 labels) that drives a single
# source of truth: the chart's ingress.domain, the derived controlPlaneHost
# (platform.<base-domain>), the cert-manager wildcard SANs (*.<domain>, <domain>,
# controlPlaneHost), and the operator's per-org domain provisioning. NEVER hardcode a
# real domain in the repo. `--domain` remains a backwards-compatible alias; acme TLS
# REQUIRES --base-domain (a wildcard for *.<empty> is meaningless).
#
# Bundled cluster singletons (default ON, auto-skip if already present):
#   ingress-nginx — the ingress controller (skip with --no-ingress-nginx to BYO one).
#   external-dns  — the DNS-record controller (skip with --no-external-dns to BYO one).
#                   The operator emits namespaced DNSEndpoint CRs; external-dns (run with
#                   --source=crd) reconciles them into Google Cloud DNS, scoped to
#                   --base-domain, against the SAME managed zone as the cert-manager
#                   DNS-01 solver. It needs zone write access → it SHARES the cert-manager
#                   DNS-01 credentials: Workload Identity (the cert-manager SA's GSA bound
#                   roles/dns.admin) by default, or the --dns01-credentials SA-key file for
#                   an external zone. external-dns is only bundled in acme/clouddns mode
#                   (that is where the shared zone + WI binding are established).
#   Cognee        — the required graph-RAG service, installed IN-CHART via
#                   controlPlane.cognee.install=true (set false to BYO an external one).
# Each is gated by a `*.install` flag SEPARATE from the chart's `*.enabled`, so an
# operator can bring their own while the chart still wires against it.
#
# The platform-operator seed email bootstraps the FIRST platform operator: the
# caller whose VERIFIED OIDC email equals it becomes a platform operator. It is a
# per-cluster INSTALL parameter — DEFAULTS TO EMPTY, which grants operator to
# nobody (fail-closed). Also accepted via the OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL
# env var. Never commit a real owner email into the repo.
#
# --image-tag pins all three platform images (control-plane, operator, tenant)
# to the same tag. To roll a SINGLE component to a different build, pass the
# matching per-component flag (e.g. --control-plane-tag sha-abc123); it overrides
# --image-tag for that component only. ALWAYS bump component images this way —
# never `kubectl set image` / `kubectl patch` a managed deployment. An imperative
# patch creates a `kubectl-*` field manager that owns the image field on the live
# object and makes every later `helm upgrade` fail with a field-ownership conflict.
#
# Prereqs: kubectl (pointed at the target cluster) and helm.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$SCRIPT_DIR/helm"

NAMESPACE="opencrane-system"
RELEASE="opencrane"
IMAGE_TAG="latest"
CONTROL_PLANE_TAG=""    # empty → falls back to IMAGE_TAG
OPERATOR_TAG=""         # empty → falls back to IMAGE_TAG
TENANT_TAG=""           # empty → falls back to IMAGE_TAG
# --base-domain (canonical) is the platform org-wildcard BASE domain for this install
# (e.g. dev.opencrane.ai). It drives the chart's ingress.domain + the derived
# controlPlaneHost (platform.<base-domain>), the cert-manager wildcard SANs, and the
# operator's per-org provisioning. NEVER hardcode a real domain in the repo — it is a
# per-install input. `--domain` is kept as a backwards-compatible alias. Also accepts
# OPENCRANE_BASE_DOMAIN so the wizard / CI can supply it off the command line.
BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
STORAGE_CLASS=""        # empty → cluster default StorageClass
VALUES_FILE=""
REUSE_VALUES=""      # "--reuse-values" mode: inherit current helm values; add only overrides
EXTRA_SET=()

# OIDC + per-cluster operator bootstrap. All default empty (OIDC stays disabled and the
# seed grants operator to nobody — fail-closed). The seed also accepts an env var so a
# secret manager / CI can supply it without it appearing on the command line.
OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI:-}"
# OIDC client secret (the confidential-client secret from the IdP). Accepted via flag or
# env so it never has to sit in a values file. When OIDC is configured this installer
# CREATES the K8s Secret the chart references (client secret + an auto-generated session
# secret) and wires controlPlane.oidc.existingSecret — previously the secret was ASSUMED
# to already exist, so a fresh OIDC install rendered a control-plane that crash-looped on a
# missing Secret. The session secret signs login cookies; we generate one when not supplied.
OIDC_CLIENT_SECRET="${OPENCRANE_OIDC_CLIENT_SECRET:-${OIDC_CLIENT_SECRET:-}}"
OIDC_SESSION_SECRET="${OPENCRANE_OIDC_SESSION_SECRET:-${OIDC_SESSION_SECRET:-}}"
OIDC_SECRET_NAME="opencrane-oidc"
PLATFORM_OPERATOR_SEED_EMAIL="${OPENCRANE_PLATFORM_OPERATOR_SEED_EMAIL:-}"

# cert-manager / TLS (Step 2.5). CERT_MANAGER stays off unless --cert-manager is given;
# the mode is then selfSigned UNLESS an --acme-email + --dns01-provider promote it to
# acme. ACME_EMAIL / DNS01_PROVIDER also accept env vars so CI/secret managers can
# supply them off the command line. DNS01_CREDENTIALS is a path to a SA-key JSON used
# only for an EXTERNAL DNS zone (Workload Identity needs no file — see _preflight_dns01).
# OPENCRANE_CERT_MODE (off|selfSigned|acme) lets the wizard preset the mode without the
# CLI flag; "off" leaves CERT_MANAGER off, anything else turns it on (acme is then driven
# by the email/provider env below). Direct callers just use --cert-manager / --acme-email.
case "${OPENCRANE_CERT_MODE:-off}" in
  off) CERT_MANAGER="off" ;;
  *)   CERT_MANAGER="on" ;;
esac
ACME_EMAIL="${OPENCRANE_ACME_EMAIL:-${ACME_EMAIL:-}}"
DNS01_PROVIDER="${OPENCRANE_DNS01_PROVIDER:-${DNS01_PROVIDER:-}}"
DNS01_CREDENTIALS="${OPENCRANE_DNS01_CREDENTIALS:-${DNS01_CREDENTIALS:-}}"
# GCP project that hosts the Cloud DNS zone for --base-domain. cert-manager's clouddns
# solver requires a project (under BOTH Workload Identity and an external SA key), so it
# is required in acme/clouddns mode. Defaults from the gcloud active project when unset.
DNS01_PROJECT="${OPENCRANE_DNS01_PROJECT:-${DNS01_PROJECT:-}}"
CERT_MANAGER_NAMESPACE="cert-manager"

# ingress-nginx bundling (a cluster singleton like cert-manager). Installed by default
# so a fresh cluster gets a working ingress class with no extra step; auto-skips when a
# controller is already present. `--no-ingress-nginx` (or OPENCRANE_INSTALL_INGRESS_NGINX=0)
# turns the bundling off to BYO a controller. This is SEPARATE from the chart's
# ingress.enabled (whether Ingress objects render) — see values.yaml `ingressNginx`.
INSTALL_INGRESS_NGINX="${OPENCRANE_INSTALL_INGRESS_NGINX:-1}"
INGRESS_NGINX_NAMESPACE="ingress-nginx"

# external-dns bundling (a cluster singleton like ingress-nginx / cert-manager). The
# operator emits namespaced DNSEndpoint CRs and external-dns (--source=crd) reconciles
# them into Google Cloud DNS, scoped to --base-domain, against the SAME managed zone as
# the cert-manager DNS-01 solver and SHARING its zone-write credentials (WI roles/dns.admin
# or the --dns01-credentials SA key). Installed by default, auto-skips when a controller is
# already present. `--no-external-dns` (or OPENCRANE_INSTALL_EXTERNAL_DNS=0) turns the
# bundling off to BYO a controller. SEPARATE from the chart's externalDns.enabled (whether
# the operator declares DNSEndpoint CRs at all) — see values.yaml `externalDns`. Only
# bundled in acme/clouddns mode, which is where the shared zone + WI binding are set up.
INSTALL_EXTERNAL_DNS="${OPENCRANE_INSTALL_EXTERNAL_DNS:-1}"
EXTERNAL_DNS_NAMESPACE="external-dns"
# The shared DNS-writer Google service account (Terraform `dns` module output
# dns_writer_service_account_email) external-dns + the cert-manager DNS-01 solver impersonate
# via Workload Identity. On GKE the controller's KSA must carry the annotation
# `iam.gke.io/gcp-service-account=<this>` to complete the WI handshake — Terraform creates the
# binding, but the KSA annotation is an install-time concern. Required for the WI path (no
# --dns01-credentials) on GKE; ignored for the external-SA-key path. Also OPENCRANE_DNS_WRITER_GSA.
DNS_WRITER_GSA="${OPENCRANE_DNS_WRITER_GSA:-${DNS_WRITER_GSA:-}}"

# --preflight runs a fail-FAST environment check BEFORE any cluster mutation and exits 0/1
# without installing. It catches the failures that otherwise surface as a half-installed,
# crash-looping cluster: no default StorageClass (every PVC pends), a CNI that silently
# ignores NetworkPolicy (the isolation model is a no-op), unpullable first-party images,
# a base domain whose NS delegation does not resolve (acme orders + external-dns hang), and
# a missing DNS-write capability shared by external-dns + cert-manager. Also via
# OPENCRANE_PREFLIGHT=1. It is advisory unless run — the install itself does not auto-run it.
PREFLIGHT="${OPENCRANE_PREFLIGHT:-0}"

# --auto-ingress-ip derives ingress.externalIp from the ingress-nginx LoadBalancer after
# it is installed (so per-org *.<domain> A records resolve without hand-copying the IP).
# Opt-in; an explicit ingress.externalIp --set always wins. Also via OPENCRANE_AUTO_INGRESS_IP=1.
AUTO_INGRESS_IP="${OPENCRANE_AUTO_INGRESS_IP:-0}"
# --verify runs an advisory post-deploy check (pods Running, DNSEndpoints present, external-dns
# error-free, control-plane host resolves). Never fails the install. Also via OPENCRANE_VERIFY=1.
VERIFY="${OPENCRANE_VERIFY:-0}"

DB_CLUSTER="opencrane-db"
DB_SECRET="opencrane-db"
DB_USER="opencrane"
DB_NAME="opencrane"
TIMEOUT="${TIMEOUT_SECONDS:-300}"

log()  { echo -e "\033[0;32m[k8s-deploy]\033[0m $1"; }
warn() { echo -e "\033[1;33m[k8s-deploy]\033[0m $1"; }
err()  { echo -e "\033[0;31m[k8s-deploy]\033[0m $1" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-domain)   BASE_DOMAIN="$2"; shift 2 ;;
    --domain)        BASE_DOMAIN="$2"; shift 2 ;;  # backwards-compatible alias
    --namespace)     NAMESPACE="$2"; shift 2 ;;
    --release)       RELEASE="$2"; shift 2 ;;
    --image-tag)        IMAGE_TAG="$2"; shift 2 ;;
    --control-plane-tag) CONTROL_PLANE_TAG="$2"; shift 2 ;;
    --operator-tag)     OPERATOR_TAG="$2"; shift 2 ;;
    --tenant-tag)       TENANT_TAG="$2"; shift 2 ;;
    --storage-class) STORAGE_CLASS="$2"; shift 2 ;;
    --oidc-issuer-url)     OIDC_ISSUER_URL="$2"; shift 2 ;;
    --oidc-client-id)      OIDC_CLIENT_ID="$2"; shift 2 ;;
    --oidc-redirect-uri)   OIDC_REDIRECT_URI="$2"; shift 2 ;;
    --oidc-client-secret)  OIDC_CLIENT_SECRET="$2"; shift 2 ;;
    --oidc-session-secret) OIDC_SESSION_SECRET="$2"; shift 2 ;;
    --platform-operator-seed-email) PLATFORM_OPERATOR_SEED_EMAIL="$2"; shift 2 ;;
    --preflight)        PREFLIGHT="1"; shift ;;
    --auto-ingress-ip)  AUTO_INGRESS_IP="1"; shift ;;
    --verify)           VERIFY="1"; shift ;;
    --no-ingress-nginx) INSTALL_INGRESS_NGINX="0"; shift ;;
    --no-external-dns)  INSTALL_EXTERNAL_DNS="0"; shift ;;
    --dns-writer-gsa)   DNS_WRITER_GSA="$2"; shift 2 ;;
    --cert-manager)  CERT_MANAGER="on"; shift ;;
    --acme-email)    ACME_EMAIL="$2"; shift 2 ;;
    --dns01-provider)    DNS01_PROVIDER="$2"; shift 2 ;;
    --dns01-credentials) DNS01_CREDENTIALS="$2"; shift 2 ;;
    --dns01-project)     DNS01_PROJECT="$2"; shift 2 ;;
    --values)        VALUES_FILE="$2"; shift 2 ;;
    --reuse-values)  REUSE_VALUES="1"; shift ;;
    --set)           EXTRA_SET+=(--set "$2"); shift 2 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               err "Unknown flag: $1"; exit 1 ;;
  esac
done

for c in kubectl helm; do command -v "$c" >/dev/null 2>&1 || { err "Missing required command: $c"; exit 1; }; done
kubectl cluster-info >/dev/null 2>&1 || { err "kubectl can't reach a cluster. Point your context at the target cluster first."; exit 1; }

# --base-domain validation. When supplied it must be a syntactically valid, lowercase
# FQDN (≥2 labels, no scheme/port/path, no trailing dot) so it can stand in for
# *.<domain> wildcard SANs and <org>.<domain> hosts. ACME wildcard issuance has no
# meaning without it, so acme mode REQUIRES a base domain (fail fast, not a stuck order).
_validate_base_domain() {
  local d="$1"
  if [[ ! "$d" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
    err "Invalid --base-domain '$d'. Expected a lowercase FQDN like 'dev.opencrane.ai' (≥2 labels, no scheme/port/path/trailing dot)."
    exit 1
  fi
}
if [[ -n "$BASE_DOMAIN" ]]; then
  _validate_base_domain "$BASE_DOMAIN"
fi

# --preflight: fail-FAST environment validation, run BEFORE any cluster mutation. Each
# check appends to PF_FAILS; a non-empty list at the end exits 1 with every remediation,
# so the operator fixes the cluster ONCE rather than chasing one half-broken install at a
# time. Read-only against cloud + cluster (never mutates).
_run_preflight() {
  local PF_FAILS=()
  log "Preflight: validating the target environment (no cluster changes will be made)…"

  # 1. Default StorageClass — without one, every PVC (PostgreSQL, tenant storage) pends
  #    forever and the install hangs at "waiting for the database".
  if [[ -z "$STORAGE_CLASS" ]]; then
    if ! kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{end}' 2>/dev/null | grep -q "true"; then
      PF_FAILS+=("No default StorageClass found. Mark one default (kubectl patch storageclass <name> -p '{\"metadata\":{\"annotations\":{\"storageclass.kubernetes.io/is-default-class\":\"true\"}}}') or pass --storage-class.")
    fi
  else
    kubectl get storageclass "$STORAGE_CLASS" >/dev/null 2>&1 || PF_FAILS+=("--storage-class '$STORAGE_CLASS' does not exist on the cluster.")
  fi

  # 2. NetworkPolicy-enforcing CNI — the platform's isolation model is built on
  #    NetworkPolicy; a CNI that silently ignores them (e.g. stock kindnet/flannel) makes
  #    every default-deny a no-op. We probe for a known enforcing CNI DaemonSet.
  if ! kubectl get ds -n kube-system -o name 2>/dev/null | grep -qiE "calico|cilium|weave|antrea|kube-router"; then
    PF_FAILS+=("No NetworkPolicy-enforcing CNI detected (looked for calico/cilium/weave/antrea/kube-router in kube-system). The platform's NetworkPolicy isolation is a NO-OP on a non-enforcing CNI. Install an enforcing CNI (GKE: enable Dataplane V2 / network-policy).")
  fi

  # 3. First-party images pullable — catch a private/typo'd registry before the rollout
  #    sits in ImagePullBackOff. A best-effort manifest check (skopeo/crane/docker) that
  #    only WARNS if no inspector is available (we never block on a missing local tool).
  local _img="ghcr.io/italanta/control-plane:${CONTROL_PLANE_TAG:-$IMAGE_TAG}"
  if command -v skopeo >/dev/null 2>&1; then
    skopeo inspect "docker://$_img" >/dev/null 2>&1 || PF_FAILS+=("First-party image not pullable: $_img (skopeo inspect failed). Check the registry/tag and your pull credentials.")
  elif command -v crane >/dev/null 2>&1; then
    crane manifest "$_img" >/dev/null 2>&1 || PF_FAILS+=("First-party image not pullable: $_img (crane manifest failed). Check the registry/tag and your pull credentials.")
  elif command -v docker >/dev/null 2>&1; then
    docker manifest inspect "$_img" >/dev/null 2>&1 || PF_FAILS+=("First-party image not pullable: $_img (docker manifest inspect failed). Check the registry/tag and your pull credentials.")
  else
    warn "Preflight: no image inspector (skopeo/crane/docker) — skipping the image-pull check."
  fi

  # 4. Registrar NS-delegation for --base-domain — acme orders AND external-dns both hang
  #    if the domain's authoritative name servers are not delegated to the DNS zone. We
  #    only assert it resolves to SOME name servers (an undelegated domain returns none).
  if [[ -n "$BASE_DOMAIN" ]]; then
    if command -v dig >/dev/null 2>&1; then
      [[ -n "$(dig +short NS "$BASE_DOMAIN" 2>/dev/null)" ]] || PF_FAILS+=("No NS delegation resolves for '$BASE_DOMAIN'. Delegate it to your DNS zone's name servers at your registrar (see Terraform output dns_name_servers), or DNS-01 issuance + external-dns will hang.")
    elif command -v host >/dev/null 2>&1; then
      host -t NS "$BASE_DOMAIN" >/dev/null 2>&1 || PF_FAILS+=("No NS delegation resolves for '$BASE_DOMAIN'. Delegate it to your DNS zone's name servers at your registrar, or DNS-01 issuance + external-dns will hang.")
    else
      warn "Preflight: no dig/host — skipping the NS-delegation check for '$BASE_DOMAIN'."
    fi
  fi

  # 5. DNS-write capability — covers BOTH external-dns and the cert-manager DNS-01 solver,
  #    which SHARE one zone-write credential. Only relevant when acme/clouddns is requested
  #    (selfSigned/off write no zone). Acceptable: an external SA-key file (--dns01-credentials)
  #    OR a Workload-Identity GSA bound roles/dns.admin (--dns-writer-gsa, annotating the KSAs).
  #    The check FAILS (never warn-and-pass) when it cannot positively confirm the capability —
  #    a green preflight must mean the actual install will not fail closed on the same input.
  local _is_acme=0
  if [[ "$CERT_MANAGER" == "on" && -n "$ACME_EMAIL" && -n "$DNS01_PROVIDER" ]]; then _is_acme=1; fi
  if [[ "$_is_acme" == "1" ]]; then
    if [[ -n "$DNS01_CREDENTIALS" ]]; then
      [[ -f "$DNS01_CREDENTIALS" ]] || PF_FAILS+=("--dns01-credentials '$DNS01_CREDENTIALS' not found. external-dns + cert-manager DNS-01 share this SA key for zone writes.")
    else
      # Workload-Identity path. The KSAs need the shared DNS-writer GSA to annotate them, so
      # --dns-writer-gsa is required here too (the install fails closed without it).
      if [[ -z "$DNS_WRITER_GSA" ]]; then
        PF_FAILS+=("Workload-Identity DNS writes need the shared DNS-writer GSA. Pass --dns-writer-gsa <gsa>@<project>.iam.gserviceaccount.com (Terraform output dns_writer_service_account_email) so the external-dns + cert-manager KSAs can be annotated, or pass --dns01-credentials for an external zone.")
      fi
      # Workload Identity ENABLED on the cluster — a roles/dns.admin binding is useless if
      # the cluster can't impersonate the GSA. GKE runs the gke-metadata-server DaemonSet in
      # kube-system iff Workload Identity is enabled; its absence is the dead-external-dns
      # root cause (records never written, no auth error — the pod just can't get a token).
      if ! kubectl get ds -n kube-system gke-metadata-server -o name >/dev/null 2>&1; then
        PF_FAILS+=("Workload Identity is NOT enabled on this cluster (no gke-metadata-server DaemonSet in kube-system), so external-dns + cert-manager DNS-01 cannot impersonate the DNS-writer GSA — records silently never get written. Enable it: gcloud container clusters update <cluster> --workload-pool=<project>.svc.id.goog (and node pools --workload-metadata=GKE_METADATA), or pass --dns01-credentials for an external zone.")
      fi
      local _proj="${DNS01_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
      if [[ -z "$_proj" || "$_proj" == "(unset)" ]]; then
        PF_FAILS+=("acme/clouddns DNS-01 needs the GCP project hosting the zone for '$BASE_DOMAIN'. Pass --dns01-project (or set a gcloud active project) so the shared roles/dns.admin binding can be verified.")
      elif command -v gcloud >/dev/null 2>&1; then
        # A roles/dns.admin binding must exist for SOME service account on the project; both
        # external-dns and the cert-manager solver impersonate it via Workload Identity.
        if ! gcloud projects get-iam-policy "$_proj" --flatten="bindings[].members" --format='value(bindings.role)' 2>/dev/null | grep -q "roles/dns.admin"; then
          PF_FAILS+=("No roles/dns.admin binding found on project '$_proj'. Bind it to the shared DNS-writer GSA (external-dns + cert-manager DNS-01 impersonate it): gcloud projects add-iam-policy-binding $_proj --member='serviceAccount:GSA@$_proj.iam.gserviceaccount.com' --role='roles/dns.admin'. Or pass --dns01-credentials for an external zone.")
        fi
      else
        # gcloud absent → we cannot verify the roles/dns.admin binding. FAIL (do not warn-and-pass):
        # a green preflight that hides an unverifiable requirement is worse than a clear blocker.
        PF_FAILS+=("Cannot verify roles/dns.admin on project '$_proj' — gcloud is not installed on this machine. Run the preflight where gcloud is available, or pass --dns01-credentials for an external zone (a file we can check directly).")
      fi
    fi
  fi

  if [[ ${#PF_FAILS[@]} -gt 0 ]]; then
    err "Preflight FAILED — fix these before installing:"
    local i=1
    for f in "${PF_FAILS[@]}"; do err "  $i. $f"; i=$((i+1)); done
    exit 1
  fi
  log "Preflight: all checks passed."
}

if [[ "$PREFLIGHT" == "1" ]]; then
  _run_preflight
  log "Preflight complete (no install performed). Re-run without --preflight to install."
  exit 0
fi

_gen_secret() { openssl rand -hex 16 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32; }
# Re-use existing passwords when secrets already exist so that re-runs don't
# rotate credentials without also updating postgres (which only reads the
# bootstrap secret once at initdb time).
_read_secret() { kubectl get secret "$1" -n "$NAMESPACE" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d || true; }
if [[ -z "${DB_PASSWORD:-}" ]]; then
  DB_PASSWORD="$(_read_secret "${DB_CLUSTER}-creds" password)"
  DB_PASSWORD="${DB_PASSWORD:-$(_gen_secret)}"
fi
if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  LITELLM_MASTER_KEY="$(_read_secret opencrane-litellm LITELLM_MASTER_KEY)"
  LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-$(_gen_secret)}"
fi
# LiteLLM salt encrypts provider keys stored in the DB (STORE_MODEL_IN_DB). It MUST stay
# constant once set, or already-stored keys become unreadable — so always re-use the
# existing value and only generate a fresh one when the secret has none.
if [[ -z "${LITELLM_SALT_KEY:-}" ]]; then
  LITELLM_SALT_KEY="$(_read_secret opencrane-litellm LITELLM_SALT_KEY)"
  LITELLM_SALT_KEY="${LITELLM_SALT_KEY:-sk-$(_gen_secret)}"
fi
# Langfuse stable credentials. SALT, ENCRYPTION_KEY, and API keys MUST remain constant
# after the first deploy — changing them orphans stored trace data and breaks NEXTAUTH
# sessions. Re-use existing values from the secret; only generate fresh ones on first install.
_gen_secret_256() { openssl rand -hex 32 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 64; }
LANGFUSE_NEXTAUTH_SECRET="$(_read_secret opencrane-langfuse NEXTAUTH_SECRET)"
LANGFUSE_NEXTAUTH_SECRET="${LANGFUSE_NEXTAUTH_SECRET:-$(_gen_secret)}"
LANGFUSE_SALT="$(_read_secret opencrane-langfuse SALT)"
LANGFUSE_SALT="${LANGFUSE_SALT:-$(_gen_secret)}"
# ENCRYPTION_KEY must be 256 bits = 64 hex characters.
LANGFUSE_ENCRYPTION_KEY="$(_read_secret opencrane-langfuse ENCRYPTION_KEY)"
LANGFUSE_ENCRYPTION_KEY="${LANGFUSE_ENCRYPTION_KEY:-$(_gen_secret_256)}"
LANGFUSE_PUBLIC_KEY="$(_read_secret opencrane-langfuse LANGFUSE_INIT_PROJECT_PUBLIC_KEY)"
LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-pk-lf-$(_gen_secret | head -c 24)}"
LANGFUSE_SECRET_KEY="$(_read_secret opencrane-langfuse LANGFUSE_INIT_PROJECT_SECRET_KEY)"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-sk-lf-$(_gen_secret | head -c 24)}"
LANGFUSE_ADMIN_PASSWORD="$(_read_secret opencrane-langfuse LANGFUSE_INIT_USER_PASSWORD)"
LANGFUSE_ADMIN_PASSWORD="${LANGFUSE_ADMIN_PASSWORD:-$(_gen_secret)}"
# ClickHouse internal password (stable: changing it after init requires manual CH user management).
LANGFUSE_CH_PASSWORD="$(_read_secret opencrane-langfuse CLICKHOUSE_PASSWORD)"
LANGFUSE_CH_PASSWORD="${LANGFUSE_CH_PASSWORD:-$(_gen_secret)}"
# Bitnami sub-subchart passwords inside the Langfuse chart. Bitnami charts require the
# existing password to be re-supplied on every upgrade; we read-or-generate so the upgrade
# never fails regardless of whether Langfuse is enabled. The values are stable after first
# creation because each is read back from the cluster secret before generating a new one.
LANGFUSE_S3_ROOT_PASSWORD="$(_read_secret opencrane-s3 root-password)"
LANGFUSE_S3_ROOT_PASSWORD="${LANGFUSE_S3_ROOT_PASSWORD:-$(_gen_secret)}"
LANGFUSE_REDIS_PASSWORD="$(_read_secret opencrane-redis valkey-password)"
LANGFUSE_REDIS_PASSWORD="${LANGFUSE_REDIS_PASSWORD:-$(_gen_secret)}"

log "Target cluster: $(kubectl config current-context)"
log "Namespace: $NAMESPACE   Release: $RELEASE   Image tag: $IMAGE_TAG"

# 1. In-cluster PostgreSQL via the CloudNativePG operator.
# If the CNPG cluster already exists but authentication fails (password rotated
# out of sync with the bootstrap secret), wipe and re-bootstrap so all secrets
# and the live DB stay consistent. Runs a throwaway psql pod inside the cluster.
_db_auth_ok() {
  local url="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local:5432/${DB_NAME}"
  kubectl run "db-auth-check-$$" --image=postgres:16 --restart=Never --rm -i \
    -n "$NAMESPACE" --quiet -- psql "$url" -c '\q' >/dev/null 2>&1
}
if kubectl get cluster "$DB_CLUSTER" -n "$NAMESPACE" >/dev/null 2>&1; then
  if ! _db_auth_ok; then
    warn "DB credential mismatch detected (password drifted from bootstrap). Resetting PostgreSQL cluster…"
    kubectl delete cluster "$DB_CLUSTER" -n "$NAMESPACE" --wait=true
    kubectl delete pvc -n "$NAMESPACE" -l cnpg.io/cluster="$DB_CLUSTER" --ignore-not-found
    kubectl delete secret "${DB_CLUSTER}" "opencrane-obot" "opencrane-litellm-db" "opencrane-litellm" "opencrane-langfuse" \
      -n "$NAMESPACE" --ignore-not-found
    # Fresh secrets — regenerate so cluster + secrets are in sync from scratch.
    # The litellm DB is wiped with the PVCs, so a fresh salt is correct (no stored
    # provider keys survive to be decrypted). Langfuse keys are also reset here since
    # the DB (and all stored traces) are wiped along with the CNPG cluster.
    DB_PASSWORD="$(_gen_secret)"
    LITELLM_MASTER_KEY="sk-$(_gen_secret)"
    LITELLM_SALT_KEY="sk-$(_gen_secret)"
    LANGFUSE_NEXTAUTH_SECRET="$(_gen_secret)"
    LANGFUSE_SALT="$(_gen_secret)"
    LANGFUSE_ENCRYPTION_KEY="$(_gen_secret_256)"
    LANGFUSE_PUBLIC_KEY="pk-lf-$(_gen_secret | head -c 24)"
    LANGFUSE_SECRET_KEY="sk-lf-$(_gen_secret | head -c 24)"
    LANGFUSE_ADMIN_PASSWORD="$(_gen_secret)"
    LANGFUSE_CH_PASSWORD="$(_gen_secret)"
  fi
fi

log "Installing CloudNativePG operator…"
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace "$NAMESPACE" --create-namespace --wait \
  --set-string monitoring.podMonitor.enabled=false

log "Creating database credentials…"
kubectl create secret generic "${DB_CLUSTER}-creds" -n "$NAMESPACE" \
  --from-literal=username="$DB_USER" --from-literal=password="$DB_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Provisioning the PostgreSQL cluster…"
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${DB_CLUSTER}
  namespace: ${NAMESPACE}
spec:
  instances: 1
  enablePDB: false
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  # CNPG manages instance pods as bare Pods (not a Deployment/StatefulSet), so the
  # GKE cluster-autoscaler treats them as "not backed by a controller" and refuses to
  # drain the node — blocking scale-down of underutilised nodes (wasted spend on dev).
  # safe-to-evict lets the autoscaler evict the pod; CNPG reschedules it and the
  # operator-managed PodDisruptionBudget still prevents evicting too many instances at
  # once. inheritedMetadata propagates the annotation onto the managed pods.
  inheritedMetadata:
    annotations:
      cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
  storage:
    size: 10Gi$( [[ -n "$STORAGE_CLASS" ]] && printf '\n    storageClass: %s' "$STORAGE_CLASS" )
  bootstrap:
    initdb:
      database: ${DB_NAME}
      secret:
        name: ${DB_CLUSTER}-creds
      postInitApplicationSQL:
        - CREATE DATABASE obot OWNER ${DB_USER};
        - CREATE DATABASE litellm OWNER ${DB_USER};
        - CREATE DATABASE langfuse OWNER ${DB_USER};
EOF

log "Waiting for the database to become ready…"
kubectl wait --for=condition=Ready "cluster/${DB_CLUSTER}" -n "$NAMESPACE" --timeout="${TIMEOUT}s"

# 2. Connection + LiteLLM secrets the chart expects.
DB_HOST="${DB_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local:5432"

kubectl create secret generic "$DB_SECRET" -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/${DB_NAME}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-obot -n "$NAMESPACE" \
  --from-literal=dsn="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/obot" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-litellm-db -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/litellm" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opencrane-litellm -n "$NAMESPACE" \
  --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" \
  --from-literal=LITELLM_SALT_KEY="$LITELLM_SALT_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# Langfuse secret. Contains stable credentials for the in-cluster Langfuse subchart.
# SALT, ENCRYPTION_KEY, and API keys MUST be stable once set (changing them orphans
# existing traces). PostgreSQL password is reused from the CNPG cluster creds secret
# (langfuse.postgresql.auth.existingSecret = <cluster>-creds) so it is NOT duplicated here.
kubectl create secret generic opencrane-langfuse -n "$NAMESPACE" \
  --from-literal=NEXTAUTH_SECRET="$LANGFUSE_NEXTAUTH_SECRET" \
  --from-literal=SALT="$LANGFUSE_SALT" \
  --from-literal=ENCRYPTION_KEY="$LANGFUSE_ENCRYPTION_KEY" \
  --from-literal=CLICKHOUSE_PASSWORD="$LANGFUSE_CH_PASSWORD" \
  --from-literal=LANGFUSE_INIT_PROJECT_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
  --from-literal=LANGFUSE_INIT_PROJECT_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
  --from-literal=LANGFUSE_INIT_USER_PASSWORD="$LANGFUSE_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# OIDC secret. The chart references controlPlane.oidc.existingSecret for the client + session
# secrets; previously this installer set only the issuer/clientId/redirect and ASSUMED the
# Secret already existed, so a fresh OIDC install crash-looped on a missing Secret. Create it
# here when OIDC is configured: the client secret is required (a confidential client can't
# authenticate without it); the session secret signs login cookies and is auto-generated when
# not supplied. Idempotent (dry-run | apply), so re-runs converge.
if [[ -n "$OIDC_ISSUER_URL" ]]; then
  if [[ -z "$OIDC_CLIENT_SECRET" ]]; then
    err "OIDC is configured (--oidc-issuer-url set) but no client secret was provided. Pass --oidc-client-secret (or OPENCRANE_OIDC_CLIENT_SECRET) — a confidential client cannot authenticate without it."
    exit 1
  fi
  OIDC_SESSION_SECRET="${OIDC_SESSION_SECRET:-$(_gen_secret)}"
  log "Creating the OIDC secret '$OIDC_SECRET_NAME' (client + session secret)…"
  kubectl create secret generic "$OIDC_SECRET_NAME" -n "$NAMESPACE" \
    --from-literal=OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET" \
    --from-literal=OIDC_SESSION_SECRET="$OIDC_SESSION_SECRET" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# 2.25. ingress-nginx (a cluster singleton). Installed by default; auto-skips when a
# controller is already present (existing IngressClass or an ingress-nginx Deployment)
# so bundling never clobbers a BYO controller. helm upgrade --install is itself
# idempotent, but we check first so a BYO controller in another namespace is respected.
_ingress_nginx_present() {
  kubectl get ingressclass -o name 2>/dev/null | grep -q . && return 0
  kubectl get deploy -A -l app.kubernetes.io/name=ingress-nginx -o name 2>/dev/null | grep -q . && return 0
  return 1
}

_install_ingress_nginx() {
  if [[ "$INSTALL_INGRESS_NGINX" != "1" ]]; then
    log "ingress-nginx: bundling disabled (--no-ingress-nginx). Bring your own controller."
    return
  fi
  if _ingress_nginx_present; then
    log "ingress-nginx: a controller is already present — skipping the bundled install."
    return
  fi
  log "Installing ingress-nginx controller…"
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update >/dev/null
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace "$INGRESS_NGINX_NAMESPACE" --create-namespace --wait
}

_install_ingress_nginx

# 2.30. Auto-derive ingress.externalIp from the ingress-nginx LoadBalancer (opt-in,
# --auto-ingress-ip). The operator's per-org DNS side effect needs the cluster ingress IP;
# rather than hand-copy it from `kubectl get svc`, derive it here once the controller's LB is
# assigned and feed it into the chart as a --set. An explicit ingress.externalIp --set wins.
_resolve_ingress_ip() {
  [[ "$AUTO_INGRESS_IP" == "1" ]] || return 0
  if printf '%s\n' "${EXTRA_SET[@]}" | grep -q "ingress.externalIp="; then
    log "Auto-ingress-ip: ingress.externalIp set explicitly — skipping derivation."
    return 0
  fi
  log "Auto-ingress-ip: waiting for the ingress-nginx LoadBalancer address…"
  local sel="app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/component=controller"
  local ip="" tries=0
  while (( tries < 60 )); do
    ip="$(kubectl get svc -n "$INGRESS_NGINX_NAMESPACE" -l "$sel" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null)"
    [[ -z "$ip" ]] && ip="$(kubectl get svc -n "$INGRESS_NGINX_NAMESPACE" -l "$sel" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null)"
    [[ -n "$ip" ]] && break
    sleep 5; tries=$((tries+1))
  done
  if [[ -z "$ip" ]]; then
    warn "Auto-ingress-ip: no LoadBalancer address after ~5m; leaving ingress.externalIp unset (per-org DNS records stay unwritten until it is set)."
    return 0
  fi
  log "Auto-ingress-ip: derived ingress.externalIp=$ip from the ingress-nginx LB."
  EXTRA_SET+=(--set "ingress.externalIp=$ip")
}
_resolve_ingress_ip

# 2.35. external-dns (a cluster singleton). The operator declares per-org records as
# namespaced DNSEndpoint CRs; the external-dns controller (run with --source=crd)
# reconciles them into Google Cloud DNS. It needs zone-WRITE access, so it shares the
# cert-manager DNS-01 zone + credentials exactly:
#   - Workload Identity (no --dns01-credentials): the SAME GSA bound roles/dns.admin that
#     the cert-manager solver impersonates. We DO NOT create a second binding — the
#     DNS-01 preflight (Step 2.5) already fails closed unless that binding exists.
#   - External zone (--dns01-credentials FILE): the SAME SA-key, mounted as a Secret.
# external-dns is therefore only bundled in acme/clouddns mode (off/selfSigned have no
# managed zone to write). Installed AFTER Step 2.5 so DNS01_PROJECT / DNS01_CREDENTIALS
# are already resolved + validated. Gated by externalDns.install (--no-external-dns to BYO).
_external_dns_present() {
  kubectl get deploy -A -l app.kubernetes.io/name=external-dns -o name 2>/dev/null | grep -q . && return 0
  return 1
}

_install_external_dns() {
  if [[ "$INSTALL_EXTERNAL_DNS" != "1" ]]; then
    log "external-dns: bundling disabled (--no-external-dns). Bring your own controller."
    return
  fi
  if [[ "$CERT_MODE" != "acme" ]]; then
    log "external-dns: skipped (no managed DNS zone in mode='$CERT_MODE'; bundled only in acme/clouddns mode). The operator's DNSEndpoint CRs are reconciled by a BYO controller if you run one."
    return
  fi
  if _external_dns_present; then
    log "external-dns: a controller is already present — skipping the bundled install."
    return
  fi
  log "Installing external-dns controller (--source=crd → Cloud DNS, zone for '$BASE_DOMAIN')…"
  helm repo add external-dns https://kubernetes-sigs.github.io/external-dns --force-update >/dev/null

  # external-dns flags: reconcile DNSEndpoint CRs (--source=crd, with its CRD installed)
  # into Google Cloud DNS, scoped to --base-domain so it never touches records outside the
  # platform zone, against the same project as the cert-manager solver.
  local ed_args=(upgrade --install external-dns external-dns/external-dns
    --namespace "$EXTERNAL_DNS_NAMESPACE" --create-namespace --wait
    --set "provider=google"
    --set-string "google.project=$DNS01_PROJECT"
    --set "sources={crd}"
    --set "installCRDs=true"
    --set-string "domainFilters={$BASE_DOMAIN}"
    --set "policy=sync")

  if [[ -n "$DNS01_CREDENTIALS" ]]; then
    # External-zone path: SHARE the cert-manager solver Secret's SA key. external-dns reads
    # GCP creds from a file, so we create the key Secret in its namespace and mount it.
    kubectl create secret generic clouddns-external-dns \
      -n "$EXTERNAL_DNS_NAMESPACE" \
      --from-file=credentials.json="$DNS01_CREDENTIALS" \
      --dry-run=client -o yaml | kubectl apply -f -
    ed_args+=(--set-string "google.serviceAccountSecret=clouddns-external-dns"
      --set-string "google.serviceAccountSecretKey=credentials.json")
  else
    # Workload Identity path: external-dns impersonates the SAME GSA the cert-manager DNS-01
    # solver does (roles/dns.admin). Terraform creates the WI BINDING, but the controller's
    # KSA must still carry the `iam.gke.io/gcp-service-account` annotation or the metadata-server
    # handshake falls back to the node SA and Cloud DNS writes fail at runtime. Require the GSA
    # here (fail closed) rather than installing a controller that silently cannot authenticate.
    if [[ -z "$DNS_WRITER_GSA" ]]; then
      err "external-dns Workload Identity needs the shared DNS-writer GSA to annotate its ServiceAccount."
      err "Pass --dns-writer-gsa <gsa>@<project>.iam.gserviceaccount.com (Terraform output dns_writer_service_account_email),"
      err "or --no-external-dns to BYO a controller, or --dns01-credentials <sa-key.json> for an external zone."
      exit 1
    fi
    log "external-dns: Workload Identity via the shared DNS-writer GSA '$DNS_WRITER_GSA' (roles/dns.admin on '$DNS01_PROJECT')."
    ed_args+=(--set-string "serviceAccount.annotations.iam\.gke\.io/gcp-service-account=$DNS_WRITER_GSA")
  fi
  helm "${ed_args[@]}"
}

# 2.5. cert-manager / TLS. MUST run before the chart's `helm install`: the chart
# renders cert-manager.io/v1 Issuer + Certificate objects, so the CRDs (and, for acme,
# a live webhook) have to exist first or the API server rejects the chart with a 400.
# CERT_MANAGER_HELM_FLAGS is appended to the chart's helm args further down.
CERT_MANAGER_HELM_FLAGS=()

# Resolve the effective mode: off (default), selfSigned (--cert-manager only), or
# acme (--cert-manager + --acme-email + --dns01-provider). A partial acme request is a
# hard error here so we never fall back to selfSigned behind the operator's back.
_resolve_cert_mode() {
  if [[ "$CERT_MANAGER" != "on" ]]; then echo "off"; return; fi
  if [[ -z "$ACME_EMAIL" && -z "$DNS01_PROVIDER" ]]; then echo "selfSigned"; return; fi
  if [[ -n "$ACME_EMAIL" && -n "$DNS01_PROVIDER" ]]; then
    # A wildcard cert (*.<domain>) is meaningless without the base domain, so require it
    # up front rather than letting cert-manager issue against an empty/placeholder SAN.
    if [[ -z "$BASE_DOMAIN" ]]; then
      err "acme TLS issues a wildcard for *.<base-domain>, so --base-domain is required in acme mode."
      exit 1
    fi
    echo "acme"; return
  fi
  err "acme TLS needs BOTH --acme-email and --dns01-provider (got only one). For dev/self-signed TLS drop both and pass --cert-manager alone."
  exit 1
}

# Install the cert-manager controller + CRDs (mirrors the CloudNativePG install shape:
# upstream chart, crds.enabled, --wait). Idempotent: helm upgrade --install no-ops when
# cert-manager is already present, so bundling it can never clobber an existing one. In the
# acme/Workload-Identity path the controller SA is annotated with the SHARED DNS-writer GSA
# (same one external-dns uses) so the DNS-01 solver can write to the zone; Terraform creates
# the WI binding, but the KSA annotation is the install-time half of the handshake.
_install_cert_manager() {
  log "Installing cert-manager (CRDs + controller)…"
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  local cm_args=(upgrade --install cert-manager jetstack/cert-manager
    --namespace "$CERT_MANAGER_NAMESPACE" --create-namespace --wait
    --set crds.enabled=true)
  if [[ "$CERT_MODE" == "acme" && -z "$DNS01_CREDENTIALS" && -n "$DNS_WRITER_GSA" ]]; then
    cm_args+=(--set-string "serviceAccount.annotations.iam\.gke\.io/gcp-service-account=$DNS_WRITER_GSA")
  fi
  helm "${cm_args[@]}"
}

# DNS-01 preflight (acme only). FAILS FAST with the exact remediation rather than
# letting cert-manager spin on a SOLVING order forever. Two paths:
#   - Workload Identity (no --dns01-credentials): the cert-manager SA's bound GSA needs
#     roles/dns.admin on the zone's project; print the exact gcloud binding command.
#   - External zone (--dns01-credentials FILE): require the file and create the solver
#     Secret in the cert-manager namespace (cert-manager reads ClusterIssuer solver
#     Secrets only from its OWN namespace).
_preflight_dns01() {
  # 1. clouddns is the only provider this installer wires end-to-end; reject others up
  #    front so the failure is a clear message, not a later cert-manager order error.
  if [[ "$DNS01_PROVIDER" != "clouddns" ]]; then
    err "Unsupported --dns01-provider '$DNS01_PROVIDER'. This installer wires 'clouddns' (Google Cloud DNS). For another provider, install cert-manager yourself and set certManager.acme.dns01.{provider,config} in a --values file."
    exit 1
  fi

  # The clouddns solver requires the GCP project that hosts the zone for --base-domain.
  # Default it from the gcloud active project; FAIL FAST if still empty (a solver with no
  # project never issues, and we tie the issuer zone to the same install input as the chart).
  if [[ -z "$DNS01_PROJECT" ]]; then
    DNS01_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  if [[ -z "$DNS01_PROJECT" || "$DNS01_PROJECT" == "(unset)" ]]; then
    err "clouddns DNS-01 needs the GCP project that hosts the Cloud DNS zone for '$BASE_DOMAIN'. Pass --dns01-project PROJECT_ID (or set a gcloud active project)."
    exit 1
  fi

  if [[ -n "$DNS01_CREDENTIALS" ]]; then
    # 2a. External-zone path: the SA-key file MUST exist; create the solver Secret the
    #     ClusterIssuer references. Failing here is preferable to a green install whose
    #     wildcard cert never issues because the solver has no credentials.
    if [[ ! -f "$DNS01_CREDENTIALS" ]]; then
      err "--dns01-credentials '$DNS01_CREDENTIALS' not found. Provide the Cloud DNS service-account key JSON, or omit it to use GKE Workload Identity."
      exit 1
    fi
    log "Creating Cloud DNS solver Secret in the '$CERT_MANAGER_NAMESPACE' namespace…"
    kubectl create secret generic clouddns-dns01-solver \
      -n "$CERT_MANAGER_NAMESPACE" \
      --from-file=key.json="$DNS01_CREDENTIALS" \
      --dry-run=client -o yaml | kubectl apply -f -
  elif [[ -n "$DNS_WRITER_GSA" ]]; then
    # 2b. Workload Identity path WITH the shared DNS-writer GSA: the cert-manager controller
    #     SA is annotated with this GSA in _install_cert_manager, completing the handshake for
    #     the SAME identity external-dns uses. We trust Terraform created the roles/dns.admin
    #     binding (the `--preflight` check verifies it where gcloud is available); here we only
    #     confirm the GSA was supplied so the solver has an identity to impersonate.
    log "DNS-01 via Workload Identity using the shared DNS-writer GSA '$DNS_WRITER_GSA' (roles/dns.admin on '$DNS01_PROJECT')."
  else
    # 2c. No credential at all: FAIL CLOSED. Without either an external SA key or the shared
    #     DNS-writer GSA the solver has no identity, so the wildcard order would spin forever.
    err "DNS-01 needs a zone-write identity: either the shared DNS-writer GSA (Workload Identity) or an external SA key."
    err "Pass --dns-writer-gsa <gsa>@$DNS01_PROJECT.iam.gserviceaccount.com (Terraform output dns_writer_service_account_email; it must have roles/dns.admin),"
    err "or --dns01-credentials <sa-key.json> for an external DNS zone."
    exit 1
  fi
}

CERT_MODE="$(_resolve_cert_mode)"
case "$CERT_MODE" in
  off)
    log "TLS: cert-manager disabled (mode=off). The chart renders no issuer/cert."
    ;;
  selfSigned)
    log "TLS: cert-manager self-signed issuer (dev/k3d/IP — not browser-trusted)."
    _install_cert_manager
    CERT_MANAGER_HELM_FLAGS+=(--set "certManager.enabled=true" --set "certManager.mode=selfSigned")
    ;;
  acme)
    log "TLS: cert-manager ACME / DNS-01 ($DNS01_PROVIDER) — browser-trusted wildcard."
    _install_cert_manager
    # Wait on the webhook BEFORE rendering the chart's issuer/cert: cert-manager's
    # validating webhook rejects cert-manager.io/v1 objects with a 400 until it is live,
    # which would fail the chart install with a confusing connection error.
    log "Waiting for the cert-manager webhook to become ready…"
    kubectl rollout status deploy/cert-manager-webhook -n "$CERT_MANAGER_NAMESPACE" --timeout="${TIMEOUT}s"
    _preflight_dns01
    # cluster-issuer.yaml fail-closes without BOTH acme.email and dns01.provider, so both
    # are always set here. The clouddns solver config is rendered verbatim under
    # solvers[].dns01.clouddns; an external zone references the solver Secret created above.
    CERT_MANAGER_HELM_FLAGS+=(--set "certManager.enabled=true" --set "certManager.mode=acme")
    CERT_MANAGER_HELM_FLAGS+=(--set-string "certManager.acme.email=$ACME_EMAIL")
    CERT_MANAGER_HELM_FLAGS+=(--set "certManager.acme.dns01.provider=$DNS01_PROVIDER")
    # The clouddns solver project (resolved/validated in _preflight_dns01) ties the cert
    # issuer's DNS zone to the same install input that drives the chart + Terraform.
    CERT_MANAGER_HELM_FLAGS+=(--set-string "certManager.acme.dns01.config.project=$DNS01_PROJECT")
    if [[ -n "$DNS01_CREDENTIALS" ]]; then
      CERT_MANAGER_HELM_FLAGS+=(--set "certManager.acme.dns01.config.serviceAccountSecretRef.name=clouddns-dns01-solver")
      CERT_MANAGER_HELM_FLAGS+=(--set-string "certManager.acme.dns01.config.serviceAccountSecretRef.key=key.json")
    fi
    ;;
esac

# external-dns is bundled here — after Step 2.5 resolved CERT_MODE + the shared DNS-01
# project/credentials it reuses. When it (or a BYO controller) is in place, tell the chart
# to switch the operator's DNSEndpoint declaration ON so per-org records are reconciled.
_install_external_dns
EXTERNAL_DNS_HELM_FLAGS=()
if [[ "$CERT_MODE" == "acme" ]] && { [[ "$INSTALL_EXTERNAL_DNS" == "1" ]] || _external_dns_present; }; then
  EXTERNAL_DNS_HELM_FLAGS+=(--set "externalDns.enabled=true")
fi

# 3. The OpenCrane chart.
# Fetch subchart dependencies (Langfuse, and any others declared in Chart.yaml).
# --skip-refresh avoids a network fetch when the chart is already cached; we force
# an update for langfuse so the version constraint is always satisfied.
log "Adding Langfuse Helm repository…"
helm repo add langfuse https://langfuse.github.io/langfuse-k8s --force-update >/dev/null
log "Fetching chart dependencies…"
helm dep update "$CHART_DIR"

log "Installing the OpenCrane Helm release '$RELEASE'…"
# LiteLLM is wired to its own `litellm` database (DATABASE_URL via opencrane-litellm-db) with
# STORE_MODEL_IN_DB on, so models/keys are stored and seeded at runtime via the admin API. The
# Prisma query-engine crash on the Chainguard/wolfi base is fixed by the non_root image variant
# (pre-baked engine binaries), set in the chart — see values.yaml litellm.image.
helm_args=(upgrade --install "$RELEASE" "$CHART_DIR" --namespace "$NAMESPACE" --create-namespace
  --set "controlPlane.database.existingSecret=$DB_SECRET"
  --set "litellm.existingDatabaseSecret=opencrane-litellm-db"
  --set "litellm.existingSecret=opencrane-litellm"
  --set "litellm.storeModelInDb=true")
# Per-component tags override the unified --image-tag so a single component can be
# rolled through Helm (which keeps Helm the sole owner of the image field). Each
# falls back to IMAGE_TAG when its flag is unset, preserving the all-same default.
CP_TAG="${CONTROL_PLANE_TAG:-$IMAGE_TAG}"
OP_TAG="${OPERATOR_TAG:-$IMAGE_TAG}"
TN_TAG="${TENANT_TAG:-$IMAGE_TAG}"
[[ -n "$CP_TAG" ]] && helm_args+=(--set "controlPlane.image.tag=$CP_TAG")
[[ -n "$OP_TAG" ]] && helm_args+=(--set "operator.image.tag=$OP_TAG")
[[ -n "$TN_TAG" ]] && helm_args+=(--set "tenant.image.tag=$TN_TAG")
# --base-domain drives ingress.domain; controlPlaneHost defaults to platform.<domain>
# in the chart, and the cert-manager wildcard SANs (*.<domain>, <domain>,
# controlPlaneHost) are derived from it. Setting it explicitly here keeps a single
# source of truth across the chart, the issuer, and the operator's per-org provisioning.
[[ -n "$BASE_DOMAIN" ]] && helm_args+=(--set "ingress.domain=$BASE_DOMAIN")
# Langfuse in-cluster wiring: PostgreSQL host (CNPG read-write service) and NEXTAUTH_URL.
# Both are injected here because they depend on runtime values (namespace, base-domain)
# not known at values.yaml authoring time. Harmless when langfuse.inCluster.enabled=false
# (the subchart is disabled by condition so these values are never rendered).
helm_args+=(--set "langfuse.postgresql.host=${DB_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local")
helm_args+=(--set "langfuse.s3.auth.rootPassword=$LANGFUSE_S3_ROOT_PASSWORD")
helm_args+=(--set "global.valkey.password=$LANGFUSE_REDIS_PASSWORD")
helm_args+=(--set "langfuse.clickhouse.auth.password=$LANGFUSE_CH_PASSWORD")
# Bitnami sub-subchart conditions default to deploy:true in the Langfuse chart even
# when langfuse.inCluster.enabled=false; pass passwords unconditionally so Bitnami's
# upgrade password-validation templates are satisfied regardless of Langfuse state.
# Also re-assert the condition flag so --reuse-values can never accidentally carry
# a stale true from a previous in-cluster install.
helm_args+=(--set "langfuse.inCluster.enabled=false")
[[ -n "$BASE_DOMAIN" ]] && helm_args+=(--set-string "langfuse.langfuse.nextauth.url=https://langfuse.${BASE_DOMAIN}")
# OIDC human-login (control-plane only). Rendered iff an issuer URL is given; otherwise
# the chart emits no OIDC env and the control-plane stays in token/development mode.
[[ -n "$OIDC_ISSUER_URL" ]]   && helm_args+=(--set "controlPlane.oidc.issuerUrl=$OIDC_ISSUER_URL")
[[ -n "$OIDC_CLIENT_ID" ]]    && helm_args+=(--set "controlPlane.oidc.clientId=$OIDC_CLIENT_ID")
[[ -n "$OIDC_REDIRECT_URI" ]] && helm_args+=(--set "controlPlane.oidc.redirectUri=$OIDC_REDIRECT_URI")
# Point the chart at the Secret created above (client + session secret) instead of leaving
# its inline values empty — keeps secrets out of Helm values + the rendered manifest.
[[ -n "$OIDC_ISSUER_URL" ]]   && helm_args+=(--set-string "controlPlane.oidc.existingSecret=$OIDC_SECRET_NAME")
# Per-cluster platform-operator SEED. Set ONLY when a non-empty value is supplied; an
# empty seed is never passed, so the chart grants operator to nobody (fail-closed).
if [[ -n "$PLATFORM_OPERATOR_SEED_EMAIL" ]]; then
  helm_args+=(--set-string "controlPlane.oidc.platformOperatorSeedEmail=$PLATFORM_OPERATOR_SEED_EMAIL")
  warn "Seeding platform operator for the cluster (verified OIDC email match). Remove the seed once a group mapping is in place."
fi
[[ -n "$VALUES_FILE" ]] && helm_args+=(--values "$VALUES_FILE")
# cert-manager flags resolved in Step 2.5 (empty in mode=off). Placed before --set
# overrides so an operator can still override individual issuer fields on the CLI.
[ ${#CERT_MANAGER_HELM_FLAGS[@]} -gt 0 ] && helm_args+=("${CERT_MANAGER_HELM_FLAGS[@]}")
# external-dns wiring resolved above (empty unless a controller is in place). Placed before
# --set overrides so an operator can still override externalDns.* on the CLI.
[ ${#EXTERNAL_DNS_HELM_FLAGS[@]} -gt 0 ] && helm_args+=("${EXTERNAL_DNS_HELM_FLAGS[@]}")
# DB-checksum annotation: a short hash of the DB password injected into the
# litellm (and mcp-gateway/obot) pod templates. When the password rotates the
# annotation changes → Kubernetes triggers an automatic rollout so pods never
# hold stale credentials across a deploy.
_DB_CKSUM="$(printf '%s' "$DB_PASSWORD" | sha256sum | cut -c1-8)"
helm_args+=(--set "litellm.podAnnotations.db-checksum=$_DB_CKSUM")
helm_args+=(--set "mcpGateway.podAnnotations.db-checksum=$_DB_CKSUM")
helm_args+=("${EXTRA_SET[@]}")
# When --reuse-values is set, inherit all previously-supplied values from the live release
# and apply only the overrides passed on this invocation (e.g. a pure image-tag rollout).
[[ -n "$REUSE_VALUES" ]] && helm_args+=(--reuse-values)
helm "${helm_args[@]}"

# 4. Wait for the core workloads.
# Database migrations run via the control-plane's pre-upgrade hook Job
# (prisma migrate deploy), which `helm upgrade` above blocks on before the
# rollout — so EVERY deploy reconciles the schema, even when the control-plane
# pod template is unchanged (a plain `helm upgrade` won't roll an unchanged pod,
# so the db-migrate initContainer alone could leave the schema behind when the
# database was recreated under a running pod). The initContainer remains a
# belt-and-suspenders guard for pod (re)creation between deploys. Idempotent.
kubectl rollout status "deployment/${RELEASE}-operator" -n "$NAMESPACE" --timeout="${TIMEOUT}s"
kubectl rollout status "deployment/${RELEASE}-control-plane" -n "$NAMESPACE" --timeout="${TIMEOUT}s"

# 5. Post-deploy verify (opt-in, --verify). Advisory only — surfaces the failure modes that
# leave a "green" install unreachable (pods not Running, no DNSEndpoints, external-dns auth
# errors, host not resolving) so they are caught here instead of in a confused browser session.
_post_deploy_verify() {
  [[ "$VERIFY" == "1" ]] || return 0
  log "Post-deploy verify (advisory — does not fail the install):"

  # 1. Core pods Running — a CrashLoop/ImagePullBackOff that helm --wait didn't catch.
  local notready
  notready="$(kubectl get pods -n "$NAMESPACE" --field-selector=status.phase!=Running,status.phase!=Succeeded -o name 2>/dev/null | grep -c . || true)"
  if [[ "$notready" == "0" ]]; then
    log "  ✓ all pods Running/Succeeded in $NAMESPACE"
  else
    warn "  ✗ $notready pod(s) not Running in $NAMESPACE — kubectl get pods -n $NAMESPACE"
  fi

  # 2. DNSEndpoint CRs — the operator's per-org record side effect (only meaningful when the
  #    external-dns CRD source is installed). Absent CRD ⇒ per-org hosts never get A records.
  if kubectl get crd dnsendpoints.externaldns.k8s.io >/dev/null 2>&1; then
    local des
    des="$(kubectl get dnsendpoint -A -o name 2>/dev/null | grep -c . || true)"
    log "  • DNSEndpoint CRs present: $des"
  else
    warn "  • DNSEndpoint CRD absent (external-dns --source=crd not installed) — per-org A records won't be written."
  fi

  # 3. external-dns recent auth/permission errors — the dead-external-dns failure mode (the
  #    controller runs but can't write the zone, so records silently never appear).
  if kubectl get deploy -A -l app.kubernetes.io/name=external-dns -o name 2>/dev/null | grep -q .; then
    if kubectl logs -A -l app.kubernetes.io/name=external-dns --tail=200 2>/dev/null | grep -qiE "permission|forbidden|invalid_grant|denied|failed to (apply|submit)"; then
      warn "  ✗ external-dns logs show recent errors — kubectl logs -A -l app.kubernetes.io/name=external-dns --tail=200"
    else
      log "  ✓ external-dns logs show no recent auth errors"
    fi
  fi

  # 4. Control-plane host resolves to the ingress — the end of the chain a user hits first.
  if [[ -n "$BASE_DOMAIN" ]] && command -v dig >/dev/null 2>&1; then
    local host="platform.$BASE_DOMAIN" resolved
    resolved="$(dig +short "$host" 2>/dev/null | tail -1)"
    if [[ -n "$resolved" ]]; then
      log "  ✓ $host resolves to $resolved"
    else
      warn "  ✗ $host does not resolve yet (DNS propagation lag or a missing record)."
    fi
  fi
}
_post_deploy_verify

log "Done. OpenCrane is installed in namespace '$NAMESPACE'."
[[ -n "$BASE_DOMAIN" ]] && log "Point your DNS at the ingress, then visit https://platform.${BASE_DOMAIN}"
log "Ingress: kubectl get ingress -n $NAMESPACE"
