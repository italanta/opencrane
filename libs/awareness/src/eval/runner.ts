import type { AwarenessClient } from "../awareness-client.js";
import { ___EvaluateGolden } from "./conformance.js";
import type { GoldenQuery, GoldenResult, SuiteReport } from "./golden.types.js";

/**
 * Run a golden-query suite against an awareness client and aggregate a
 * conformance report (P4B.4). Each query is run through the SDK and evaluated
 * across all four dimensions.
 *
 * @param client - The awareness client to query (live Cognee or a stubbed transport).
 * @param goldens - The golden queries to run.
 * @param nowMs  - Current time in epoch ms (for deterministic freshness checks).
 * @returns The aggregate suite report.
 */
export async function ___RunGoldenSuite(client: AwarenessClient, goldens: GoldenQuery[], nowMs: number): Promise<SuiteReport>
{
  const results: GoldenResult[] = [];
  for (const golden of goldens)
  {
    // Run each golden serially so a flaky transport surfaces per-query, not as a
    // single rejected batch — conformance reporting needs per-query attribution.
    // A query error becomes a failed result (verification impossible) rather than
    // rejecting the whole suite.
    try
    {
      const result = await client.query({ query: golden.query, datasets: golden.datasets });
      results.push(___EvaluateGolden(result, golden, nowMs));
    }
    catch (err)
    {
      results.push({ id: golden.id, query: golden.query, passed: false, checks: [], hits: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const passed = results.filter(function _ok(r) { return r.passed; }).length;
  const policyViolations = results.filter(function _violated(r)
  {
    return r.checks.some(function _isPolicyFail(c) { return c.dimension === "policy-safety" && !c.passed; });
  }).length;
  const errors = results.filter(function _errored(r) { return r.error !== undefined; }).length;

  return { total: results.length, passed, failed: results.length - passed, policyViolations, errors, results };
}

/**
 * Whether a suite report passes the rollout gate (P4B.4 → gates P4B.3).
 *
 * The **hard gate** is the locked SLO: **zero policy-safety violations**
 * (violation = page). Query **errors** also block, because an unevaluated golden
 * means safety could not be verified — a green gate must mean every golden was
 * actually checked. The other dimensions (citation, freshness, correctness) are
 * quality **warnings** (drift = warn): they surface in `report.failed`/`results`
 * but do not, on their own, block a promotion. Elevate one to a hard gate by
 * tightening this predicate if a stricter policy is adopted.
 *
 * @param report - The aggregate suite report.
 * @returns True when no policy violations and no query errors — safe to promote.
 */
export function ___SuiteGatesRollout(report: SuiteReport): boolean
{
  return report.policyViolations === 0 && report.errors === 0;
}
