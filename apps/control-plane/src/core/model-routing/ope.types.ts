/**
 * Pure-function types for the AIR.7 off-policy evaluation (OPE) substrate.
 *
 * OPE assesses a *candidate* routing policy from logged decisions made under the *current* policy,
 * without ever serving the candidate to live traffic. This is the math substrate the live
 * improvement loop calls; the full RouteLLM/bandit training that produces candidate policies is an
 * explicit out-of-scope seam (see `app-specific.md`).
 */

/** One logged decision with the facts needed to score a candidate policy off-policy. */
export interface OpeSample
{
  /** The action (model) the logging policy actually took on this call. */
  loggedAction: string;
  /** The action (model) the candidate policy would take on the same call. */
  candidateAction: string;
  /** The observed reward of the logged action (e.g. judge score minus normalised cost). */
  reward: number;
  /** Probability the logging policy assigned to `loggedAction` (the propensity; must be > 0). */
  propensity: number;
  /** A reward model's predicted reward for `candidateAction` on this call (the DR baseline). */
  rewardModelPred: number;
}

/** Options for the bootstrap CI over an OPE point estimate. */
export interface OpeCiOptions
{
  /** Number of bootstrap resamples (default 1000). */
  bootstrapSamples?: number;
  /** Injectable uniform RNG in [0, 1); defaults to Math.random. */
  rng?: () => number;
}

/** An OPE value estimate with a bootstrap 95% confidence interval. */
export interface OpeEstimate
{
  /** The point value estimate of the candidate policy's expected reward. */
  value: number;
  /** Lower bound of the bootstrap 95% CI. */
  ciLow: number;
  /** Upper bound of the bootstrap 95% CI. */
  ciHigh: number;
}
