import { describe, expect, it } from 'vitest';
import { matchPublicSkills } from './match.js';

describe('public skill matching', () => {
  it('is stateless, ranks weighted coverage, and preserves unknown requirements', () => {
    const result = matchPublicSkills({ skills: ['TypeScript', 'Postgres'] }, [
      {
        id: 'near',
        skills: { required: ['TypeScript'], preferred: ['Postgres'] },
        requirements: [{ text: 'degree', kind: 'must' }],
      },
      { id: 'far', skills: { required: ['Rust'] } },
    ]);
    expect(result.map((row) => row.id)).toEqual(['near', 'far']);
    expect(result[0]).toMatchObject({
      score: 55,
      explanation: {
        requirements: expect.arrayContaining([
          {
            requirement: 'degree',
            status: 'unknown',
            hash: 'requirement:0',
            kind: 'must',
            decision: 'unknown',
            confidence: 0,
            coverage: 0,
            submittedSkillIndices: [],
            evidenceRefs: [],
          },
        ]),
      },
    });
  });

  it('treats absence as coverage loss rather than an eligibility conflict', () => {
    const [result] = matchPublicSkills({ skills: ['TypeScript'] }, [
      { id: 'posting', skills: { required: ['TypeScript', 'Kubernetes'] } },
    ]);
    expect(result).toMatchObject({
      score: 50,
      explanation: { missingSkills: ['kubernetes'] },
    });
  });

  it('resolves public aliases without collapsing C++ and C#', () => {
    const results = matchPublicSkills({ skills: ['Postgres', 'C++'] }, [
      { id: 'postgres', skills: { required: ['PostgreSQL'] } },
      { id: 'sharp', skills: { required: ['C#'] } },
    ]);
    expect(results[0].score).toBe(100);
    expect(results[1].score).toBe(0);
  });
  it('does not create a match for an empty anonymous payload', () => {
    expect(matchPublicSkills({ skills: [] }, [{ id: 'posting' }])).toEqual([]);
  });
});
