import { describe, expect, it } from "vitest";

import { _EstimateSavings } from "../../core/model-routing/savings.js";
import type { SavingsSample } from "../../core/model-routing/savings.types.js";

/** A deterministic RNG that cycles through a fixed sequence so the bootstrap is reproducible. */
function _seqRng(values: readonly number[]): () => number
{
  let i = 0;
  return function _next(): number
  {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

/** Build a sample with sensible defaults so each case only sets what it exercises. */
function _sample(over: Partial<SavingsSample>): SavingsSample
{
  return { passedBar: true, baselineCostUsd: 1, candidateCostUsd: 0.5, ...over };
}

describe("_EstimateSavings", function _suite()
{
  it("computes at-bar fraction and the point estimate by hand", function _pointEstimate()
  {
    // 4 calls: 3 pass the bar (candidate cost 0.4 each), 1 fails (keeps baseline 1.0).
    // baseline total = 4.0; effective = 0.4*3 + 1.0 = 2.2; savings = 1 - 2.2/4.0 = 0.45 -> 45%.
    const samples: SavingsSample[] = [
      _sample({ passedBar: true, baselineCostUsd: 1, candidateCostUsd: 0.4 }),
      _sample({ passedBar: true, baselineCostUsd: 1, candidateCostUsd: 0.4 }),
      _sample({ passedBar: true, baselineCostUsd: 1, candidateCostUsd: 0.4 }),
      _sample({ passedBar: false, baselineCostUsd: 1, candidateCostUsd: 0.4 }),
    ];

    const est = _EstimateSavings(samples, { bootstrapSamples: 10, rng: _seqRng([0]) });

    expect(est.atBarCheapFraction).toBeCloseTo(0.75, 10);
    expect(est.projectedSavingsPct).toBeCloseTo(45, 10);
  });

  it("is deterministic for a fixed RNG sequence", function _deterministic()
  {
    const samples: SavingsSample[] = [
      _sample({ passedBar: true, baselineCostUsd: 2, candidateCostUsd: 1 }),
      _sample({ passedBar: false, baselineCostUsd: 2, candidateCostUsd: 1 }),
      _sample({ passedBar: true, baselineCostUsd: 2, candidateCostUsd: 1 }),
    ];
    const rngSeq = [0.1, 0.4, 0.9];

    const a = _EstimateSavings(samples, { bootstrapSamples: 50, rng: _seqRng(rngSeq) });
    const b = _EstimateSavings(samples, { bootstrapSamples: 50, rng: _seqRng(rngSeq) });

    expect(a.ciLowPct).toBe(b.ciLowPct);
    expect(a.ciHighPct).toBe(b.ciHighPct);
  });

  it("produces a CI bracketing the point estimate when all draws are identical", function _degenerateCi()
  {
    // rng=0 always resamples index 0 -> every bootstrap draw is the single-sample savings.
    const samples: SavingsSample[] = [_sample({ passedBar: true, baselineCostUsd: 1, candidateCostUsd: 0.25 })];
    const est = _EstimateSavings(samples, { bootstrapSamples: 100, rng: _seqRng([0]) });

    // Single all-passing sample: savings = 1 - 0.25/1 = 0.75 -> 75%.
    expect(est.projectedSavingsPct).toBeCloseTo(75, 10);
    expect(est.ciLowPct).toBeCloseTo(75, 10);
    expect(est.ciHighPct).toBeCloseTo(75, 10);
  });

  it("returns an all-zero estimate for empty input", function _empty()
  {
    const est = _EstimateSavings([], { bootstrapSamples: 10, rng: _seqRng([0]) });
    expect(est).toEqual({ atBarCheapFraction: 0, projectedSavingsPct: 0, ciLowPct: 0, ciHighPct: 0 });
  });

  it("returns zero savings (not NaN) when the baseline spend is zero", function _zeroBaseline()
  {
    const samples: SavingsSample[] = [_sample({ passedBar: true, baselineCostUsd: 0, candidateCostUsd: 0 })];
    const est = _EstimateSavings(samples, { bootstrapSamples: 10, rng: _seqRng([0]) });

    expect(Number.isFinite(est.projectedSavingsPct)).toBe(true);
    expect(est.projectedSavingsPct).toBe(0);
    expect(est.atBarCheapFraction).toBe(1);
  });

  it("reports negative savings when the candidate is more expensive", function _negative()
  {
    const samples: SavingsSample[] = [_sample({ passedBar: true, baselineCostUsd: 1, candidateCostUsd: 2 })];
    const est = _EstimateSavings(samples, { bootstrapSamples: 10, rng: _seqRng([0]) });

    expect(est.projectedSavingsPct).toBeCloseTo(-100, 10);
  });
});
