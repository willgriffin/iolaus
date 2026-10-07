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
      score: 100,
      explanation: {
        requirements: [{ requirement: 'degree', status: 'unknown' }],
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

  it('does not create a match for an empty anonymous payload', () => {
    expect(matchPublicSkills({ skills: [] }, [{ id: 'posting' }])).toEqual([]);
  });
});
