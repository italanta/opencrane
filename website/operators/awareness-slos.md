# Runbook — Fleet Awareness SLOs

Operational runbook for the OpenCrane fleet-awareness SLO alerts (P4B.6). Alerts
are defined in `apps/fleet-platform/templates/awareness-prometheusrule.yaml` and fire on
metrics from the control-plane `/prom` endpoint (`opencrane_awareness_*`). The
dashboard is "OpenCrane — Fleet Awareness SLOs" (uid `opencrane-awareness-slo`).

Severity follows the locked model: **policy-violation = page**, **drift /
non-participation = warn**.

## policy-violations

**Alert:** `AwarenessPolicyViolations` — `opencrane_awareness_policy_violations_total > 0` (paging).

A tenant reported a policy-violating skill execution. The locked SLO is a rate of
**0**, so any non-zero value pages.

1. Identify the tenant(s): `oc awareness participation --severity critical`.
2. Inspect the violating executions in the participation events / audit log for
   that tenant; determine which skill + scope was involved.
3. Confirm the grant compiler + Cognee ACL (P4B.2) are correctly denying the
   out-of-scope access — a violation here means a skill executed against a
   resource the tenant should not reach.
4. If the grant is wrong, fix the AccessPolicy/grant (propagation re-syncs Cognee);
   if the skill is malicious/misconfigured, demote/withdraw it from the catalog.
5. The counter is cumulative; it clears when the underlying cause stops producing
   new violation events and the rollup is reset (or the window rolls).

## version-drift

**Alert:** `AwarenessVersionDrift` — `opencrane_awareness_drifted_total > 0` (warning).

Tenants are running an awareness contract version different from the one their
rollout wave expects. Usually transient during a canary promotion.

1. `oc awareness participation --severity warning` to list drifted tenants;
   `oc awareness rollout show` for the current target/frontier.
2. If drift persists past a promotion, the tenant pod has not re-pulled the
   contract — check the pod's contract poll loop / connectivity.
3. A drift that should not exist (tenant ahead/behind unexpectedly) may indicate a
   failed rollback — consider `oc awareness rollout rollback`.

## non-participation

**Alert:** `AwarenessNonParticipation` — `opencrane_awareness_non_participating_total > 0` (warning).

Tenants have not reported a participation event within the staleness window.

1. `oc awareness participation --severity warning` to list non-participating tenants.
2. Confirm the tenant pod is running and can reach the control-plane internal
   participation endpoint (NetworkPolicy + projected `control-plane` token).
3. A newly-provisioned tenant that has never emitted an event will show here until
   its first heartbeat/agent-card — expected during onboarding.
