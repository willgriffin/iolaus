import type { DecisionRequest } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import { prepareMatchingSourceDecision } from './matching-source-decision-preparation.js';
import type {
  MatchingSourceDecisionOutcome,
  MatchingSourceDecisionProvider,
} from './matching-source-decision-provider.js';
import { parseMatchingSourceExtraction } from './matching-source-extraction-contract.js';

const source = {
  title: 'Senior Software Engineer',
  description: '',
  location: 'Remote within Canada',
  workplaceType: 'remote',
  sourceContentVersion: 1,
  sourceContentFingerprint: 'a'.repeat(64),
};

function answer(
  choice: string,
  model = 'fixture-observed',
  key = 'classification',
): MatchingSourceDecisionOutcome {
  return {
    status: 'ok',
    result: {
      model,
      provenance: { model, provider: 'fixture' },
      answers: {
        [key]: {
          type: 'choice',
          choice,
          probabilities: { [choice]: 1 },
          confidence: 1,
        },
      },
    },
  };
}

function fixture(
  outcome: MatchingSourceDecisionOutcome = answer('unresolved'),
  revision = 'r1',
) {
  return {
    provenance: {
      provider: 'fixture',
      transport: 'fixture',
      model: 'fixture-configured',
      revision,
      maxInputBytes: 4096,
    },
    decide: vi.fn(async (_request: DecisionRequest) => outcome),
  } satisfies MatchingSourceDecisionProvider;
}

const leadership = 'engineering-team-leadership';
const equivalentLeadership = `equivalent_${leadership}`;

function advisoryFixture(
  choice: string,
  probability: number | 'truncated' | 'failed' = 1,
) {
  const provider = fixture();
  provider.decide.mockImplementation(async ({ questions }) => {
    if (questions.classification) return answer('requirement');
    if (questions.concept) return answer(choice, 'fixture-observed', 'concept');
    if (typeof probability === 'string') return { status: probability };
    return {
      status: 'ok',
      result: {
        model: 'fixture-observed',
        provenance: { model: 'fixture-observed', provider: 'fixture' },
        answers: {
          [equivalentLeadership]: { type: 'predicate', probability },
        },
      },
    };
  });
  return provider;
}

describe('matching source decision preparation', () => {
  it('uses structured metadata and exact witnesses for required, preferred, AND, OR, and shared years before inference', async () => {
    const input = {
      ...source,
      description: [
        'Required skills:',
        '- TypeScript and PostgreSQL',
        '- 3+ years of production experience with either Node.js or Python',
        'Preferred qualifications:',
        '- Kubernetes',
      ].join('\n'),
    };
    const provider = fixture();
    const result = await prepareMatchingSourceDecision(input, provider);

    expect(provider.decide).not.toHaveBeenCalled();
    expect(result.extraction.coverage).toBe('partial');
    expect(result.extraction.semantic).toBeUndefined();
    expect(result.posting.role).toMatchObject({
      family: 'software-engineering',
      level: 'senior',
    });
    expect(result.posting.geography).toMatchObject({
      mode: 'remote',
      regions: [{ country: 'CA' }],
    });
    expect(
      result.extraction.required.map(({ alternatives }) =>
        alternatives.map(({ capability, years, context }) => [
          capability.quote,
          years,
          context,
        ]),
      ),
    ).toEqual([
      [['TypeScript', null, null]],
      [['PostgreSQL', null, null]],
      [
        ['Node.js', 3, 'production'],
        ['Python', 3, 'production'],
      ],
    ]);
    expect(
      result.posting.required.map(({ alternatives }) =>
        alternatives.map(({ slug, years, context }) => ({
          slug,
          years,
          context,
        })),
      ),
    ).toContainEqual([
      { slug: 'nodejs', years: 3, context: 'production' },
      { slug: 'python', years: 3, context: 'production' },
    ]);
    expect(
      result.extraction.preferred[0]?.alternatives[0]?.capability.quote,
    ).toBe('Kubernetes');
    expect(parseMatchingSourceExtraction(result.extraction, input)).toEqual(
      result.extraction,
    );
    for (const { citation } of result.units)
      expect(input[citation.field].slice(citation.start, citation.end)).toBe(
        citation.quote,
      );
  });

  it('applies a narrowly corroborated decision and keeps other suggestions advisory', async () => {
    const input = {
      ...source,
      location: 'Remote within CET',
      description: [
        'The role calls for experience with TypeScript.',
        'The role calls for experience with Node.js or an unnamed internal framework.',
        'You will operate Kubernetes.',
        'No experience with PostgreSQL is necessary.',
        'We use Python. Candidates must already have clearance.',
      ].join('\n'),
      privateProfile: 'unrelated private material',
    };
    const provider = fixture(answer('requirement'));
    const result = await prepareMatchingSourceDecision(input, provider);
    expect(
      result.extraction.required.map(({ clause }) => clause.quote),
    ).toEqual(['The role calls for experience with TypeScript.']);
    expect(
      result.posting.required.map(({ alternatives }) =>
        alternatives.map(({ slug }) => slug),
      ),
    ).toEqual([['typescript']]);
    expect(result.posting.geography).toBeUndefined();
    expect(result.units.filter(({ kind }) => kind === 'unresolved')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'd2', suggestion: 'requirement' }),
        expect.objectContaining({ id: 'd4', suggestion: 'requirement' }),
        expect.objectContaining({ id: 'd5', suggestion: 'requirement' }),
      ]),
    );
    expect(JSON.stringify(provider.decide.mock.calls)).not.toContain(
      input.privateProfile,
    );
    expect(result.posting.uncertainties).toContainEqual(
      expect.objectContaining({
        code: 'posting-requirements-incomplete',
        outcome: 'unknown',
      }),
    );
  });

  it('keeps a valid explicit AND of OR groups without a decision', async () => {
    const provider = fixture();
    const input = {
      ...source,
      description: 'Required skills:\nTypeScript and (Node.js or Python)',
    };
    const result = await prepareMatchingSourceDecision(input, provider);
    expect(
      result.posting.required.map(({ alternatives }) =>
        alternatives.map(({ slug }) => slug),
      ),
    ).toEqual([['typescript'], ['nodejs', 'python']]);
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('keeps mandatory unsupported scope unknown even when the provider says context', async () => {
    const provider = fixture(answer('context'));
    const input = {
      ...source,
      location: 'Remote within Toronto',
      description: [
        'Required qualifications:',
        'Experience with production PostgreSQL, including performance tuning and troubleshooting',
        'Candidates must have federal security clearance.',
      ].join('\n'),
    };
    const result = await prepareMatchingSourceDecision(input, provider);
    expect(result.posting.geography).toBeUndefined();
    expect(result.posting.required).toEqual([]);
    expect(result.extraction.required).toEqual([]);
    expect(result.units).toContainEqual(
      expect.objectContaining({ id: 'd2', kind: 'unresolved' }),
    );
    expect(result.units).toContainEqual(
      expect.objectContaining({
        id: 'd3',
        kind: 'unresolved',
        suggestion: 'context',
      }),
    );
    expect(result.posting.uncertainties).toContainEqual(
      expect.objectContaining({
        outcome: 'unknown',
        citations: [
          expect.objectContaining({
            text: 'Candidates must have federal security clearance.',
          }),
        ],
      }),
    );
  });

  it('keeps focused provider material bounded to 24 attempted units', async () => {
    const provider = fixture();
    const input = {
      ...source,
      description: Array.from(
        { length: 32 },
        (_, index) => `Experience with unpublished framework ${index}.`,
      ).join('\n'),
    };
    const result = await prepareMatchingSourceDecision(input, provider);
    expect(provider.decide).toHaveBeenCalledTimes(24);
    expect(
      result.units.filter(({ kind }) => kind === 'unresolved'),
    ).toHaveLength(32);
    expect(result.identity.provider.observedModels).toEqual([
      'fixture-observed',
    ]);
  });

  it('advises a non-alias engineering leadership concept without applying a fact', async () => {
    const quote = 'Experience leading a group of engineers.';
    const input = { ...source, description: `Requirements:\n- ${quote}` };
    const provider = advisoryFixture(leadership);
    const result = await prepareMatchingSourceDecision(input, provider);
    const unit = result.units.at(-1);
    expect(unit).toMatchObject({
      kind: 'unresolved',
      conceptSuggestion: leadership,
      conceptDecisionStatus: 'ok',
      citation: { field: 'description', quote },
    });
    expect(
      input.description.slice(unit?.citation.start, unit?.citation.end),
    ).toBe(quote);
    expect(result.extraction.unresolved).toContainEqual(unit?.citation);
    expect(result.extraction.required).toEqual([]);
    expect(result.posting.required).toEqual([]);
    expect(result.extraction.semantic).toBeUndefined();
    expect(
      provider.decide.mock.calls.map(([request]) =>
        Object.keys(request.questions),
      ),
    ).toEqual([['classification'], ['concept'], [equivalentLeadership]]);
    expect(
      provider.decide.mock.calls.every(
        ([request]) => Buffer.byteLength(JSON.stringify(request)) <= 512,
      ),
    ).toBe(true);
  });

  it.each([
    ['Experience shadowing engineering team leaders.', 'related'],
    ['Experience archiving engineering leadership emails.', 'none'],
  ])('preserves an explicit advisory refusal for %s', async (description, choice) => {
    const provider = advisoryFixture(choice);
    const result = await prepareMatchingSourceDecision(
      { ...source, description },
      provider,
    );
    const unit = result.units.at(-1);
    expect(unit).toMatchObject({
      kind: 'unresolved',
      conceptDecisionStatus: 'ok',
    });
    expect(unit?.conceptSuggestion).toBeUndefined();
    expect(provider.decide).toHaveBeenCalledTimes(2);
  });

  it.each([
    0.1,
    0.5,
    'truncated',
    'failed',
    Number.NaN,
  ] as const)('withholds a selected advisory when equivalence returns %s', async (probability) => {
    const provider = advisoryFixture(leadership, probability);
    const result = await prepareMatchingSourceDecision(
      {
        ...source,
        description: 'Experience leading a group of engineers.',
      },
      provider,
    );
    const unit = result.units.at(-1);
    const expected =
      typeof probability === 'string'
        ? probability
        : Number.isNaN(probability)
          ? 'invalid'
          : 'ok';
    expect(unit).toMatchObject({
      kind: 'unresolved',
      conceptDecisionStatus: expected,
    });
    expect(unit?.conceptSuggestion).toBeUndefined();
    expect(result.posting.required).toEqual([]);
    expect(provider.decide).toHaveBeenCalledTimes(3);
  });

  it('limits semantic work to a single applicant condition and the shared request budget', async () => {
    const provider = advisoryFixture(leadership);
    const result = await prepareMatchingSourceDecision(
      {
        ...source,
        description: [
          'You will lead engineering teams.',
          'Experience leading a group of engineers and work authorization.',
          ...Array.from(
            { length: 12 },
            () => 'Experience leading a group of engineers.',
          ),
        ].join('\n'),
      },
      provider,
    );
    expect(
      result.units.find(({ id }) => id === 'd1')?.conceptDecisionStatus,
    ).toBeUndefined();
    expect(
      result.units.find(({ id }) => id === 'd2')?.conceptDecisionStatus,
    ).toBeUndefined();
    expect(
      result.units.some(
        ({ conceptSuggestion }) => conceptSuggestion === leadership,
      ),
    ).toBe(true);
    expect(result.units.at(-1)?.conceptDecisionStatus).toBeUndefined();
    expect(provider.decide).toHaveBeenCalledTimes(24);
  });

  it.each([
    'truncated',
    'failed',
    'timeout',
    'oversized',
    'invalid',
  ] as const)('retains unresolved coverage after a %s decision without retry', async (status) => {
    const provider = fixture({ status });
    const result = await prepareMatchingSourceDecision(
      {
        ...source,
        description: 'The role calls for experience with TypeScript.',
      },
      provider,
    );
    expect(result.extraction.required).toEqual([]);
    expect(result.units.at(-1)).toMatchObject({
      kind: 'unresolved',
      decisionStatus: status,
    });
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid choices and source bounds before any publication', async () => {
    const provider = fixture(answer('invented'));
    const input = {
      ...source,
      description: 'The role calls for experience with TypeScript.',
    };
    const result = await prepareMatchingSourceDecision(input, provider);
    expect(result.units.at(-1)).toMatchObject({
      kind: 'unresolved',
      decisionStatus: 'invalid',
    });
    provider.decide.mockClear();
    await expect(
      prepareMatchingSourceDecision(
        { ...input, description: 'x'.repeat(40_001) },
        provider,
      ),
    ).rejects.toThrow();
    await expect(
      prepareMatchingSourceDecision(
        { ...input, sourceContentFingerprint: 'stale' },
        provider,
      ),
    ).rejects.toThrow();
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('binds exact source, structured mode, revision, and provider identity', async () => {
    const input = { ...source, description: 'Required skills: TypeScript' };
    const result = await prepareMatchingSourceDecision(input, fixture());
    const variants = await Promise.all([
      prepareMatchingSourceDecision(
        { ...input, description: `${input.description}.` },
        fixture(),
      ),
      prepareMatchingSourceDecision(
        { ...input, sourceContentVersion: 2 },
        fixture(),
      ),
      prepareMatchingSourceDecision(
        { ...input, workplaceType: 'onsite' },
        fixture(),
      ),
      prepareMatchingSourceDecision(input, fixture(undefined, 'r2')),
      prepareMatchingSourceDecision(
        { ...input, sourceContentFingerprint: 'b'.repeat(64) },
        fixture(),
      ),
    ]);
    const digests = [result, ...variants].map(
      ({ identity }) => identity.preparationDigest,
    );
    expect(new Set(digests).size).toBe(digests.length);
    const decisionInput = {
      ...source,
      description: 'The role calls for experience with TypeScript.',
    };
    const observed = await prepareMatchingSourceDecision(
      decisionInput,
      fixture(answer('requirement')),
    );
    const rerouted = await prepareMatchingSourceDecision(
      decisionInput,
      fixture(answer('requirement', 'another-model')),
    );
    expect(observed.identity.preparationDigest).not.toEqual(
      rerouted.identity.preparationDigest,
    );
    const tampered = { ...input, description: 'Required skills: PostgreSQL' };
    expect(() =>
      parseMatchingSourceExtraction(result.extraction, tampered),
    ).toThrow();
  });
});
