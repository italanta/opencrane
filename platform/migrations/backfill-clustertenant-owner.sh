#!/usr/bin/env bash
# =============================================================================
# OpenCrane — backfill ClusterTenant spec.owner (one-time data migration)
#
# Owner identity moved from the legacy `opencrane.io/owner-email` annotation to the
# validated `spec.owner` field. CRs created before that change (or created via a
# control plane that stamped only the annotation) carry no `spec.owner`, so the
# operator skips seeding their default Tenant. This script stamps `spec.owner` onto
# each such CR so the next reconcile seeds the workspace.
#
# The owner SUBJECT is authoritative in the control-plane database (`org_memberships`,
# role = owner) and is read from there per org. The owner EMAIL was never persisted —
# it only ever lived on the session/CR — so it must be supplied (--email), or per org
# via --email-for <org>=<email> (repeatable). Without an email the operator still
# cannot seed the default Tenant (the Tenant CRD requires a valid email), so an org
# with no email resolved is reported and left for a re-run.
#
# Idempotent: merge-patches spec.owner; re-running on a converged CR is a no-op.
#
# Usage:
#   ./platform/migrations/backfill-clustertenant-owner.sh --email owner@example.com
#   ./platform/migrations/backfill-clustertenant-owner.sh \
#       --email-for elewa=jente@elewa.ke --email-for elewa-be=jente@elewa.ke
#   # optional: restrict to specific orgs, point at the DB pod/namespace
#   ./platform/migrations/backfill-clustertenant-owner.sh --email x@y.z --only elewa,northwind \
#       --db-namespace opencrane-system --db-pod opencrane-db-1 --db-user postgres --db-name opencrane
#
# Prereqs: kubectl (pointed at the target cluster). Apply the updated CRD first
# (via the deploy script) so the `spec.owner` schema exists.
# =============================================================================
set -euo pipefail

GROUP="opencrane.io"
VERSION="v1alpha1"
PLURAL="clustertenants"

DEFAULT_EMAIL=""
declare -A EMAIL_FOR=()
ONLY=""
DB_NAMESPACE="opencrane-system"
DB_POD="opencrane-db-1"
DB_USER="postgres"
DB_NAME="opencrane"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)         DEFAULT_EMAIL="$2"; shift 2 ;;
    --email-for)     EMAIL_FOR["${2%%=*}"]="${2#*=}"; shift 2 ;;
    --only)          ONLY="$2"; shift 2 ;;
    --db-namespace)  DB_NAMESPACE="$2"; shift 2 ;;
    --db-pod)        DB_POD="$2"; shift 2 ;;
    --db-user)       DB_USER="$2"; shift 2 ;;
    --db-name)       DB_NAME="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Detect the CRD's served version so we patch the right API version.
detected_version="$(kubectl get crd "${PLURAL}.${GROUP}" -o jsonpath='{.spec.versions[?(@.served==true)].name}' 2>/dev/null | awk '{print $1}')"
[[ -n "$detected_version" ]] && VERSION="$detected_version"

# Read the owner subject for an org from the control-plane DB (role = owner).
owner_subject_for() {
  local org="$1"
  kubectl exec -n "$DB_NAMESPACE" "$DB_POD" -- \
    psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT subject FROM org_memberships WHERE cluster_tenant = '${org}' AND role = 'owner' LIMIT 1;" \
    2>/dev/null | tr -d '[:space:]'
}

email_for() {
  local org="$1"
  if [[ -n "${EMAIL_FOR[$org]:-}" ]]; then echo "${EMAIL_FOR[$org]}"; else echo "$DEFAULT_EMAIL"; fi
}

mapfile -t orgs < <(kubectl get "$PLURAL.$GROUP" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a only_arr <<< "$ONLY"
fi

patched=0; skipped=0
for org in "${orgs[@]}"; do
  [[ -z "$org" ]] && continue
  if [[ -n "$ONLY" ]] && ! printf '%s\n' "${only_arr[@]}" | grep -qx "$org"; then continue; fi

  existing_subject="$(kubectl get "$PLURAL.$GROUP" "$org" -o jsonpath='{.spec.owner.subject}' 2>/dev/null)"
  existing_email="$(kubectl get "$PLURAL.$GROUP" "$org" -o jsonpath='{.spec.owner.email}' 2>/dev/null)"

  subject="$existing_subject"
  [[ -z "$subject" ]] && subject="$(owner_subject_for "$org")"
  if [[ -z "$subject" ]]; then
    echo "SKIP  $org — no owner subject in spec.owner or org_memberships"; ((skipped++)); continue
  fi

  email="$(email_for "$org")"
  [[ -z "$email" ]] && email="$existing_email"
  if [[ -z "$email" ]]; then
    echo "SKIP  $org — owner subject '$subject' resolved but no email (pass --email or --email-for $org=...)"; ((skipped++)); continue
  fi

  if [[ "$existing_subject" == "$subject" && "$existing_email" == "$email" ]]; then
    echo "OK    $org — spec.owner already converged (subject=$subject email=$email)"; continue
  fi

  patch="{\"spec\":{\"owner\":{\"subject\":\"$subject\",\"email\":\"$email\"}}}"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY   $org — would merge-patch $patch"; ((patched++)); continue
  fi
  kubectl patch "$PLURAL.$GROUP" "$org" --type=merge -p "$patch"
  echo "PATCH $org — spec.owner set (subject=$subject email=$email)"; ((patched++))
done

echo "---"
echo "Done: $patched patched/queued, $skipped skipped."
echo "The operator seeds each org's default Tenant on its next reconcile (touch the spec to force one, e.g. kubectl patch ... --type=merge -p '{\"spec\":{\"displayName\":\"...\"}}')."
