import type { AwarenessResult } from "../awareness-client.types.js";
import { ConformanceDimension } from "./golden.types.js";
import type { ConformanceCheck, GoldenQuery, GoldenResult } from "./golden.types.js";

/** Default freshness SLO: a source older than 24h fails the freshness dimension. */
const _DEFAULT_MAX_FRESHNESS_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate an awareness result against a golden query across all four
 * conformance dimensions (P4B.4). Pure: `nowMs` is injected so freshness checks
 * are deterministic and testable.
 *
 * @param result - The SDK result for the golden query.
 * @param golden - The golden query + its expected-conformance assertions.
 * @param nowMs  - Current time in epoch ms (for freshness age).
 * @returns The per-dimension conformance result for this query.
 */
export function ___EvaluateGolden(result: AwarenessResult, golden: GoldenQuery, nowMs: number): GoldenResult
{
  const checks: ConformanceCheck[] = [
    _checkCitation(result),
    _checkPolicySafety(result, golden),
    _checkFreshness(result, golden, nowMs),
    _checkCorrectness(result, golden),
  ];
  return { id: golden.id, query: golden.query, passed: checks.every(function _ok(c) { return c.passed; }), checks, hits: result.hits.length };
}

/**
 * Citation: no retrieved hit was uncitable (the SDK already drops uncitable hits,
 * so a non-zero `droppedUncitable` means the corpus has unattributable sources).
 * @param result - The SDK result.
 */
function _checkCitation(result: AwarenessResult): ConformanceCheck
{
  const passed = result.droppedUncitable === 0;
  return {
    dimension: ConformanceDimension.Citation,
    passed,
    detail: passed ? "all hits citable" : `${result.droppedUncitable} hit(s) dropped as uncitable`,
  };
}

/**
 * Policy safety (hard gate): every hit's datasets must be within the principal's
 * allowed set. Any out-of-scope dataset is a violation.
 * @param result - The SDK result.
 * @param golden - The golden query (carries `allowedDatasets`).
 */
function _checkPolicySafety(result: AwarenessResult, golden: GoldenQuery): ConformanceCheck
{
  const allowed = new Set(golden.allowedDatasets);
  const leaked = new Set<string>();
  for (const hit of result.hits)
  {
    for (const dataset of hit.datasets)
    {
      if (!allowed.has(dataset))
      {
        leaked.add(dataset);
      }
    }
  }
  const passed = leaked.size === 0;
  return {
    dimension: ConformanceDimension.PolicySafety,
    passed,
    detail: passed ? "no out-of-scope datasets" : `out-of-scope datasets leaked: ${Array.from(leaked).sort().join(", ")}`,
  };
}

/**
 * Freshness: every hit's source must be within the freshness SLO. An
 * unparseable timestamp fails (we cannot prove freshness). A future-dated source
 * (parsed > nowMs → negative age) is treated as fresh — deliberate clock-skew
 * tolerance so minor producer/consumer clock drift does not flag false staleness.
 * @param result - The SDK result.
 * @param golden - The golden query (optional `maxFreshnessAgeMs`).
 * @param nowMs  - Current time in epoch ms.
 */
function _checkFreshness(result: AwarenessResult, golden: GoldenQuery, nowMs: number): ConformanceCheck
{
  const maxAge = golden.maxFreshnessAgeMs ?? _DEFAULT_MAX_FRESHNESS_AGE_MS;
  const stale: string[] = [];
  for (const hit of result.hits)
  {
    const parsed = Date.parse(hit.citation.freshnessTimestamp);
    if (Number.isNaN(parsed) || nowMs - parsed > maxAge)
    {
      stale.push(hit.citation.uri);
    }
  }
  const passed = stale.length === 0;
  return {
    dimension: ConformanceDimension.Freshness,
    passed,
    detail: passed ? "all sources fresh" : `stale/undatable source(s): ${stale.join(", ")}`,
  };
}

/**
 * Correctness: every expected substring must appear in some hit's content
 * (case-insensitive). No expectations → trivially passes.
 * @param result - The SDK result.
 * @param golden - The golden query (optional `expectedContains`).
 */
function _checkCorrectness(result: AwarenessResult, golden: GoldenQuery): ConformanceCheck
{
  const expected = golden.expectedContains ?? [];
  const haystack = result.hits.map(function _content(h) { return h.content.toLowerCase(); });
  const missing = expected.filter(function _absent(needle)
  {
    const lower = needle.toLowerCase();
    return !haystack.some(function _has(content) { return content.includes(lower); });
  });
  const passed = missing.length === 0;
  return {
    dimension: ConformanceDimension.Correctness,
    passed,
    detail: passed ? "all expected facts present" : `missing expected: ${missing.join(", ")}`,
  };
}
