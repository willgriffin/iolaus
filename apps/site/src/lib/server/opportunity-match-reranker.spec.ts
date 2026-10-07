import { describe, expect, it } from 'vitest';
import {
  evaluateMatchSamples,
  rankWithPrivateModel,
  trainPrivateReranker,
} from './opportunity-match-reranker.js';

describe('private match reranker', () => {
  it('uses owner-local labels and holds out the newest fifth', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      at: i,
      label: (i % 2) as 0 | 1,
      features: [i % 2],
      baseline: 0,
    }));
    const model = trainPrivateReranker(rows);
    expect(model.trained).toBe(true);
    expect(rankWithPrivateModel([1], model)).toBeGreaterThan(
      rankWithPrivateModel([0], model),
    );
    expect(evaluateMatchSamples(rows)).toMatchObject({ heldout: 2, total: 10 });
  });
});
