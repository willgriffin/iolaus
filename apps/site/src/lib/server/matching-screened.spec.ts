import { describe, expect, it } from 'vitest';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  type MatchingCandidateInput,
  type MatchingPostingInput,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const vocabulary = compileMatchingVocabulary([
  { slug: 'nodejs', label: 'Node.js', related: ['typescript'] },
  { slug: 'typescript', label: 'TypeScript' },
  { slug: 'postgresql', label: 'PostgreSQL' },
]);
const posting: MatchingPostingInput = {
  title: 'Backend Engineer',
  description:
    'Required skills: Node.js\n5 years of professional experience with PostgreSQL',
  location: 'Remote (Canada)',
};
const profile: MatchingCandidateInput = {
  targetRoles: ['Backend Engineer'],
  locations: ['Canada'],
  workModes: ['remote'],
  evidence: [{ id: 'node', text: 'Node.js', kind: 'skill' }],
};

function match(
  source: Partial<MatchingPostingInput> = {},
  candidate: Partial<MatchingCandidateInput> = {},
) {
  return evaluateNormalizedMatch(
    normalizeMatchingPosting({ ...posting, ...source }, vocabulary),
    normalizeMatchingCandidate({ ...profile, ...candidate }, vocabulary),
  );
}

describe('screened listings with candidate evidence gaps', () => {
  it('ranks direct required evidence below fully qualified results and cites the missing requirement', () => {
    const decision = match();
    expect(decision).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(decision.score).toBeGreaterThan(0);
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        message: expect.stringContaining(
          '5+ years of professional experience with PostgreSQL',
        ),
        citations: expect.arrayContaining([
          expect.objectContaining({ field: 'description' }),
        ]),
      }),
    );
    const qualified = match(
      {},
      {
        evidence: [
          ...profile.evidence,
          {
            id: 'duration',
            text: '5 years of professional experience with PostgreSQL',
          },
        ],
      },
    );
    expect(qualified.status).toBe('qualified');
    expect(qualified.score).toBeGreaterThan(decision.score);
    expect(qualified.screenedWithGaps).toBeUndefined();
  });

  it('leaves unverified source, role, location, mode and must-have facts outside the tier', () => {
    for (const result of [
      match({ title: 'General Opportunity' }),
      match({ location: 'Remote' }),
      match({ location: 'Canada' }, { workModes: [] }),
      match({ location: 'Remote (United States)' }),
      match({}, { workModes: ['onsite'] }),
      match({ title: 'Sales Manager' }),
      match({
        description: `${posting.description}\nApplicants must have security clearance.`,
      }),
      match(
        {},
        {
          questions: [
            { id: 'must', text: 'An unverified condition', required: true },
          ],
        },
      ),
      match({}, { incomplete: true }),
    ]) {
      expect(result.score).toBe(0);
      expect(result.screenedWithGaps).toBeUndefined();
    }
  });

  it('leaves an unsupported source alternative outside the evidence-gap tier', () => {
    const normalized = normalizeMatchingPosting(posting, vocabulary);
    const [first, ...rest] = normalized.required;
    if (!first) throw new Error('Expected a directly supported requirement');
    const result = evaluateNormalizedMatch(
      {
        ...normalized,
        required: [
          { ...first, alternatives: [...first.alternatives, { slug: '' }] },
          ...rest,
        ],
      },
      normalizeMatchingCandidate(profile, vocabulary),
    );
    expect(result.score).toBe(0);
    expect(result.screenedWithGaps).toBeUndefined();
  });

  it('requires direct support for at least one required group', () => {
    expect(match({}, { evidence: [] }).screenedWithGaps).toBeUndefined();
    expect(
      match({
        description:
          'Required skills: TypeScript and PostgreSQL\nPreferred skills: Node.js',
      }).screenedWithGaps,
    ).toBeUndefined();
  });

  it('screens direct evidence with an unproven qualifier and keeps it below proven-group results', () => {
    const source = {
      description:
        'Required skills: 5 years of production experience with Node.js',
    };
    const partial = match(source);
    expect(partial).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(match().score);
    expect(partial.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        message: expect.stringContaining(
          '5+ years of production experience with Node.js',
        ),
      }),
    );
    const observed = match(source, {
      evidence: [
        {
          id: 'observed',
          text: '2 years of production experience with Node.js',
        },
      ],
    });
    expect(observed).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(observed.score).toBeGreaterThanOrEqual(partial.score);
    for (const text of [
      'Only 2 years of production experience with Node.js',
      '5 years of professional experience with Node.js',
      'No experience with Node.js.',
    ]) {
      const result = match(source, {
        evidence: [...profile.evidence, { id: 'scope', text }],
      });
      expect(result.screenedWithGaps).toBeUndefined();
      expect(result.score).toBe(0);
    }
    expect(
      match(
        {
          description: `${source.description}\nOur company uses TypeScript.`,
        },
        {
          evidence: [{ id: 'stack', text: 'TypeScript', kind: 'skill' }],
        },
      ).screenedWithGaps,
    ).toBeUndefined();
  });

  it('screens an OR group only when one alternative carries nonconflicting direct proof', () => {
    const source = {
      description:
        'Required skills: either 5 years of production experience with Node.js or 5 years of production experience with PostgreSQL',
    };
    const short = {
      id: 'short',
      text: 'Only 2 years of production experience with Node.js',
    };
    expect(
      match(source, { evidence: [short] }).screenedWithGaps,
    ).toBeUndefined();
    expect(
      match(source, {
        evidence: [short, { id: 'sql', text: 'PostgreSQL', kind: 'skill' }],
      }),
    ).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
  });

  it('uses an exact source example as partial proof without making it a required alternative', () => {
    const normalized = normalizeMatchingPosting(
      {
        ...posting,
        description: 'Required skills: PostgreSQL',
      },
      vocabulary,
    );
    const [group] = normalized.required;
    if (!group) throw new Error('Expected a required group');
    const interpreted = {
      ...normalized,
      required: [
        {
          ...group,
          alternatives: [
            {
              slug: 'postgresql',
              label: 'Familiarity with relevant tools',
              examples: ['nodejs'],
            },
          ],
        },
      ],
    };
    for (const skill of ['Node.js', 'PostgreSQL']) {
      const result = evaluateNormalizedMatch(
        interpreted,
        normalizeMatchingCandidate(
          {
            ...profile,
            evidence: [{ id: 'skill', text: skill, kind: 'skill' }],
          },
          vocabulary,
        ),
      );
      expect(result).toMatchObject({
        status: 'insufficient-evidence',
        screenedWithGaps: true,
      });
      expect(result.reasons).toContainEqual(
        expect.objectContaining({
          code: 'required-capability',
          outcome: 'unknown',
          message: expect.stringContaining('Familiarity with relevant tools'),
        }),
      );
    }
  });

  it('keeps ordinary lower bounds and bare skills as gaps, while explicit upper bounds can conflict', () => {
    const withEvidence = (text: string) =>
      match(
        {},
        {
          evidence: [...profile.evidence, { id: 'duration', text }],
        },
      );
    for (const text of [
      '3 years of professional experience with PostgreSQL',
      'PostgreSQL',
      'Only 3 years of production experience with PostgreSQL.',
      'Only 3+ years of professional experience with PostgreSQL.',
    ])
      expect(withEvidence(text).screenedWithGaps).toBe(true);
    for (const text of [
      'Only 3 years of professional experience with PostgreSQL.',
      'I have at most 3 years of experience with PostgreSQL.',
    ]) {
      expect(withEvidence(text)).toMatchObject({
        status: 'conflict',
        score: 0,
      });
      expect(withEvidence(text).screenedWithGaps).toBeUndefined();
    }
    const disputed = withEvidence(
      'Only 3 years of professional experience with PostgreSQL. 5 years of professional experience with PostgreSQL.',
    );
    expect(disputed.score).toBe(0);
    expect(disputed.reasons).toContainEqual(
      expect.objectContaining({ code: 'required-capability-disputed' }),
    );
  });
});
