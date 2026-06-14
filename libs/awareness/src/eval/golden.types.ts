/** The four awareness conformance dimensions (locked P4B.0 SLOs). */
export enum ConformanceDimension
{
  /** Every returned hit carries a complete citation (no uncitable hits dropped). */
  Citation = "citation",
  /** No hit comes from a dataset outside the principal's allowed set (0 violations). */
  PolicySafety = "policy-safety",
  /** Every hit's source is fresh within the freshness SLO (default 24h). */
  Freshness = "freshness",
  /** Expected facts appear in the retrieved content. */
  Correctness = "correctness",
}

/** A single golden query and its expected-conformance assertions. */
export interface GoldenQuery
{
  /** Stable identifier for reporting. */
  id: string;
  /** The natural-language query to run. */
  query: string;
  /** Datasets to search (passed through to the SDK). */
  datasets?: string[];
  /**
   * The datasets the querying principal is allowed to see. Any hit from a
   * dataset outside this set is a **policy violation** (the hard-gate dimension).
   */
  allowedDatasets: string[];
  /** Substrings that must appear in some hit's content (correctness). */
  expectedContains?: string[];
  /** Max acceptable source age in ms; defaults to the 24h freshness SLO. */
  maxFreshnessAgeMs?: number;
}

/** Result of evaluating one conformance dimension. */
export interface ConformanceCheck
{
  /** Which dimension this check covers. */
  dimension: ConformanceDimension;
  /** Whether the dimension passed. */
  passed: boolean;
  /** Human-readable detail (failure reason, or a brief pass note). */
  detail: string;
}

/** Per-golden-query conformance result. */
export interface GoldenResult
{
  /** The golden query id. */
  id: string;
  /** The query string. */
  query: string;
  /** Whether every dimension passed (false if the query errored). */
  passed: boolean;
  /** Per-dimension checks (empty when the query errored before evaluation). */
  checks: ConformanceCheck[];
  /** Count of hits returned by the query. */
  hits: number;
  /** Set when the query itself failed (transport/Cognee error) — verification impossible. */
  error?: string;
}

/** Aggregate report over a golden-query suite. */
export interface SuiteReport
{
  /** Total golden queries evaluated. */
  total: number;
  /** Number that passed every dimension. */
  passed: number;
  /** Number with at least one failed dimension or a query error. */
  failed: number;
  /**
   * Number of policy-safety violations across the suite. This is the **hard
   * gate** per the locked SLO (violation = page); the other dimension failures
   * are quality warnings (drift = warn).
   */
  policyViolations: number;
  /**
   * Number of golden queries that errored (could not be evaluated). Verification
   * was impossible, so these also block the rollout gate — a green gate must mean
   * every golden was actually checked.
   */
  errors: number;
  /** Per-query results. */
  results: GoldenResult[];
}
