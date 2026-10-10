import { describe, expect, it } from 'vitest';
import {
  evaluateMatchSamples,
  evaluateScoredMatches,
  type MatchSample,
  rankCorrelation,
  rankWithPrivateModel,
  shouldUsePrivateReranker,
  trainPrivateReranker,
} from './opportunity-match-reranker.js';

const rows = (count = 100): MatchSample[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(3, '0'),
    at: i,
    label: (i % 2) as 0 | 1,
    features: [i % 2],
    baseline: i % 2 ? 0 : 1,
  }));
describe('private reranker and aggregate evaluation', () => {
  it('learns only supplied local labels and activates only after strict heldout improvement', () => {
    const samples = rows(),
      model = trainPrivateReranker(samples);
    expect(rankWithPrivateModel([1], model)).toBeGreaterThan(
      rankWithPrivateModel([0], model),
    );
    expect(evaluateMatchSamples(samples)).toMatchObject({
      train: 80,
      heldout: 20,
      calibrated: false,
      p10: 1,
      baseline: { p10: 0 },
    });
    expect(shouldUsePrivateReranker(samples)).toBe(true);
    expect(shouldUsePrivateReranker(rows(10))).toBe(false);
  });
  it('uses correct average-rank correlation with ties and null for constants', () => {
    expect(rankCorrelation([0, 0, 1, 1], [1, 2, 3, 4])).toBeCloseTo(0.89442719);
    expect(rankCorrelation([0, 0], [1, 2])).toBeNull();
    expect(rankCorrelation([1, 2, 3], [3, 2, 1])).toBe(-1);
  });
  it('normalizes fractional ideal gain correctly and uses baseline Brier without a trained model', () => {
    const samples: MatchSample[] = [
      { id: 'one', at: 1, label: 0.5, features: [0], baseline: 0.25 },
    ];
    expect(evaluateScoredMatches(samples)).toMatchObject({
      ndcg10: 1,
      brier: 0.0625,
    });
    expect(evaluateMatchSamples(samples)).toMatchObject({
      trained: false,
      brier: 0.0625,
      train: 0,
      heldout: 1,
    });
    expect(
      evaluateScoredMatches([{ ...samples[0], label: 0 }]).ndcg10,
    ).toBeNull();
  });
  it('does not use heldout labels in fitting and does not split equal timestamps', () => {
    const samples = rows();
    samples.slice(80).forEach((row) => {
      row.label = row.label ? 0 : 1;
    });
    expect(evaluateMatchSamples(samples).p10).toBe(0);
    expect(
      evaluateMatchSamples(rows(10).map((row) => ({ ...row, at: 1 }))),
    ).toMatchObject({ train: 0, heldout: 10, trained: false });
  });
  it('rejects malformed, duplicate and nonfinite data instead of publishing misleading metrics', () => {
    expect(() =>
      evaluateMatchSamples([{ ...rows(1)[0], baseline: NaN }]),
    ).toThrow();
    expect(() => trainPrivateReranker([...rows(1), ...rows(1)])).toThrow();
    expect(() =>
      trainPrivateReranker([{ ...rows(1)[0], features: [Infinity] }]),
    ).toThrow();
  });
});
