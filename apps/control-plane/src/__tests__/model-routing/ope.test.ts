import { describe, expect, it } from "vitest";

import { _DoublyRobustEstimate, _OpeEstimateWithCi, _ReplayEstimate } from "../../core/model-routing/ope.js";
import type { OpeSample } from "../../core/model-routing/ope.types.js";

/** A deterministic RNG cycling a fixed sequence so the bootstrap is reproducible. */
function _seqRng(values: readonly number[]): () => number
{
  let i = 0;
  return function _next(): number { const v = values[i % values.length]; i += 1; return v; };
}

/** Build an OPE sample with sensible defaults. */
function _sample(over: Partial<OpeSample>): OpeSample
{
  return { loggedAction: "a", candidateAction: "a", reward: 1, propensity: 0.5, rewardModelPred: 0, ...over };
}

describe("_ReplayEstimate", function _replaySuite()
{
  it("averages reward over matched actions only (hand-worked)", function _matched()
  {
    // matched: rewards 1.0 and 0.6 -> mean 0.8; the non-match is discarded.
    const samples: OpeSample[] = [
      _sample({ loggedAction: "a", candidateAction: "a", reward: 1.0 }),
      _sample({ loggedAction: "b", candidateAction: "a", reward: 0.0 }),
      _sample({ loggedAction: "c", candidateAction: "c", reward: 0.6 }),
    ];
    expect(_ReplayEstimate(samples)).toBeCloseTo(0.8, 10);
  });

  it("returns 0 when nothing matches", function _noMatch()
  {
    expect(_ReplayEstimate([_sample({ loggedAction: "a", candidateAction: "b" })])).toBe(0);
  });
});

describe("_DoublyRobustEstimate", function _drSuite()
{
  it("computes the DR value by hand", function _hand()
  {
    // s1 (match): pred 0.5 + (1 - 0.5)/0.5 = 0.5 + 1.0 = 1.5
    // s2 (no match): pred 0.2 only = 0.2
    // mean = (1.5 + 0.2) / 2 = 0.85
    const samples: OpeSample[] = [
      _sample({ loggedAction: "a", candidateAction: "a", reward: 1, propensity: 0.5, rewardModelPred: 0.5 }),
      _sample({ loggedAction: "a", candidateAction: "b", reward: 1, propensity: 0.5, rewardModelPred: 0.2 }),
    ];
    expect(_DoublyRobustEstimate(samples)).toBeCloseTo(0.85, 10);
  });

  it("falls back to the direct term when a matched sample has non-positive propensity", function _zeroProp()
  {
    // match but propensity 0 -> correction skipped, contributes pred 0.3 only.
    const samples: OpeSample[] = [_sample({ loggedAction: "a", candidateAction: "a", reward: 1, propensity: 0, rewardModelPred: 0.3 })];
    expect(_DoublyRobustEstimate(samples)).toBeCloseTo(0.3, 10);
  });

  it("returns 0 for empty input", function _empty()
  {
    expect(_DoublyRobustEstimate([])).toBe(0);
  });
});

describe("_OpeEstimateWithCi", function _ciSuite()
{
  it("brackets the point estimate and is deterministic for a fixed RNG", function _ci()
  {
    const samples: OpeSample[] = [
      _sample({ loggedAction: "a", candidateAction: "a", reward: 1 }),
      _sample({ loggedAction: "a", candidateAction: "a", reward: 0 }),
    ];
    const seq = [0.1, 0.9];

    const a = _OpeEstimateWithCi(samples, _ReplayEstimate, { bootstrapSamples: 30, rng: _seqRng(seq) });
    const b = _OpeEstimateWithCi(samples, _ReplayEstimate, { bootstrapSamples: 30, rng: _seqRng(seq) });

    expect(a.value).toBeCloseTo(0.5, 10);
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
    expect(a.ciLow).toBeLessThanOrEqual(a.ciHigh);
  });

  it("returns an all-zero estimate for empty input", function _empty()
  {
    expect(_OpeEstimateWithCi([], _DoublyRobustEstimate, { bootstrapSamples: 10, rng: _seqRng([0]) })).toEqual({ value: 0, ciLow: 0, ciHigh: 0 });
  });
});
