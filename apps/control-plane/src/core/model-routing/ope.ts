import type { OpeCiOptions, OpeEstimate, OpeSample } from "./ope.types.js";

/** Default number of bootstrap resamples for the OPE CI helper. */
const _DEFAULT_BOOTSTRAP = 1000;

/**
 * Replay (a.k.a. matched/rejection-sampling) estimate of a candidate policy's value.
 *
 * Keep only the logged calls where the candidate would have taken the same action as the logging
 * policy, then average their observed rewards. Unbiased under a uniform logging policy; simple and
 * assumption-light, but discards non-matching logs. Returns 0 when no logged action matches.
 *
 * @param samples - Logged decisions with `loggedAction`, `candidateAction`, and `reward`.
 * @returns The mean observed reward over the matched subset (0 when nothing matches).
 */
export function _ReplayEstimate(samples: readonly OpeSample[]): number
{
  let total = 0;
  let matched = 0;
  for (const s of samples)
  {
    // Only matched actions carry information about the candidate under replay.
    if (s.loggedAction === s.candidateAction)
    {
      total += s.reward;
      matched += 1;
    }
  }
  if (matched === 0)
  {
    return 0;
  }
  return total / matched;
}

/**
 * Doubly-robust (DR) estimate of a candidate policy's value.
 *
 * DR combines a direct reward-model baseline with an importance-weighted correction applied only on
 * matched actions: `mean( rewardModelPred + 1[match] · (reward − rewardModelPred) / propensity )`.
 * It is consistent if *either* the reward model *or* the propensities are correct, hence "doubly
 * robust". A non-positive propensity on a matched sample would blow up the correction, so such
 * samples contribute the direct term only (the correction is skipped).
 *
 * @param samples - Logged decisions with action pair, reward, propensity, and reward-model prediction.
 * @returns The DR value estimate (0 for empty input).
 */
export function _DoublyRobustEstimate(samples: readonly OpeSample[]): number
{
  if (samples.length === 0)
  {
    return 0;
  }

  let total = 0;
  for (const s of samples)
  {
    // 1. Direct method baseline: the reward model's prediction for the candidate action.
    let contribution = s.rewardModelPred;

    // 2. IPS correction on matched actions only, guarded against a non-positive propensity that
    //    would otherwise divide-by-zero / explode the estimate.
    if (s.loggedAction === s.candidateAction && s.propensity > 0)
    {
      contribution += (s.reward - s.rewardModelPred) / s.propensity;
    }

    total += contribution;
  }
  return total / samples.length;
}

/**
 * Draw one bootstrap resample (with replacement) of size `n` using the injected RNG.
 *
 * @param samples - Source samples.
 * @param rng     - Uniform RNG in [0, 1).
 * @returns A resampled array of the same length.
 */
function _resample(samples: readonly OpeSample[], rng: () => number): OpeSample[]
{
  const n = samples.length;
  const out: OpeSample[] = new Array(n);
  for (let i = 0; i < n; i++)
  {
    const idx = Math.min(n - 1, Math.floor(rng() * n));
    out[i] = samples[idx];
  }
  return out;
}

/**
 * Read the value at the given percentile from a pre-sorted ascending array (nearest-rank).
 *
 * @param sorted     - Ascending-sorted values.
 * @param percentile - Percentile in [0, 1].
 * @returns The value at that percentile, or 0 for an empty array.
 */
function _percentile(sorted: readonly number[], percentile: number): number
{
  if (sorted.length === 0)
  {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(percentile * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Bootstrap a 95% CI around an OPE point estimator.
 *
 * Generic over the estimator so it wraps either {@link _ReplayEstimate} or
 * {@link _DoublyRobustEstimate}. The RNG is injectable for deterministic tests.
 *
 * @param samples   - The logged decisions.
 * @param estimator - The point estimator to bootstrap.
 * @param options   - Bootstrap count + injectable RNG.
 * @returns The point value plus the bootstrap 95% CI bounds.
 */
export function _OpeEstimateWithCi(
  samples: readonly OpeSample[],
  estimator: (s: readonly OpeSample[]) => number,
  options: OpeCiOptions = {},
): OpeEstimate
{
  // 1. Empty input has no signal — return an all-zero estimate.
  if (samples.length === 0)
  {
    return { value: 0, ciLow: 0, ciHigh: 0 };
  }

  const rng = options.rng ?? Math.random;
  const bootstrapSamples = options.bootstrapSamples ?? _DEFAULT_BOOTSTRAP;

  // 2. Point estimate over the observed samples.
  const value = estimator(samples);

  // 3. Bootstrap the CI: resample, re-estimate, sort, read the 2.5/97.5 percentiles.
  const draws: number[] = new Array(bootstrapSamples);
  for (let i = 0; i < bootstrapSamples; i++)
  {
    draws[i] = estimator(_resample(samples, rng));
  }
  draws.sort(function _asc(a, b) { return a - b; });

  return { value, ciLow: _percentile(draws, 0.025), ciHigh: _percentile(draws, 0.975) };
}
