import { describe, expect, it } from 'vitest';
import {
  experienceYears,
  matchCandidateEvidence,
} from './opportunity-match-evidence.js';
import { candidateFixture } from './opportunity-match-test-fixture.js';

describe('private deterministic evidence', () => {
  it('does not equate one supported skill with a conjunction or absence with contradiction', () => {
    const [result] = matchCandidateEvidence(candidateFixture(), [
      {
        id: 'one',
        requirements: [
          {
            hash: 'r',
            text: 'TypeScript and Rust',
            skills: ['TypeScript', 'Rust'],
            kind: 'must',
          },
        ],
      },
    ]);
    expect(result.score).toBe(50);
    expect(result.mustHaveConflictCount).toBe(0);
    expect(result.explanation.requirements[0]).toMatchObject({
      decision: 'partial',
      evidenceRefs: ['skill:ts'],
      submittedSkillIndices: [],
    });
  });
  it('requires explicit conflicting sponsorship while missing authorization remains unknown', () => {
    const candidate = candidateFixture();
    candidate.candidate.sponsorshipRequired = true;
    const [result] = matchCandidateEvidence(candidate, [
      {
        id: 'one',
        eligibility: {
          workAuthorization: { required: ['US'], sponsorship: 'no' },
        },
      },
    ]);
    expect(result.mustHaveConflictCount).toBe(1);
    expect(result.explanation.eligibilityNotes.join(' ')).toContain(
      'not established',
    );
  });
  it('merges concurrent tenure and does not infer open-ended tenure without present marker', () => {
    const now = Date.UTC(2026, 0);
    expect(
      experienceYears(
        [
          {
            id: 'a',
            kind: 'employment',
            title: 'Engineer',
            text: 'TypeScript 2020-01 - 2024-01',
          },
          {
            id: 'b',
            kind: 'employment',
            title: 'Engineer',
            text: 'TypeScript 2022-01 - 2025-01',
          },
        ],
        ['TypeScript'],
        now,
      ),
    ).toBeCloseTo(5, 1);
    expect(
      experienceYears(
        [
          {
            id: 'a',
            kind: 'employment',
            title: 'Engineer',
            text: 'TypeScript since 2020',
          },
        ],
        ['TypeScript'],
        now,
      ),
    ).toBeUndefined();
  });
  it('does not claim years in a skill from unrelated employment', () => {
    const candidate = candidateFixture();
    candidate.evidence.push({
      id: 'role',
      kind: 'employment',
      title: 'Engineer',
      text: 'Rust 2010-01 - 2025-01',
    });
    const [result] = matchCandidateEvidence(candidate, [
      {
        id: 'one',
        requirements: [
          {
            hash: 'r',
            text: '5 years TypeScript',
            skills: ['TypeScript'],
            years: 5,
            kind: 'must',
          },
        ],
      },
    ]);
    expect(result.explanation.requirements[0].decision).toBe('partial');
    expect(result.score).toBe(50);
  });
});

describe('catalog-scale deterministic matching', () => {
  it('scores 2700 synthetic postings against 100 evidence records without model calls', () => {
    const candidate = candidateFixture();
    candidate.evidence = Array.from({ length: 100 }, (_, i) => ({
      id: `e:${i}`,
      kind: 'skill' as const,
      title: `Skill ${i}`,
      text: `Skill ${i}`,
    }));
    const postings = Array.from({ length: 2700 }, (_, i) => ({
      id: `job:${i}`,
      requirements: Array.from({ length: 12 }, (_, j) => ({
        hash: `r:${j}`,
        text: `Skill ${(i + j) % 150}`,
        kind: 'must' as const,
        skills: [`Skill ${(i + j) % 150}`],
      })),
    }));
    const started = performance.now();
    const matches = matchCandidateEvidence(candidate, postings);
    const elapsed = performance.now() - started;
    if (process.env.MATCH_BENCHMARK === '1') expect(elapsed).toBeLessThan(500);
    expect(matches).toHaveLength(2700);
  });
});
