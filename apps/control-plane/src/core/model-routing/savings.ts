import type { SavingsEstimate, SavingsOptions, SavingsSample } from "./savings.types.js";

/** Default number of bootstrap resamples — enough to stabilise a 95% CI for typical eval-set sizes. */
const _DEFAULT_BOOTSTRAP = 1000;

/**
 * Compute the on-policy paired effective spend for a set of samples.
 *
 * The shadow router would route a call to the candidate only when it clears the bar, otherwise it
 * keeps the baseline. So the effective cost of each call is `passedBar ? candidate : baseline`.
 * Returns both the effective total and the baseline total so the caller can form the ratio.
 *
 * @param samples - The paired samples (may be a bootstrap resample).
 * @returns The summed effective and baseline spend across the samples.
 */
function _spendTotals(samples: readonly SavingsSample[]): { effective: number; baseline: number }
{
  let effective = 0;
  let baseline = 0;
  for (const s of samples)
  {
    baseline += s.baselineCostUsd;
    effective += s.passedBar ? s.candidateCostUsd : s.baselineCostUsd;
  }
  return { effective, baseline };
}

/**
 * Projected savings % for a sample set: `1 - sum(effective)/sum(baseline)`, ×100.
 *
 * Zero-baseline is treated as zero savings (no spend to save) rather than a divide-by-zero, so the
 * estimate stays finite on empty or free-baseline inputs.
 *
 * @param samples - The paired samples.
 * @returns Projected % spend saved at equal quality (0 when there is no baseline spend).
 */
function _savingsPct(samples: readonly SavingsSample[]): number
{
  const { effective, baseline } = _spendTotals(samples);
  if (baseline <= 0)
  {
    return 0;
  }
  return (1 - effective / baseline) * 100;
}

/**
 * Draw one bootstrap resample (with replacement) of size `n` using the injected RNG.
 *
 * @param samples - The source samples to resample from.
 * @param rng     - Uniform RNG in [0, 1).
 * @returns A resampled array of the same length.
 */
function _resample(samples: readonly SavingsSample[], rng: () => number): SavingsSample[]
{
  const n = samples.length;
  const out: SavingsSample[] = new Array(n);
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
 * Estimate AIR.6 shadow savings for one skill+candidate pairing from on-policy paired samples.
 *
 * Pure and I/O-free. The RNG is injectable so the bootstrap CI is deterministic under test; the
 * default is `Math.random`. Empty input and zero-baseline input return an all-zero estimate rather
 * than throwing or producing NaN/Infinity — the orchestrator treats "no signal" as "no savings".
 *
 * @param samples - The paired samples (each call run through baseline + candidate, candidate judged).
 * @param options - Bootstrap count + injectable RNG.
 * @returns The savings estimate: at-bar cheap fraction, point estimate, and bootstrap 95% CI.
 */
export function _EstimateSavings(samples: readonly SavingsSample[], options: SavingsOptions = {}): SavingsEstimate
{
  // 1. Empty input has no signal — return an all-zero estimate so the loop emits no proposal.
  if (samples.length === 0)
  {
    return { atBarCheapFraction: 0, projectedSavingsPct: 0, ciLowPct: 0, ciHighPct: 0 };
  }

  const rng = options.rng ?? Math.random;
  const bootstrapSamples = options.bootstrapSamples ?? _DEFAULT_BOOTSTRAP;

  // 2. At-bar cheap fraction is the share of calls the candidate served acceptably — the
  //    headline "how much traffic can move to the cheaper model" number.
  const passedCount = samples.reduce(function _count(acc, s) { return acc + (s.passedBar ? 1 : 0); }, 0);
  const atBarCheapFraction = passedCount / samples.length;

  // 3. Point estimate over the observed (unresampled) samples.
  const projectedSavingsPct = _savingsPct(samples);

  // 4. Bootstrap the CI: resample with replacement `bootstrapSamples` times, recompute savings on
  //    each draw, sort, and read the 2.5th / 97.5th percentiles for a 95% interval.
  const draws: number[] = new Array(bootstrapSamples);
  for (let i = 0; i < bootstrapSamples; i++)
  {
    draws[i] = _savingsPct(_resample(samples, rng));
  }
  draws.sort(function _asc(a, b) { return a - b; });

  return {
    atBarCheapFraction,
    projectedSavingsPct,
    ciLowPct: _percentile(draws, 0.025),
    ciHighPct: _percentile(draws, 0.975),
  };
}
