import type { DecisionRequest, DecisionResult } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import type {
  MatchingSourceDecisionOutcome,
  MatchingSourceDecisionProvider,
} from './matching-source-decision-provider.js';
import { prepareJevMatchingSource } from './matching-source-jev.js';
import { parseMatchingSourceSemanticProof } from './matching-source-semantics.js';
import { matchingSourceSemanticUnits } from './matching-source-units.js';
import {
  compileMatchingVocabulary,
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
            ? judge()
            : choose(key.endsWith('_kind') ? 'requirement' : leadership),
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
      ([{ state, questions }]) =>
        questions.d2_coverage &&
        JSON.stringify(state).includes('directing a group of engineers'),
    )?.[0];
    expect(audit?.questions).toMatchObject({
      d2_classification: { type: 'predicate' },
      d2_coverage: { type: 'predicate' },
      d2_logic: { type: 'predicate' },
    });

    expect(audit?.questions.d2_coverage?.instructions).toContain(
      'state.units.d2.allOf',
    );
    expect(audit?.questions.d2_logic?.instructions).toContain(
      'state.units.d2.quote',
    );

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

  it('audits a real-shaped posting across a few bounded requests with exact unit keys', async () => {
    const adapter = provider(({ questions }) =>
      ok(
        Object.fromEntries(
          Object.keys(questions)
            .filter((key) => key !== 'd7_context')
            .map((key) => [key, judge(key === 'd14_context' ? 0 : 1)]),
        ),
      ),
    );
    const onDiagnostics = vi.fn();
    const input = {
      ...source,
      description: [
        'Responsibilities:',
        ...Array.from(
          { length: 32 },
          (_, index) =>
            `You will build integration ${index} and maintain the associated service for our customers.`,
        ),
      ].join('\n'),
    };
    const proof = await prepareJevMatchingSource(input, adapter, {
      onDiagnostics,
    });
    expect(adapter.decide.mock.calls.length).toBeLessThan(8);
    const wire = adapter.decide.mock.calls.map(([request]) => request);
    expect(
      wire.every(
        (request) =>
          Buffer.byteLength(JSON.stringify(request)) <=
            adapter.provenance.maxInputBytes &&
          Object.keys(request.questions).length <= 64,
      ),
    ).toBe(true);
    expect(
      wire.some(({ questions }) => Object.keys(questions).length > 12),
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
            judge(key === 'd3_context' ? 0 : 1),
          ]),
        ),
      ),
    );
    const proof = await prepareJevMatchingSource(input, adapter);
    const request = adapter.decide.mock.calls[0]?.[0];
    expect(request?.state).toMatchObject({ units: { d3: { quote: mixed } } });
    expect(request?.questions.d3_context?.instructions).toContain(
      'state.units.d3.quote',
    );
    expect(Object.keys(request?.questions ?? {})).toEqual([
      'd1_context',
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
    expect(adapter.decide.mock.calls.length).toBeLessThan(24);
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
        : ok({ d2_concept_0_0: choose(leadership) }),
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
                d2_coverage: judge(),
                d2_logic: judge(0.5),
              })
            : ok({ d2_concept_0_0: choose(selection) }),
        ),
      );
      expect(proof.verification.units.at(-1)?.logicAndQualifiersPreserved).toBe(
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
    for (const id of ['d2', 'd3', 'd4']) {
      expect(proof.proposal.ledger.find((entry) => entry.id === id)?.kind).toBe(
        'unresolved',
      );
      expect(
        proof.verification.units.find((entry) => entry.id === id)
          ?.classificationCorrect,
      ).toBe(false);
    }
    const wire = JSON.stringify(adapter.decide.mock.calls);
    expect(wire).not.toContain(input.profile);
    expect(wire).not.toContain('private@example.org');
  });
});
