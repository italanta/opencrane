#!/usr/bin/env bash
# =============================================================================
# OpenCrane — configure OIDC human-login on an EXISTING install
#
# Standalone, surgical OIDC configurator. It does NOT re-run the full deploy
# (no CNPG / ingress-nginx / cert-manager / external-dns work) — it only:
#   1. creates/updates the `opencrane-oidc` Secret (client + session secret), and
#   2. `helm upgrade --reuse-values` of the `opencrane` release, overriding ONLY
#      the controlPlane.oidc.* values.
# The control-plane pod template gains the OIDC env, so Kubernetes rolls just the
# control-plane Deployment; everything else is left exactly as deployed.
#
# ONE OIDC MANAGER, BOTH TENANCY SHAPES. The same invocation works whether the
# install is single-ClusterTenant (one seeded org) or multi-ClusterTenant
# (self-service, many orgs). OIDC lives at the PLATFORM/control-plane level, not
# per ClusterTenant — there is exactly one trusted issuer for the whole install.
# To configure several SEPARATE clusters, run this once per kube-context
# (--context …); the OIDC settings are identical, only --base-domain (→ redirect
# URI) and the per-cluster operator seed differ.
#
# ───────────────────────────────────────────────────────────────────────────
# ISOLATION GUARANTEE (read before granting anything cross-org).
# A shared issuer is SSO for AUTHENTICATION only. Authenticating into one
# ClusterTenant does NOT grant access to another: the control-plane authorises
# every org-scoped route against the caller's OrgMembership (verified OIDC `sub`),
# and routes a human to their own pod by a fail-closed verified-email→tenant
# lookup. Non-members get 403; an ambiguous/absent email match is denied.
#
# The ONLY cross-ClusterTenant superpower is PLATFORM-OPERATOR. It is fail-closed:
# nobody is an operator unless you explicitly pass --platform-operator-groups
# and/or --platform-operator-seed-email here. Grant it to the smallest possible
# set — a platform operator can manage EVERY org. org-admin (--org-admin-groups)
# is scoped to the orgs the caller actually belongs to and does NOT cross orgs.
# ───────────────────────────────────────────────────────────────────────────
#
# Usage:
#   ./platform/configure-oidc.sh \
#       --issuer-url https://id.example.com \
#       --client-id <client-id> \
#       --client-secret <secret>            # or env OPENCRANE_OIDC_CLIENT_SECRET
#       [--base-domain dev.opencrane.ai]    # derives the redirect URI if --redirect-uri omitted
#       [--redirect-uri https://platform.<domain>/api/v1/auth/callback]
#       [--groups-claim groups] [--roles-claim roles]
#       [--org-admin-groups "org-admins,..."]
#       [--platform-operator-groups "platform-operators,..."]
#       [--platform-operator-seed-email you@org]   # bootstrap the FIRST operator
#       [--session-secret <secret>]         # default: preserve existing, else generate
#       [--context KUBECTX] [--namespace opencrane-system] [--release opencrane]
#       [--chart platform/helm] [--dry-run]
#
# Required: --issuer-url, --client-id, and a client secret (flag or env).
# Disable OIDC again with: ./platform/configure-oidc.sh --disable [--context …]
#
# Prereqs: kubectl (pointed at / --context the target cluster), helm, openssl.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$SCRIPT_DIR/helm"

NAMESPACE="opencrane-system"
RELEASE="opencrane"
KUBE_CONTEXT=""
OIDC_SECRET_NAME="opencrane-oidc"

ISSUER_URL=""
CLIENT_ID=""
CLIENT_SECRET="${OPENCRANE_OIDC_CLIENT_SECRET:-${OIDC_CLIENT_SECRET:-}}"
SESSION_SECRET="${OPENCRANE_OIDC_SESSION_SECRET:-${OIDC_SESSION_SECRET:-}}"
REDIRECT_URI=""
BASE_DOMAIN="${OPENCRANE_BASE_DOMAIN:-}"
GROUPS_CLAIM="groups"
ROLES_CLAIM="roles"
ORG_ADMIN_GROUPS=""
PLATFORM_OPERATOR_GROUPS=""
PLATFORM_OPERATOR_SEED_EMAIL=""
DISABLE=0
DRY_RUN=0

log()  { echo -e "\033[0;32m[configure-oidc]\033[0m $1"; }
warn() { echo -e "\033[1;33m[configure-oidc]\033[0m $1"; }
err()  { echo -e "\033[0;31m[configure-oidc]\033[0m $1" >&2; }
_gen_secret() { openssl rand -hex 32 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issuer-url)                  ISSUER_URL="$2"; shift 2 ;;
    --client-id)                   CLIENT_ID="$2"; shift 2 ;;
    --client-secret)               CLIENT_SECRET="$2"; shift 2 ;;
    --session-secret)              SESSION_SECRET="$2"; shift 2 ;;
    --redirect-uri)                REDIRECT_URI="$2"; shift 2 ;;
    --base-domain|--domain)        BASE_DOMAIN="$2"; shift 2 ;;
    --groups-claim)                GROUPS_CLAIM="$2"; shift 2 ;;
    --roles-claim)                 ROLES_CLAIM="$2"; shift 2 ;;
    --org-admin-groups)            ORG_ADMIN_GROUPS="$2"; shift 2 ;;
    --platform-operator-groups)    PLATFORM_OPERATOR_GROUPS="$2"; shift 2 ;;
    --platform-operator-seed-email) PLATFORM_OPERATOR_SEED_EMAIL="$2"; shift 2 ;;
    --context)                     KUBE_CONTEXT="$2"; shift 2 ;;
    --namespace)                   NAMESPACE="$2"; shift 2 ;;
    --release)                     RELEASE="$2"; shift 2 ;;
    --chart)                       CHART_DIR="$2"; shift 2 ;;
    --disable)                     DISABLE=1; shift ;;
    --dry-run)                     DRY_RUN=1; shift ;;
    -h|--help)                     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                             err "Unknown flag: $1"; exit 1 ;;
  esac
done

for c in kubectl helm; do command -v "$c" >/dev/null 2>&1 || { err "Missing required command: $c"; exit 1; }; done

# All kubectl/helm calls honour --context so the SAME script targets any cluster.
KCTX=(); [[ -n "$KUBE_CONTEXT" ]] && KCTX=(--kube-context "$KUBE_CONTEXT")
KCTL=(); [[ -n "$KUBE_CONTEXT" ]] && KCTL=(--context "$KUBE_CONTEXT")
_active_context="${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo '?')}"

# Confirm the release exists — this is a CONFIGURATOR, not an installer.
if ! helm ${KCTX[@]+"${KCTX[@]}"} -n "$NAMESPACE" status "$RELEASE" >/dev/null 2>&1; then
  err "Release '$RELEASE' not found in namespace '$NAMESPACE' (context: $_active_context)."
  err "This script configures OIDC on an EXISTING install. Deploy first (k8s-deploy.sh / deploy-multi-tenant.sh)."
  exit 1
fi

# Preserve the release's existing user-supplied values, then layer OIDC on top.
# We capture them with `helm get values` and re-apply via -f rather than using
# `--reuse-values`: --reuse-values bypasses the chart's values.yaml entirely, so
# it nil-panics the moment the chart adds a new key (e.g. controlPlane.migrationJob).
# `-f <captured>` keeps the operator's config AND lets new chart defaults fill in.
VALUES_TMP="$(mktemp -t opencrane-oidc-values.XXXXXX)"
trap 'rm -f "$VALUES_TMP"' EXIT
helm ${KCTX[@]+"${KCTX[@]}"} -n "$NAMESPACE" get values "$RELEASE" -o yaml > "$VALUES_TMP" 2>/dev/null || true

helm_args=(upgrade "$RELEASE" "$CHART_DIR" ${KCTX[@]+"${KCTX[@]}"} -n "$NAMESPACE")
# Layer the captured values unless the release had none (`helm get values` prints
# the literal `null` when no user values were supplied).
if [[ -s "$VALUES_TMP" ]] && ! grep -qx 'null' "$VALUES_TMP"; then helm_args+=(-f "$VALUES_TMP"); fi
[[ "$DRY_RUN" -eq 1 ]] && helm_args+=(--dry-run)

# ── Disable path: clear the OIDC values so the chart emits no OIDC env (token/dev
#    mode). The Secret is left in place (harmless, unreferenced) so re-enabling
#    keeps the same session secret and existing cookies survive.
if [[ "$DISABLE" -eq 1 ]]; then
  warn "Disabling OIDC on release '$RELEASE' (context: $_active_context) — control-plane reverts to token/dev auth."
  helm_args+=(--set-string "controlPlane.oidc.issuerUrl=")
  helm "${helm_args[@]}"
  [[ "$DRY_RUN" -eq 0 ]] && kubectl ${KCTL[@]+"${KCTL[@]}"} -n "$NAMESPACE" rollout status deploy/"$RELEASE"-control-plane --timeout=180s
  log "OIDC disabled."
  exit 0
fi

# ── Validate required inputs.
[[ -n "$ISSUER_URL" ]] || { err "--issuer-url is required."; exit 1; }
[[ -n "$CLIENT_ID" ]]  || { err "--client-id is required."; exit 1; }
[[ -n "$CLIENT_SECRET" ]] || { err "A client secret is required: pass --client-secret or set OPENCRANE_OIDC_CLIENT_SECRET (a confidential client cannot authenticate without it)."; exit 1; }

# ── Redirect URI: explicit flag wins; otherwise derive from --base-domain. The
#    control-plane host is platform.<base-domain> and the OIDC callback route is
#    mounted at /api/v1/auth/callback (auth router @ /api/v1/auth + GET /callback).
if [[ -z "$REDIRECT_URI" ]]; then
  [[ -n "$BASE_DOMAIN" ]] || { err "Provide --redirect-uri, or --base-domain to derive https://platform.<base-domain>/api/v1/auth/callback."; exit 1; }
  REDIRECT_URI="https://platform.${BASE_DOMAIN}/api/v1/auth/callback"
  log "Derived redirect URI: $REDIRECT_URI"
fi

# ── Session secret: NEVER rotate silently. Reuse the existing one if present so
#    live login sessions survive a re-run; otherwise generate a fresh one.
if [[ -z "$SESSION_SECRET" ]]; then
  SESSION_SECRET="$(kubectl ${KCTL[@]+"${KCTL[@]}"} -n "$NAMESPACE" get secret "$OIDC_SECRET_NAME" -o jsonpath='{.data.OIDC_SESSION_SECRET}' 2>/dev/null | base64 -d || true)"
  if [[ -n "$SESSION_SECRET" ]]; then
    log "Reusing the existing session secret (existing logins stay valid)."
  else
    SESSION_SECRET="$(_gen_secret)"
    log "Generated a new session secret."
  fi
fi

# ── 1. Upsert the OIDC Secret (idempotent dry-run | apply). Secrets stay out of
#       Helm values + the rendered manifest; the chart references them by name.
log "Upserting Secret '$OIDC_SECRET_NAME' in '$NAMESPACE' (context: $_active_context)…"
if [[ "$DRY_RUN" -eq 0 ]]; then
  kubectl ${KCTL[@]+"${KCTL[@]}"} -n "$NAMESPACE" create secret generic "$OIDC_SECRET_NAME" \
    --from-literal=OIDC_CLIENT_SECRET="$CLIENT_SECRET" \
    --from-literal=OIDC_SESSION_SECRET="$SESSION_SECRET" \
    --dry-run=client -o yaml | kubectl ${KCTL[@]+"${KCTL[@]}"} apply -f -
else
  log "[dry-run] would upsert Secret '$OIDC_SECRET_NAME'."
fi

# ── 2. helm upgrade --reuse-values, overriding ONLY controlPlane.oidc.*
helm_args+=(--set-string "controlPlane.oidc.issuerUrl=$ISSUER_URL")
helm_args+=(--set-string "controlPlane.oidc.clientId=$CLIENT_ID")
helm_args+=(--set-string "controlPlane.oidc.redirectUri=$REDIRECT_URI")
helm_args+=(--set-string "controlPlane.oidc.existingSecret=$OIDC_SECRET_NAME")
helm_args+=(--set-string "controlPlane.oidc.groupsClaim=$GROUPS_CLAIM")
helm_args+=(--set-string "controlPlane.oidc.rolesClaim=$ROLES_CLAIM")
# org-admin is org-scoped (safe). Set only when provided so an empty value never
# overrides a previously-configured group via --reuse-values.
[[ -n "$ORG_ADMIN_GROUPS" ]] && helm_args+=(--set-string "controlPlane.oidc.orgAdminGroups=$ORG_ADMIN_GROUPS")

# ── Cross-org guardrail: platform-operator grants are EXPLICIT + loudly warned.
if [[ -n "$PLATFORM_OPERATOR_GROUPS" ]]; then
  warn "Granting PLATFORM-OPERATOR (cross-ClusterTenant) to group(s): $PLATFORM_OPERATOR_GROUPS — these can manage EVERY org."
  helm_args+=(--set-string "controlPlane.oidc.platformOperatorGroups=$PLATFORM_OPERATOR_GROUPS")
fi
if [[ -n "$PLATFORM_OPERATOR_SEED_EMAIL" ]]; then
  warn "Seeding PLATFORM-OPERATOR by verified email: $PLATFORM_OPERATOR_SEED_EMAIL — remove the seed once a group mapping exists."
  helm_args+=(--set-string "controlPlane.oidc.platformOperatorSeedEmail=$PLATFORM_OPERATOR_SEED_EMAIL")
fi
if [[ -z "$PLATFORM_OPERATOR_GROUPS" && -z "$PLATFORM_OPERATOR_SEED_EMAIL" ]]; then
  log "No platform-operator grant supplied — cross-org access stays fail-closed (nobody is an operator)."
fi

log "helm upgrade '$RELEASE' (existing values preserved, OIDC layered on top)…"
helm "${helm_args[@]}"

if [[ "$DRY_RUN" -eq 0 ]]; then
  kubectl ${KCTL[@]+"${KCTL[@]}"} -n "$NAMESPACE" rollout status deploy/"$RELEASE"-control-plane --timeout=180s
  log "OIDC configured. Issuer: $ISSUER_URL  ·  redirect: $REDIRECT_URI  ·  context: $_active_context"
  log "Verify discovery is reachable from the control-plane and that '${ISSUER_URL%/}/.well-known/openid-configuration' resolves."
else
  log "[dry-run] complete — no changes applied."
fi
