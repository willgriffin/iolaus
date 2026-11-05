import { describe, expect, it } from 'vitest';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  type MatchingCandidateInput,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const vocabulary = compileMatchingVocabulary([
  { slug: 'nodejs', label: 'Node.js' },
]);
const position = (id: string, role: string, start: string, end: string) => ({
  id,
  kind: 'experience' as const,
  text: [role, start, end].join('\n'),
  position: { role, start, end },
});
const candidate: MatchingCandidateInput = {
  targetRoles: ['Software engineering'],
  locations: ['Canada'],
  workModes: ['remote'],
  evidence: [
    position('a', 'Software Engineer', 'January 2016', 'Jan 2020'),
    position('b', 'Backend Engineer', '2018-01', '2023-01'),
    { id: 'skill', kind: 'skill', text: 'Node.js' },
  ],
};
const decision = (requirement: string, evidence = candidate.evidence) =>
  evaluateNormalizedMatch(
    normalizeMatchingPosting(
      {
        title: 'Software Engineer',
        location: 'Remote (Canada)',
        description: `Required skills: ${requirement}`,
      },
      vocabulary,
    ),
    normalizeMatchingCandidate({ ...candidate, evidence }, vocabulary),
  );

describe('dated role evidence', () => {
  it('supports only the lower bound of professional role-family experience and cites both positions', () => {
    const result = decision(
      '6 years of professional experience with software development',
    );
    expect(result.status).toBe('qualified');
    expect(
      result.reasons
        .find(({ code }) => code === 'required-capability')
        ?.citations.map(({ id }) => id),
    ).toEqual(expect.arrayContaining(['a', 'b']));
    expect(
      decision('7 years of professional experience with software development')
        .status,
    ).toBe('insufficient-evidence');
    expect(
      decision('6 years of professional experience with backend development')
        .status,
    ).toBe('insufficient-evidence');
  });

  it('never assigns role duration to a named technology or assumes production context', () => {
    expect(
      decision('5 years of professional experience with Node.js').status,
    ).toBe('insufficient-evidence');
    expect(decision('professional experience with Node.js').status).toBe(
      'insufficient-evidence',
    );
    expect(
      decision('production experience with software development').status,
    ).toBe('insufficient-evidence');
  });

  it('leaves invalid dates and unrelated or invented role titles unproven', () => {
    const evidence = [
      position('a', 'Software Engineer', '2008-02-31', '2020'),
      position('b', 'Software Engineer', '2050', 'Present'),
      position('c', 'Sales Engineer', '2010', '2022'),
      position('d', 'Aspiring Software Engineer', '2010', '2022'),
      position('e', 'Software Engineer', '2000', 'unknown'),
    ];
    expect(
      decision('professional experience with software development', evidence)
        .status,
    ).toBe('insufficient-evidence');
  });
});

describe('explicit governed skill evidence', () => {
  it('uses exact acquired skills without inferring related or alternative skills', () => {
    const use = (text: string) => [
      { id: 'skill', text, kind: 'skill' as const },
    ];
    expect(
      decision('Node.js', use('Node.js and written communication')).status,
    ).toBe('qualified');
    expect(
      decision('Node.js', use('Node.js or written communication')).status,
    ).toBe('insufficient-evidence');
    expect(
      decision('written communication', use('verbal communication')).status,
    ).toBe('insufficient-evidence');
    expect(
      decision(
        'professional experience with Node.js',
        use('3 years of professional experience with Node.js'),
      ).status,
    ).toBe('qualified');
    expect(
      decision(
        'production experience with Node.js',
        use('3 years of professional experience with Node.js'),
      ).status,
    ).toBe('insufficient-evidence');
  });
});
