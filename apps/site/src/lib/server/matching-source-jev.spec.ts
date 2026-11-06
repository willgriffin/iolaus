import type { DecisionRequest, DecisionResult } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import type {
  MatchingSourceDecisionOutcome,
  MatchingSourceDecisionProvider,
} from './matching-source-decision-provider.js';
import {
  MATCHING_SOURCE_JEV_PREPARATION_VERSION,
  type MatchingSourceJevAssessments,
  prepareJevMatchingSource,
} from './matching-source-jev.js';
import { parseMatchingSourceSemanticProof } from './matching-source-semantics.js';
import { matchingSourceSemanticUnits } from './matching-source-units.js';
import {
  compileMatchingVocabulary,
  matchingSourceCapabilityGapAllowed,
  matchingSourceSectionHints,
  matchingSourceTypedFutureDuty,
  normalizeMatchingPosting,
} from './normalized-matching.js';
import { SKILL_VOCABULARY_SEED_TERMS } from './skill-vocabulary.js';

const vocabulary = compileMatchingVocabulary(SKILL_VOCABULARY_SEED_TERMS);
const source = {
  title: 'Senior Software Engineer',
  location: 'Remote within Canada',
  description: [
    'Qualifications:',
    '3+ years of professional experience directing a group of engineers.',
    'TypeScript and PostgreSQL',
    'Experience with either Node.js or Python',
    'Preferred qualifications:',
    'Kubernetes',
    'Responsibilities:',
    'You will build software.',
  ].join('\n'),
};
const leadership = 'engineering-team-leadership';
const choose = (choice: string): DecisionResult['answers'][string] => ({
  type: 'choice',
  choice,
  probabilities: { [choice]: 1 },
  confidence: 1,
});
const judge = (probability = 1): DecisionResult['answers'][string] => ({
  type: 'predicate',
  probability,
});
function ok(answers: DecisionResult['answers']): MatchingSourceDecisionOutcome {
  return {
    status: 'ok',
    result: {
      model: 'fixture',
      provenance: { provider: 'fixture', model: 'fixture' },
      answers,
    },
  };
}
function provider(
  decide: (request: DecisionRequest) => MatchingSourceDecisionOutcome = ({
    questions,
  }) =>
    ok(
      Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [
          key,
          question.type === 'predicate'
            ? judge(
                key.endsWith('_coverage') || key.endsWith('_scope_extra')
                  ? 0
                  : 1,
              )
            : choose(
                key.endsWith('_classification')
                  ? 'capability'
                  : key.endsWith('_context')
                    ? 'employer'
                    : key.endsWith('_kind')
                      ? 'requirement'
                      : leadership,
              ),
        ]),
      ),
    ),
) {
  return {
    provenance: {
      provider: 'fixture',
      transport: 'fixture',
      model: 'fixture',
      revision: 'v1',
      maxInputBytes: 8192,
    },
    decide: vi.fn(async (request: DecisionRequest) => decide(request)),
  } satisfies MatchingSourceDecisionProvider;
}

describe('JEV matching source preparation', () => {
  it.each([
    'team',
    'competing-occupation',
    'eligibility-restriction',
    'unclear',
  ])('audits an exact primary title suffix once and declines competing or unknown scope (%s)', async (finding) => {
    const accepted = finding === 'team';
    const input = {
      ...source,
      title: 'Engineering Manager - Delivery Platform',
      description: 'Qualifications:\nNode.js',
    };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'predicate'
              ? judge(
                  key === 'title_suffix_occupation'
                    ? Number(finding === 'competing-occupation')
                    : key === 'title_suffix_eligibility'
                      ? Number(finding === 'eligibility-restriction')
                      : key.endsWith('_coverage')
                        ? 0
                        : 1,
                )
              : choose(
                  key === 'title_role_suffix'
                    ? finding === 'unclear'
                      ? 'unclear'
                      : 'team'
                    : 'heading',
                ),
          ]),
        ),
      ),
    );
    const onDiagnostics = vi.fn();
    expect(normalizeMatchingPosting(input, vocabulary).role).toBeUndefined();
    const semantic = await prepareJevMatchingSource(input, adapter, {
      onDiagnostics,
    });
    expect(semantic.proposal.role).toMatchObject({
      family: 'engineering-management',
    });
    expect(semantic.verification.roleCorrect).toBe(accepted);
    expect(
      semantic.verification.units.find(({ id }) => id === 'title')
        ?.classificationCorrect,
    ).toBe(accepted);
    expect(
      adapter.decide.mock.calls.filter(
        ([{ questions }]) => questions.title_role_suffix,
      ),
    ).toHaveLength(1);
    expect(
      adapter.decide.mock.calls.some(([{ questions }]) => questions.role_pair),
    ).toBe(false);
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        rolePasses: Number(accepted),
        ...(accepted
          ? {}
          : { declinedDimensions: expect.objectContaining({ role: 1 }) }),
      }),
    );
  });

  it('drafts and independently audits grounded role, geography, Boolean groups, strength and a non-alias with tenure', async () => {
    const adapter = provider();
    const proof = await prepareJevMatchingSource(source, adapter);
    expect(parseMatchingSourceSemanticProof(proof, source)).toEqual(proof);
    expect(proof.proposal.role).toMatchObject({
      family: 'software-engineering',
      level: 'senior',
      unitId: 'title',
    });
    expect(proof.proposal.geography).toEqual({
      mode: 'remote',
      countries: ['CA'],
      worldwide: false,
      unitId: 'location',
    });
    expect(proof.verification).toMatchObject({
      roleCorrect: true,
      geographyCorrect: true,
    });
    expect(proof.proposal.ledger.map(({ id }) => id)).toEqual(
      matchingSourceSemanticUnits(source).map(({ id }) => id),
    );
    expect(proof.proposal.ledger.find(({ id }) => id === 'd2')).toEqual({
      id: 'd2',
      kind: 'requirement',
      groups: [
        {
          alternatives: [
            {
              conceptId: leadership,
              years: 3,
              context: 'professional',
              unsupportedQualifier: false,
            },
          ],
        },
      ],
    });
    expect(
      proof.proposal.ledger
        .find(({ id }) => id === 'd3')
        ?.groups.map(({ alternatives }) =>
          alternatives.map(({ conceptId }) => conceptId),
        ),
    ).toEqual([['typescript'], ['postgresql']]);
    expect(
      proof.proposal.ledger
        .find(({ id }) => id === 'd4')
        ?.groups.map(({ alternatives }) =>
          alternatives.map(({ conceptId }) => conceptId),
        ),
    ).toEqual([['nodejs', 'python']]);
    expect(proof.proposal.ledger.find(({ id }) => id === 'd6')).toMatchObject({
      kind: 'preferred',
      groups: [{ alternatives: [{ conceptId: 'kubernetes' }] }],
    });

    const draft = adapter.decide.mock.calls.find(
      ([request]) => 'd2_concept_0_0' in request.questions,
    )?.[0];
    expect(draft?.questions.d2_concept_0_0).toMatchObject({
      type: 'choice',
      criteria: { [leadership]: expect.any(String), none: expect.any(String) },
    });
    const audit = adapter.decide.mock.calls.find(
      ([{ questions }]) => questions.d2_coverage,
    )?.[0];
    expect(audit?.questions).toMatchObject({
      d2_classification: { type: 'predicate' },
      d2_coverage: { type: 'predicate' },
      d2_capability_0_0: { type: 'predicate' },
    });
    expect(audit?.questions.d2_classification?.instructions).toContain(
      '"Qualifications"',
    );
    expect(audit?.state).toMatchObject({
      units: {
        d2: { governingHeading: { quote: 'Qualifications', start: 0 } },
      },
    });
    expect(audit?.questions.d2_coverage?.instructions).toContain(
      'minimum 3 years',
    );
    expect(audit?.questions.d2_capability_0_0?.instructions).toContain(
      'directing a group of engineers',
    );
    expect(
      adapter.decide.mock.calls.some(([request]) =>
        Object.keys(request.questions).some(
          (key) => key.startsWith('title_') || key.startsWith('location_'),
        ),
      ),
    ).toBe(false);

    const posting = normalizeMatchingPosting(source, vocabulary, {
      coverage: 'partial',
      role: null,
      geography: null,
      noRequirements: null,
      required: [],
      preferred: [],
      unresolved: [],
      semantic: proof,
    });
    expect(
      posting.required.flatMap(({ alternatives }) => alternatives),
    ).toContainEqual(
      expect.objectContaining({
        slug: leadership,
        years: 3,
        context: 'professional',
      }),
    );
  });

  it('keeps shared minimum duration on each alternative in the draft', async () => {
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Required skills:\n3+ years of production experience with either Node.js or Python',
      },
      provider(),
    );
    expect(proof.proposal.ledger.at(-1)?.groups).toEqual([
      {
        alternatives: ['nodejs', 'python'].map((conceptId) => ({
          conceptId,
          years: 3,
          context: 'production',
          unsupportedQualifier: false,
        })),
      },
    ]);
  });

  it('does not promote an explicitly preferred minimum duration into a mandatory condition', async () => {
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Preferred qualifications:\nAt least 3 years of professional experience directing a group of engineers.',
      },
      provider(),
    );
    expect(proof.proposal.ledger.at(-1)).toMatchObject({
      kind: 'preferred',
      groups: [
        {
          alternatives: [
            { conceptId: leadership, years: 3, context: 'professional' },
          ],
        },
      ],
    });
  });

  it('classifies employer experience and hiring procedure before requiring a representable structure', async () => {
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'predicate'
              ? judge(
                  key.endsWith('_coverage') || key.endsWith('_scope_extra')
                    ? 0
                    : 1,
                )
              : choose(
                  key.endsWith('_context')
                    ? 'employer'
                    : key === 'd3_kind'
                      ? 'requirement'
                      : 'context',
                ),
          ]),
        ),
      ),
    );
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description: [
          'Our company has experience, but our story begins elsewhere.',
          'Interview procedure: no experience evaluation takes place on the first call.',
          'Applicants must have clearance and a licence or a certification.',
        ].join('\n'),
      },
      adapter,
    );
    expect(proof.proposal.ledger.slice(-3).map(({ kind }) => kind)).toEqual([
      'context',
      'context',
      'unresolved',
    ]);
    const requests = adapter.decide.mock.calls.map(
      ([request]) => request.questions,
    );
    expect(
      requests.some(
        (questions) =>
          questions.d1_kind && questions.d2_kind && questions.d3_kind,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (questions) => questions.d1_context && questions.d2_context,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (questions) => questions.d3_structure || questions.d3_coverage,
      ),
    ).toBe(false);
  });

  it('accepts only a provided comma structure and exposes exact structure keys separately', async () => {
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'predicate'
              ? judge(
                  key.endsWith('_coverage') || key.endsWith('_scope_extra')
                    ? 0
                    : 1,
                )
              : choose(
                  key.endsWith('_kind')
                    ? 'requirement'
                    : key === 'd2_structure'
                      ? 'list-all'
                      : 'none',
                ),
          ]),
        ),
      ),
    );
    const onStructures = vi.fn();
    const result = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Qualifications:\nExperience with Node.js, Python, PostgreSQL.',
      },
      adapter,
      { onStructures },
    );
    expect(result.proposal.ledger.at(-1)).toMatchObject({
      kind: 'requirement',
      groups: [
        { alternatives: [{ conceptId: 'nodejs' }] },
        { alternatives: [{ conceptId: 'python' }] },
        { alternatives: [{ conceptId: 'postgresql' }] },
      ],
    });
    expect(onStructures).toHaveBeenCalledWith({ d2: 'list-all' });
    const first = adapter.decide.mock.calls.find(
      ([request]) => request.questions.d2_structure,
    )?.[0];
    expect(first?.questions.d2_structure).toMatchObject({
      type: 'choice',
      criteria: {
        whole: expect.any(String),
        'list-all': expect.any(String),
        'list-any': expect.any(String),
        unresolved: expect.any(String),
      },
    });
    const refused = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Qualifications:\nExperience with Node.js, Python, PostgreSQL.',
      },
      provider(),
    );
    expect(refused.proposal.ledger.at(-1)).toMatchObject({
      kind: 'unresolved',
      groups: [],
    });
  });

  it('preserves explicit parenthesized alternatives and declines ungrouped mixed scope', async () => {
    const onStructures = vi.fn();
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Qualifications:\nExperience with (Node.js or Python) and TypeScript.\nExperience with Node.js or Python and TypeScript.',
      },
      provider(),
      { onStructures },
    );
    expect(
      proof.proposal.ledger
        .find(({ id }) => id === 'd2')
        ?.groups.map(({ alternatives }) =>
          alternatives.map(({ conceptId }) => conceptId),
        ),
    ).toEqual([['nodejs', 'python'], ['typescript']]);
    expect(proof.proposal.ledger.at(-1)?.kind).toBe('unresolved');
    expect(onStructures).toHaveBeenCalledWith({ d2: 'explicit' });
  });

  it('audits a real-shaped posting across a few bounded requests with exact unit keys', async () => {
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.keys(questions)
            .filter((key) => key !== 'd7_context')
            .map((key) => [
              key,
              choose(key === 'd14_context' ? 'mixed' : 'employer'),
            ]),
        ),
      ),
    );
    const onDiagnostics = vi.fn();
    const input = {
      ...source,
      description: [
        'Responsibilities:',
        'Competitive compensation',
        'Stock option grant',
        ...Array.from(
          { length: 30 },
          (_, index) =>
            `You will build integration ${index} and maintain the associated service for our customers.`,
        ),
      ].join('\n'),
    };
    const proof = await prepareJevMatchingSource(input, adapter, {
      onDiagnostics,
    });
    expect(adapter.decide.mock.calls.length).toBe(11);
    const wire = adapter.decide.mock.calls.map(([request]) => request);
    expect(
      wire.every(
        (request) =>
          Buffer.byteLength(JSON.stringify(request)) <=
            adapter.provenance.maxInputBytes &&
          Object.keys(request.questions).length <= 64,
      ),
    ).toBe(true);
    const contextBatches = wire.filter(({ questions }) =>
      Object.keys(questions).every((key) => /^d\d+_context$/u.test(key)),
    );
    expect(contextBatches).toHaveLength(11);
    expect(
      contextBatches.every(
        ({ questions }) => Object.keys(questions).length <= 3,
      ),
    ).toBe(true);
    expect(
      wire
        .filter(({ questions }) =>
          Object.keys(questions).some((key) => /_(role|geography)$/u.test(key)),
        )
        .every(
          ({ questions }) =>
            new Set(Object.keys(questions).map((key) => key.split('_')[0]))
              .size === 1,
        ),
    ).toBe(true);
    expect(proof.verification.units.map(({ id }) => id)).toEqual(
      matchingSourceSemanticUnits(input).map(({ id }) => id),
    );
    expect(
      proof.verification.units.find(({ id }) => id === 'd7')
        ?.allConditionsRepresented,
    ).toBe(false);
    expect(
      proof.verification.units.find(({ id }) => id === 'd14')
        ?.logicAndQualifiersPreserved,
    ).toBe(false);
    expect(
      proof.verification.units.find(({ id }) => id === 'd30'),
    ).toMatchObject({
      classificationCorrect: true,
      allConditionsRepresented: true,
      logicAndQualifiersPreserved: true,
    });
    expect(onDiagnostics).toHaveBeenCalledWith({
      draftCalls: 0,
      verificationCalls: wire.length,
      unasked: 0,
      declined: 1,
      declinedDimensions: { classification: 1, coverage: 1, logic: 1 },
      failed: 1,
      verified: 33,
      classificationPasses: 33,
      coveragePasses: 33,
      logicPasses: 33,
      rolePasses: 1,
      geographyPasses: 1,
    });
  });

  it('audits context by its exact quote and rejects mixed context without vacuous claim checks', async () => {
    const mixed =
      'We offer a friendly team. Availability each Saturday is expected.';
    const input = {
      title: 'Mystery Hire',
      location: 'Remote within Toronto',
      description: ['Responsibilities:', 'You will build APIs.', mixed].join(
        '\n',
      ),
    };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            choose(key === 'd3_context' ? 'mixed' : 'duty'),
          ]),
        ),
      ),
    );
    const proof = await prepareJevMatchingSource(input, adapter);
    const request = adapter.decide.mock.calls[0]?.[0];
    expect(request?.questions.d3_context?.instructions).toContain(mixed);
    expect(Object.keys(request?.questions ?? {})).toEqual([
      'd2_context',
      'd3_context',
    ]);
    expect(
      proof.verification.units
        .slice(0, 2)
        .map(({ classificationCorrect }) => classificationCorrect),
    ).toEqual([false, false]);
    expect(proof.verification.units.at(-2)).toMatchObject({
      classificationCorrect: true,
      allConditionsRepresented: true,
      logicAndQualifiersPreserved: true,
    });
    expect(proof.verification.units.at(-1)).toMatchObject({
      classificationCorrect: false,
      allConditionsRepresented: false,
      logicAndQualifiersPreserved: false,
    });
  });

  it('audits compatible scope restatements and refuses contradictory conditions', async () => {
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => {
            const instructions = String(question.instructions ?? '');
            if (question.type === 'choice') return [key, choose('mixed')];
            if (key.endsWith('_scope_country_CA'))
              return [
                key,
                judge(
                  Number(!/US only|Toronto residents only/u.test(instructions)),
                ),
              ];
            if (key.endsWith('_scope_outside'))
              return [key, judge(Number(instructions.includes('US only')))];
            if (key.endsWith('_scope_attendance'))
              return [key, judge(Number(instructions.includes('must attend')))];
            return [
              key,
              judge(
                key.endsWith('_scope_extra')
                  ? Number(instructions.includes('account executives'))
                  : 1,
              ),
            ];
          }),
        ),
      ),
    );
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description: [
          'Looking for intermediate and senior engineers.',
          'Seniority levels: only intermediate.',
          'This role is intermediate.',
          'Looking for intermediate or staff engineers, excluding senior.',
          'Remote first, work from anywhere in Canada.',
          'Remote first, work from the US only.',
          'Remote first, work from anywhere in Canada but must attend the office weekly.',
          'Remote first, work from Toronto residents only.',
          'Looking for intermediate and senior account executives.',
        ].join('\n'),
      },
      adapter,
    );
    expect(
      proof.verification.units
        .filter(({ id }) => id.startsWith('d'))
        .map(({ allConditionsRepresented }) => allConditionsRepresented),
    ).toEqual([true, false, false, false, true, false, false, false, false]);
    expect(
      adapter.decide.mock.calls
        .filter(([{ questions }]) =>
          Object.keys(questions).some((key) => key.includes('_scope_')),
        )
        .every(
          ([{ questions }]) =>
            new Set(Object.keys(questions).map((key) => key.split('_')[0]))
              .size === 1,
        ),
    ).toBe(true);
  });

  it('splits verifier batches on UTF-8 bytes and does not count oversized units as verified', async () => {
    const adapter = provider();
    adapter.provenance.maxInputBytes = 850;
    const proof = await prepareJevMatchingSource(
      {
        title: '',
        location: '',
        description: [
          'Responsibilities:',
          'You will build APIs.',
          `We build ${'🚀'.repeat(175)} tools.`,
        ].join('\n'),
      },
      adapter,
    );
    expect(
      adapter.decide.mock.calls.every(
        ([request]) => Buffer.byteLength(JSON.stringify(request)) <= 850,
      ),
    ).toBe(true);
    expect(proof.verification.units.at(-1)).toEqual({
      id: 'd3',
      classificationCorrect: false,
      allConditionsRepresented: false,
      logicAndQualifiersPreserved: false,
    });
  });

  it('packs both stages on a long qualifications section and preserves conservative atom coverage', async () => {
    const adapter = provider();
    const onDiagnostics = vi.fn();
    const input = {
      ...source,
      description: [
        'Qualifications:',
        ...Array.from(
          { length: 80 },
          () => 'Experience directing a group of engineers.',
        ),
      ].join('\n'),
    };
    const proof = await prepareJevMatchingSource(input, adapter, {
      onDiagnostics,
    });
    expect(adapter.decide.mock.calls.length).toBeLessThanOrEqual(100);
    expect(proof.proposal.ledger).toHaveLength(83);
    expect(
      proof.verification.units.find(({ id }) => id === 'd55')
        ?.allConditionsRepresented,
    ).toBe(true);
    expect(proof.verification.units.at(-1)?.allConditionsRepresented).toBe(
      false,
    );
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        draftCalls: expect.any(Number),
        verificationCalls: expect.any(Number),
        unasked: 20,
        verified: 63,
      }),
    );
  });

  it.each([
    'truncated',
    'failed',
    'invalid',
    'oversized',
    'timeout',
  ] as const)('keeps coverage unverified after a %s verifier response', async (status) => {
    const adapter = provider(({ questions }) =>
      questions.d2_coverage
        ? { status }
        : ok({
            d2_kind: choose('requirement'),
            d2_concept_0_0: choose(leadership),
          }),
    );
    const proof = await prepareJevMatchingSource(
      {
        ...source,
        description:
          'Qualifications:\nExperience directing a group of engineers.',
      },
      adapter,
    );
    expect(proof.verification.units.at(-1)).toEqual({
      id: 'd2',
      classificationCorrect: false,
      allConditionsRepresented: false,
      logicAndQualifiersPreserved: false,
    });
  });

  it('rejects unrelated/unknown selections and does not waive independent verification', async () => {
    const input = {
      ...source,
      description:
        'Qualifications:\nExperience directing a group of engineers.',
    };
    for (const selection of ['none', 'invented', leadership]) {
      const proof = await prepareJevMatchingSource(
        input,
        provider(({ questions }) =>
          questions.d2_coverage
            ? ok({
                d2_classification: judge(),
                d2_coverage: judge(0),
                d2_capability_0_0: judge(0.5),
              })
            : ok({
                d2_kind: choose('requirement'),
                d2_concept_0_0: choose(selection),
              }),
        ),
      );
      expect(proof.verification.units.at(-1)?.allConditionsRepresented).toBe(
        false,
      );
      if (selection !== leadership) {
        expect(
          proof.proposal.ledger.at(-1)?.groups[0]?.alternatives[0],
        ).toMatchObject({
          conceptId: null,
          unsupportedQualifier: true,
        });
        expect(proof.verification.units.at(-1)?.allConditionsRepresented).toBe(
          false,
        );
      }
    }
  });

  it('binds an independently verified inherited OR to exact source and preserves an assessed unmapped branch', async () => {
    const input = {
      ...source,
      description: [
        'Qualifications:',
        'Expertise in one or more of:',
        '- TypeScript',
        '- Novel telemetry protocol design',
        'Experience with PostgreSQL',
        'Track record of technical leadership without formal people management.',
      ].join('\n'),
    };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? choose(
                  key.endsWith('_classification')
                    ? 'capability'
                    : key.endsWith('_kind')
                      ? 'requirement'
                      : 'none',
                )
              : judge(
                  /_(?:block_extra|coverage|gap_eligibility)$/u.test(key)
                    ? 0
                    : 1,
                ),
          ]),
        ),
      ),
    );
    let assessments: MatchingSourceJevAssessments | undefined;
    const semantic = await prepareJevMatchingSource(input, adapter, {
      onAssessments(value) {
        assessments = value;
      },
    });
    expect(assessments).toMatchObject({
      assessmentVersion: 1,
      blocks: [
        {
          anchorId: 'd2',
          unitIds: ['d2', 'd3', 'd4'],
          kind: 'requirement',
          operator: 'any',
        },
      ],
      capabilityGaps: expect.arrayContaining([
        { unitId: 'd4', qualifier: 'unmapped', conceptIds: [] },
        expect.objectContaining({ unitId: 'd6', qualifier: 'scope' }),
      ]),
    });
    const proof = {
      ...semantic,
      decision: {
        provider: 'typesafe' as const,
        transport: 'direct' as const,
        model: 'fixture',
        revision: 'fixture',
        maxInputBytes: 8192,
        preparationVersion: MATCHING_SOURCE_JEV_PREPARATION_VERSION,
        observedModels: ['fixture'],
        ...assessments,
      },
    };
    const exactAliasAudit = adapter.decide.mock.calls.find(
      ([{ questions }]) => questions.d3_classification,
    )?.[0];
    expect(Object.keys(exactAliasAudit?.questions ?? {})).toEqual([
      'd3_classification',
      'd3_gap_eligibility',
    ]);
    const childAudit = adapter.decide.mock.calls.find(
      ([{ questions }]) => questions.d4_classification,
    )?.[0];
    expect(childAudit?.questions.d4_classification?.instructions).toContain(
      'Expertise in one or more of:',
    );
    const anchorAudit = adapter.decide.mock.calls.find(
      ([{ questions }]) => questions.d2_block_boundary,
    )?.[0];
    expect(anchorAudit?.questions.d2_block_boundary?.instructions).toContain(
      'Experience with PostgreSQL',
    );
    const checked = parseMatchingSourceSemanticProof(proof, input);
    const posting = normalizeMatchingPosting(input, vocabulary, {
      coverage: 'partial',
      role: null,
      geography: null,
      noRequirements: null,
      required: [],
      preferred: [],
      unresolved: [],
      semantic: checked,
    });
    const block = posting.required.find(({ citation }) =>
      citation.text.startsWith('Expertise in one or more of:'),
    );
    expect(block?.alternatives).toEqual([
      expect.objectContaining({ slug: 'typescript' }),
      expect.objectContaining({
        sourceGap: expect.objectContaining({
          citation: expect.objectContaining({
            text: expect.stringContaining('Novel telemetry protocol design'),
          }),
        }),
      }),
    ]);
    expect(
      posting.required.some(({ citation }) => citation.text === 'TypeScript'),
    ).toBe(false);
    expect(() =>
      parseMatchingSourceSemanticProof(proof, {
        ...input,
        description: input.description.replace('one or more of', 'all of'),
      }),
    ).toThrow();
    expect(() =>
      parseMatchingSourceSemanticProof(
        {
          ...proof,
          decision: {
            ...proof.decision,
            blocks: [
              { ...proof.decision.blocks?.[0], unitIds: ['d2', 'd4', 'd3'] },
            ],
          },
        },
        input,
      ),
    ).toThrow();
  });

  it.each([
    "What you'll do",
    'Responsibilities include',
    'Some things you might be expected to do could include',
  ])('uses the exact typed duties boundary and resets at later sections: %s', async (heading) => {
    const duty =
      'When ready, participating in our follow-the-sun OnCall rotation';
    const input = {
      ...source,
      description: [
        'Qualifications:',
        'Node.js',
        `${heading}:`,
        duty,
        'What you must already know:',
        'TypeScript',
        'Preferred qualifications:',
        'Kubernetes',
      ].join('\n'),
    };
    const hints = matchingSourceSectionHints(input.description, true);
    expect(hints.get(input.description.indexOf(duty))).toMatchObject({
      sectionHint: 'duties',
      governingHeading: {
        quote: heading,
        start: input.description.indexOf(heading),
      },
    });
    expect(
      hints.get(input.description.indexOf('TypeScript'))?.sectionHint,
    ).toBe('required');
    expect(
      hints.get(input.description.indexOf('Kubernetes'))?.sectionHint,
    ).toBe('preferred');
    expect(matchingSourceTypedFutureDuty(duty)).toBe(true);
    expect(matchingSourceTypedFutureDuty('Prior on-call experience')).toBe(
      false,
    );
    expect(
      matchingSourceTypedFutureDuty(
        'Candidates must be available every weekend for OnCall.',
      ),
    ).toBe(false);
    const adapter = provider();
    const proof = await prepareJevMatchingSource(input, adapter);
    expect(proof.proposal.ledger.find(({ id }) => id === 'd4')?.kind).toBe(
      'context',
    );
    expect(
      adapter.decide.mock.calls.some(
        ([{ questions }]) =>
          typeof questions.d4_context?.instructions === 'string' &&
          questions.d4_context.instructions.includes(heading),
      ),
    ).toBe(true);
  });

  it('distinguishes prior experience under duties from future work, benefits, and local optional strength', async () => {
    const input = {
      ...source,
      description: [
        "What you'll be doing:",
        'Experience collaborating with design and product teams',
        'Experience our culture first-hand',
        'Develop experience while collaborating with product teams',
        'Optional: experience collaborating with research teams',
        'Experience with relational databases (cloud tooling is a plus) and prior incident response',
        'Experience collaborating with designers and applicants must hold clearance',
        'Travel as needed for partner meetings',
        'Travel is required for site visits',
        'Enjoy occasional travel opportunities through our volunteer program',
      ].join('\n'),
    };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? choose(
                  key === 'd5_kind'
                    ? 'preferred'
                    : key.endsWith('_kind')
                      ? 'context'
                      : key.endsWith('_context')
                        ? 'duty'
                        : 'capability',
                )
              : judge(key.endsWith('_gap_eligibility') ? 0 : 1),
          ]),
        ),
      ),
    );
    const proof = await prepareJevMatchingSource(input, adapter);
    expect(
      proof.proposal.ledger.slice(3).map(({ id, kind }) => [id, kind]),
    ).toEqual([
      ['d2', 'unresolved'],
      ['d3', 'context'],
      ['d4', 'context'],
      ['d5', 'preferred'],
      ['d6', 'unresolved'],
      ['d7', 'unresolved'],
      ['d8', 'unresolved'],
      ['d9', 'unresolved'],
      ['d10', 'context'],
    ]);
  });

  it.each([
    [0, 'capability', true],
    [1, 'capability', false],
    [Number.NaN, 'capability', false],
    [0, 'other', false],
  ] as const)('accepts only an independently assessed whole-clause gap (%s, %s)', async (restriction, category, accepted) => {
    const quote = 'TypeScript and PostgreSQL';
    const input = { ...source, description: `Who You Are:\n${quote}` };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? choose(
                  key.endsWith('_kind')
                    ? 'requirement'
                    : key.endsWith('_classification')
                      ? category
                      : key.endsWith('_context')
                        ? 'heading'
                        : 'none',
                )
              : judge(key === 'd2_gap_eligibility' ? restriction : 1),
          ]),
        ),
      ),
    );
    let assessments: MatchingSourceJevAssessments | undefined;
    const proof = await prepareJevMatchingSource(input, adapter, {
      onAssessments(value) {
        assessments = value;
      },
    });
    expect(
      adapter.decide.mock.calls.filter(
        ([{ questions }]) => questions.d2_gap_eligibility,
      ),
    ).toHaveLength(1);
    expect(assessments?.capabilityGaps ?? []).toEqual(
      accepted ? [{ unitId: 'd2', qualifier: 'unmapped', conceptIds: [] }] : [],
    );
    expect(
      proof.verification.units.find(({ id }) => id === 'd2')
        ?.allConditionsRepresented,
    ).toBe(accepted);
    for (const unsafe of [
      'Incident response and a valid security clearance',
      'Incident response and not using Kubernetes',
      'Incident response and at most 2 years of Kubernetes',
    ])
      expect(matchingSourceCapabilityGapAllowed(unsafe, 'unmapped')).toBe(
        false,
      );
  });

  it('keeps inline OR depth and shared familiarity on their exact branches', async () => {
    const input = {
      ...source,
      description: [
        'Qualifications:',
        'Deep expertise in one or more of: distributed systems, data pipelines, or AI-powered classification and validation',
        'Posses familiarity with observability tools (OpenTelemetry, Prometheus, Grafana) and performance tuning',
      ].join('\n'),
    };
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? choose(key.endsWith('_kind') ? 'requirement' : 'none')
              : judge(/_(?:coverage|scope_eligibility)$/u.test(key) ? 0 : 1),
          ]),
        ),
      ),
    );
    let assessments: MatchingSourceJevAssessments | undefined;
    let structures: Record<string, string> | undefined;
    const semantic = await prepareJevMatchingSource(input, adapter, {
      onAssessments(value) {
        assessments = value;
      },
      onStructures(value) {
        structures = value;
      },
    });
    expect(structures).toEqual({
      d2: 'inline-depth-any',
      d3: 'familiarity-all',
    });
    const checked = parseMatchingSourceSemanticProof(
      {
        ...semantic,
        decision: {
          provider: 'typesafe',
          transport: 'direct',
          model: 'fixture',
          revision: 'fixture',
          maxInputBytes: 8192,
          preparationVersion: MATCHING_SOURCE_JEV_PREPARATION_VERSION,
          observedModels: ['fixture'],
          ...assessments,
          structures,
        },
      },
      input,
    );
    const posting = normalizeMatchingPosting(input, vocabulary, {
      coverage: 'partial',
      role: null,
      geography: null,
      noRequirements: null,
      required: [],
      preferred: [],
      unresolved: [],
      semantic: checked,
    });
    const groups = posting.required;
    const depth = groups.find(({ citation }) =>
      citation.text.startsWith('Deep expertise'),
    );
    expect(depth?.alternatives).toHaveLength(3);
    expect(depth?.alternatives[0]).toMatchObject({
      sourceGap: {
        qualifier: 'depth',
        verifiedConceptId: 'distributed-systems',
      },
    });
    expect(
      depth?.alternatives[1]?.sourceGap?.verifiedConceptId,
    ).toBeUndefined();
    const familiarity = groups.filter(({ citation }) =>
      citation.text.startsWith('Posses familiarity'),
    );
    expect(familiarity).toMatchObject([
      {
        alternatives: [
          {
            familiarity: true,
            slug: 'observability',
            examples: expect.arrayContaining(['prometheus']),
          },
        ],
      },
      {
        alternatives: [
          { familiarity: true, slug: 'software-performance-tuning' },
        ],
      },
    ]);
    expect(familiarity[1]?.alternatives[0]?.examples).toBeUndefined();
    expect(posting.sourceDecisionReaderRevision).toBe('typed-source-reader/v3');
    expect(
      posting.uncertainties.some(({ code }) =>
        code.startsWith('posting-requirement'),
      ),
    ).toBe(false);
  });

  it('redacts a mailbox only for the independent context audit while retaining exact source binding', async () => {
    const adapter = provider();
    const input = {
      ...source,
      description: [
        'Recruitment Fraud Alert',
        'Report suspicious messages to fraud@example.org.',
        'Applicants must have a security clearance; contact hiring@example.org.',
        'Report fraud by calling 123-456-7890.',
      ].join('\n'),
    };
    const proof = await prepareJevMatchingSource(input, adapter);
    const wire = JSON.stringify(adapter.decide.mock.calls);
    expect(wire).toContain('Report suspicious messages to [contact removed].');
    expect(wire).not.toMatch(/example\.org|123-456-7890|security clearance/u);
    expect(
      proof.verification.units.find(({ id }) => id === 'd2')
        ?.allConditionsRepresented,
    ).toBe(true);
    for (const id of ['d3', 'd4']) {
      expect(
        proof.verification.units.find((entry) => entry.id === id)
          ?.allConditionsRepresented,
      ).toBe(false);
    }
    expect(parseMatchingSourceSemanticProof(proof, input)).toEqual(proof);
  });

  it('accounts for unsafe applicant conditions without submitting them or unrelated private inputs', async () => {
    const adapter = provider();
    const input = {
      ...source,
      location: 'Remote within Tokyo',
      description: [
        'Qualifications:',
        'Applicants must have federal security clearance.',
        'Experience with Node.js except in production.',
        'Experience working with private@example.org.',
        'Experience directing a group of engineers.',
      ].join('\n'),
      profile: 'private candidate profile',
    };
    const proof = await prepareJevMatchingSource(input, adapter);
    expect(proof.proposal.geography).toBeNull();
    for (const id of ['d2', 'd3']) {
      expect(
        proof.proposal.ledger.find((entry) => entry.id === id),
      ).toMatchObject({
        kind: 'requirement',
        groups: [
          { alternatives: [{ conceptId: null, unsupportedQualifier: true }] },
        ],
      });
      expect(
        proof.verification.units.find((entry) => entry.id === id)
          ?.allConditionsRepresented,
      ).toBe(false);
    }
    expect(proof.proposal.ledger.find((entry) => entry.id === 'd4')?.kind).toBe(
      'unresolved',
    );
    expect(
      proof.verification.units.find((entry) => entry.id === 'd4')
        ?.classificationCorrect,
    ).toBe(false);
    const wire = JSON.stringify(adapter.decide.mock.calls);
    expect(wire).not.toContain(input.profile);
    expect(wire).not.toContain('private@example.org');
  });
});
