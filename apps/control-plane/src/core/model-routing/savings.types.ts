/**
 * Pure-function types for the AIR.6 shadow (on-policy paired) savings estimator.
 *
 * The estimator is I/O-free: callers feed it per-call paired samples (one logged call run
 * through both the current baseline model and a cheaper candidate, each judged) and it returns
 * the projected spend saved at equal quality plus a bootstrap confidence interval. It changes no
 * live routing — it only quantifies what routing *would* save.
 */

/** One on-policy paired sample: a single logged call run through baseline and candidate. */
export interface SavingsSample
{
  /** Whether the candidate cleared the skill's quality bar on this call (judge score ≥ bar). */
  passedBar: boolean;
  /** Cost (USD) of serving this call on the current baseline/default model. */
  baselineCostUsd: number;
  /** Cost (USD) of serving this call on the candidate model. */
  candidateCostUsd: number;
}

/** Options controlling the bootstrap CI computation. */
export interface SavingsOptions
{
  /** Number of bootstrap resamples to draw for the CI (default 1000). */
  bootstrapSamples?: number;
  /** Injectable uniform RNG in [0, 1); defaults to Math.random. Inject for deterministic tests. */
  rng?: () => number;
}

/** The AIR.6 shadow-savings estimate for one skill+candidate pairing. */
export interface SavingsEstimate
{
  /** Share of sampled calls the candidate served at-or-above the bar (`passedBar` fraction). */
  atBarCheapFraction: number;
  /** Point estimate of % spend saved at equal quality (`1 - sum(effective)/sum(baseline)` ×100). */
  projectedSavingsPct: number;
  /** Lower bound of the bootstrap 95% CI on `projectedSavingsPct`. */
  ciLowPct: number;
  /** Upper bound of the bootstrap 95% CI on `projectedSavingsPct`. */
  ciHighPct: number;
}
