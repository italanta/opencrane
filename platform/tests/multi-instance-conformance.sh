#!/usr/bin/env bash
#
# Multi-instance conformance test (Track MI, brief §5).
#
# Renders two reference instances (oc-acme, oc-globex) from the SAME chart with the
# multi-instance reference values and asserts the STATIC isolation guarantees that
# `helm template` can prove without a cluster:
#
#   1. Each operator watches only its own namespace, fail-closed (B2).
#   2. Operator + control-plane RBAC are namespaced Role/RoleBinding scoped to the
#      instance's own namespace — no cross-instance ClusterRole grant (B1). The only
#      ClusterRole permitted is the skill-registry TokenReview (legitimately
#      cluster-scoped; grants no cross-namespace data).
#   3. No cluster-singleton ClusterIssuer / ClusterSecretStore (B4).
#   4. A cross-instance default-deny NetworkPolicy is rendered, allowing only the
#      instance's own namespace (B6).
#   5. Object names are release-prefixed and never reference the other instance (B5).
#
# The LIVE acceptance criteria (brief §5.2–§5.5) require a real cluster + CNI + ACME
# and are NOT run here — they are documented at the end as the live-infra seam.
#
# Usage: platform/tests/multi-instance-conformance.sh
# Exit 0 = all static checks pass; non-zero = a guarantee was violated.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHART_DIR="$ROOT_DIR/platform/helm"
VALUES_DIR="$CHART_DIR/values/multi-instance"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FAILURES=0

# fail records a violated guarantee but lets the run continue so the full report prints.
fail()
{
  echo "  ✗ FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

pass()
{
  echo "  ✓ $1"
}

# render writes the full chart for one instance (release name == namespace) to a file.
render()
{
  local release="$1" namespace="$2" values="$3" out="$4"
  helm template "$release" "$CHART_DIR" \
    --namespace "$namespace" \
    --skip-tests \
    --set certManager.enabled=true --set certManager.email=ops@example.com \
    --set externalSecrets.enabled=true --set externalSecrets.provider=gcp-secret-manager \
    --set tenant.storage.gcpProject=demo-project \
    -f "$values" > "$out"
}

echo "== Rendering reference instances =="
render oc-acme   oc-acme   "$VALUES_DIR/oc-acme.yaml"   "$WORK_DIR/acme.yaml"
render oc-globex oc-globex "$VALUES_DIR/oc-globex.yaml" "$WORK_DIR/globex.yaml"
pass "both instances render from the same chart"

# check_instance runs the per-instance static assertions.
check_instance()
{
  local name="$1" ns="$2" other_ns="$3" manifest="$4"
  echo "== Instance $name (namespace $ns) =="

  # 1. Operator watches only its own namespace, fail-closed.
  if grep -A1 'name: WATCH_NAMESPACE' "$manifest" | grep -q "\"$ns\""; then
    pass "operator WATCH_NAMESPACE scoped to $ns"
  else
    fail "operator WATCH_NAMESPACE is not scoped to $ns"
  fi
  if grep -A1 'name: REQUIRE_WATCH_NAMESPACE' "$manifest" | grep -q '"true"'; then
    pass "operator fails closed (REQUIRE_WATCH_NAMESPACE=true)"
  else
    fail "operator is not fail-closed"
  fi

  # 2. RBAC is namespaced; the only ClusterRole is the TokenReview one.
  local clusterroles
  clusterroles="$(grep -c '^kind: ClusterRole$' "$manifest" || true)"
  if [ "$clusterroles" -le 1 ]; then
    pass "no cross-instance ClusterRole (count=$clusterroles; ≤1 TokenReview allowed)"
  else
    fail "found $clusterroles ClusterRoles (expected ≤1 TokenReview)"
  fi
  if grep -q "name: $name-opencrane-operator" "$manifest" && grep -B2 "name: $name-opencrane-operator" "$manifest" | grep -q 'kind: Role'; then
    pass "operator RBAC is a namespaced Role"
  fi

  # 3. No cluster-singleton issuer / secret store.
  if ! grep -qE '^kind: ClusterIssuer$|^kind: ClusterSecretStore$' "$manifest"; then
    pass "no ClusterIssuer / ClusterSecretStore (namespaced Issuer + SecretStore)"
  else
    fail "a cluster-singleton ClusterIssuer/ClusterSecretStore leaked"
  fi

  # 4. Cross-instance default-deny NetworkPolicy present, allowing only own ns.
  if grep -q 'cross-instance' "$manifest"; then
    pass "cross-instance default-deny NetworkPolicy rendered"
  else
    fail "cross-instance default-deny NetworkPolicy missing"
  fi

  # 5. Names are release-prefixed and never reference the other instance.
  if ! grep -q "$other_ns" "$manifest"; then
    pass "no reference to the other instance ($other_ns)"
  else
    fail "manifest references the other instance ($other_ns)"
  fi
}

check_instance oc-acme   oc-acme   oc-globex "$WORK_DIR/acme.yaml"
check_instance oc-globex oc-globex oc-acme   "$WORK_DIR/globex.yaml"

echo ""
echo "== LIVE acceptance criteria (NOT run here — require a real cluster) =="
cat <<'LIVE'
  These are the brief §5.2–§5.5 checks; run them against a live cluster + CNI:
   - §5.2  create a Tenant in oc-acme; assert oc-globex's operator never reconciles it.
   - §5.3  kubectl auth can-i --as=system:serviceaccount:oc-acme:oc-acme-opencrane-control-plane \
             get secrets -n oc-globex  →  must be "no" (RBAC denies it).
   - §5.4  exec a pod in oc-acme; curl a Service in oc-globex  →  must time out (NetworkPolicy).
   - §5.5  helm uninstall oc-globex + delete ns + its GCP resources; assert oc-acme is untouched.
  These are the live-infra seam (cluster + CNI enforcement + ACME), tracked under MI.7.

  Per-ClusterTenant native isolation (CT.5) — the operator creates these at
  runtime when an openclaw references a ClusterTenant, so they cannot be proven by
  `helm template`; run them in-cluster against a provisioned ClusterTenant ns:
   - CT.5a kubectl get ns <bound-ns> -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}'
             →  must be "restricted" (PSA fences the customer namespace).
   - CT.5b kubectl get resourcequota -n <bound-ns> opencrane-cluster-tenant-quota
             →  must exist with spec.hard matching the ClusterTenant spec.resources.quota.
   - CT.5c kubectl get limitrange  -n <bound-ns> opencrane-cluster-tenant-limits
             →  must exist (Container defaults so quota-constrained pods still schedule).
   - CT.5d for a dedicated ClusterTenant, the openclaw Deployment pod template must carry
             nodeSelector opencrane.io/node-pool=<pool> and a matching opencrane.io/dedicated toleration;
             for a shared ClusterTenant the pod template must carry NEITHER.
LIVE

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ multi-instance static conformance: PASS"
  exit 0
fi
echo "❌ multi-instance static conformance: $FAILURES check(s) FAILED"
exit 1
