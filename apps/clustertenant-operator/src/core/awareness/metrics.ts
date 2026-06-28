import type { AwarenessRolloutState } from "./rollout.types.js";
import type { FleetParticipationReport } from "./participation.types.js";

/**
 * Render awareness SLO metrics in the Prometheus text exposition format (P4B.6).
 *
 * Pure: derived entirely from the fleet participation report + rollout state so
 * it is unit-testable without a scrape. These feed the awareness Grafana
 * dashboard and the SLO alerts (`apps/fleet-platform/templates/awareness-prometheusrule.yaml`):
 *   - `opencrane_awareness_policy_violations_total` → critical/page (locked: rate must be 0)
 *   - drift + non-participation gauges → warning
 *   - rollout frontier/info gauges for the canary dashboard
 *
 * @param report  - The fleet participation report.
 * @param rollout - The current awareness rollout state.
 * @returns Prometheus exposition text (no trailing newline).
 */
export function _RenderAwarenessMetrics(report: FleetParticipationReport, rollout: AwarenessRolloutState): string
{
  // 1. Sum policy violations across the fleet — the hard-gate (page) signal.
  const policyViolations = report.tenants.reduce(function _sum(acc, t) { return acc + t.policyViolations; }, 0);
  const nonParticipating = report.total - report.participating;

  // 2. Emit one sample per SLO signal. Counts are gauges (current fleet state).
  return [
    "# HELP opencrane_awareness_tenants_total Tenants tracked for awareness participation",
    "# TYPE opencrane_awareness_tenants_total gauge",
    `opencrane_awareness_tenants_total ${report.total}`,

    "",
    "# HELP opencrane_awareness_participating_total Tenants seen within the staleness window",
    "# TYPE opencrane_awareness_participating_total gauge",
    `opencrane_awareness_participating_total ${report.participating}`,

    "",
    "# HELP opencrane_awareness_non_participating_total Tenants not seen within the staleness window (warning)",
    "# TYPE opencrane_awareness_non_participating_total gauge",
    `opencrane_awareness_non_participating_total ${nonParticipating}`,

    "",
    "# HELP opencrane_awareness_drifted_total Tenants whose running contract version differs from expected (warning)",
    "# TYPE opencrane_awareness_drifted_total gauge",
    `opencrane_awareness_drifted_total ${report.drifted}`,

    "",
    "# HELP opencrane_awareness_policy_violations_total Total policy-violating skill executions across the fleet (critical)",
    "# TYPE opencrane_awareness_policy_violations_total gauge",
    `opencrane_awareness_policy_violations_total ${policyViolations}`,

    "",
    "# HELP opencrane_awareness_tenants_by_severity Tenants by monitoring severity",
    "# TYPE opencrane_awareness_tenants_by_severity gauge",
    `opencrane_awareness_tenants_by_severity{severity="critical"} ${report.critical}`,
    `opencrane_awareness_tenants_by_severity{severity="warning"} ${report.warning}`,
    `opencrane_awareness_tenants_by_severity{severity="ok"} ${report.total - report.critical - report.warning}`,

    "",
    "# HELP opencrane_awareness_rollout_promoted_waves Number of canary waves promoted to the target version",
    "# TYPE opencrane_awareness_rollout_promoted_waves gauge",
    `opencrane_awareness_rollout_promoted_waves ${rollout.promotedWaves.length}`,

    "",
    "# HELP opencrane_awareness_rollout_info Current awareness rollout target/stable versions (value always 1)",
    "# TYPE opencrane_awareness_rollout_info gauge",
    `opencrane_awareness_rollout_info{target="${_escapeLabel(rollout.targetVersion)}",stable="${_escapeLabel(rollout.stableVersion)}"} 1`,
  ].join("\n");
}

/**
 * Escape a Prometheus label value (backslash, double-quote, newline).
 * @param value - The raw label value.
 */
function _escapeLabel(value: string): string
{
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}
