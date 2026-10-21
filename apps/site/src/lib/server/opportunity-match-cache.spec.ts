import { describe, expect, it, vi } from 'vitest';
import {
  enrichMatchEvidence,
  MAX_STAGE_THREE_CALLS,
  type MatchEvidenceCacheDependencies,
  validateEvidenceDecision,
} from './opportunity-match-cache.js';
import { matchCandidateEvidence } from './opportunity-match-evidence.js';
import { candidateFixture } from './opportunity-match-test-fixture.js';
import type { PublicMatchOpportunity } from './public-search/match.js';

const decision = {
  decision: 'partial' as const,
  confidence: 0.8,
  quote: 'TypeScript',
  evidenceRef: 'skill:ts',
};
function catalog(count: number, requirements = 1): PublicMatchOpportunity[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${i}`,
    requirements: Array.from({ length: requirements }, (_, j) => ({
      hash: `${j}`,
      text: `TypeScript ${j}`,
      skills: ['TypeScript'],
      years: j + 5,
      kind: 'must' as const,
    })),
  }));
}
function dependencies(): MatchEvidenceCacheDependencies {
  return {
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    decide: vi.fn(async () => ({
      output: decision,
      requestId: 'private-request',
      reused: false,
    })),
  };
}
describe('governed requirement orchestration', () => {
  it('bounds postings and calls while reusing content across unrelated postings', async () => {
    const candidate = candidateFixture(),
      postings = catalog(40),
      deps = dependencies();
    const stats = await enrichMatchEvidence(
      candidate.subject,
      candidate,
      matchCandidateEvidence(candidate, postings),
      postings,
      deps,
    );
    expect(stats).toEqual({
      postings: 25,
      calls: 1,
      cacheHits: 24,
      cacheLookups: 25,
      failures: 0,
    });
    expect(deps.decide).toHaveBeenCalledWith(
      candidate.subject,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        model: 'openai/gpt-6-luna',
        evidenceHash: expect.any(String),
      }),
    );
  });
  it('never exceeds the provider call budget even for large requirement sets', async () => {
    const candidate = candidateFixture(),
      postings = catalog(30, 100),
      deps = dependencies();
    expect(
      (
        await enrichMatchEvidence(
          candidate.subject,
          candidate,
          matchCandidateEvidence(candidate, postings),
          postings,
          deps,
        )
      ).calls,
    ).toBe(MAX_STAGE_THREE_CALLS);
  });
  it('applies saved decisions without enabling provider calls on ordinary reads', async () => {
    const candidate = candidateFixture(),
      postings = catalog(1),
      deps = dependencies();
    deps.read = vi.fn(async () => decision);
    const matches = matchCandidateEvidence(candidate, postings);
    const stats = await enrichMatchEvidence(
      candidate.subject,
      candidate,
      matches,
      postings,
      deps,
      false,
    );
    expect(stats.cacheHits).toBe(1);
    expect(stats.calls).toBe(0);
    expect(deps.decide).not.toHaveBeenCalled();
  });
  it('preserves deterministic evidence on provider failure and rejects fabricated quotes or unknown enums', async () => {
    const candidate = candidateFixture(),
      postings = catalog(1),
      deps = dependencies();
    deps.decide = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const matches = matchCandidateEvidence(candidate, postings);
    const before = JSON.stringify(matches);
    expect(
      (
        await enrichMatchEvidence(
          candidate.subject,
          candidate,
          matches,
          postings,
          deps,
        )
      ).failures,
    ).toBe(1);
    expect(JSON.stringify(matches)).toBe(before);
    expect(() =>
      validateEvidenceDecision(
        { ...decision, quote: 'invented' },
        candidate.evidence,
      ),
    ).toThrow();
    expect(() =>
      validateEvidenceDecision(
        { ...decision, decision: 'probably' },
        candidate.evidence,
      ),
    ).toThrow();
  });
  it('does not call a model for missing evidence and changes cache keys when evidence changes', async () => {
    const candidate = candidateFixture(),
      postings = catalog(1),
      deps = dependencies();
    candidate.evidence = [];
    expect(
      (
        await enrichMatchEvidence(
          candidate.subject,
          candidate,
          matchCandidateEvidence(candidate, postings),
          postings,
          deps,
        )
      ).calls,
    ).toBe(0);
    candidate.evidence = candidateFixture().evidence;
    await enrichMatchEvidence(
      candidate.subject,
      candidate,
      matchCandidateEvidence(candidate, postings),
      postings,
      deps,
    );
    const first = vi.mocked(deps.read).mock.calls.at(-1)?.[1];
    candidate.evidence[0].text = 'TypeScript updated';
    await enrichMatchEvidence(
      candidate.subject,
      candidate,
      matchCandidateEvidence(candidate, postings),
      postings,
      deps,
    );
    expect(vi.mocked(deps.read).mock.calls.at(-1)?.[1].evidenceHash).not.toBe(
      first?.evidenceHash,
    );
  });
});
