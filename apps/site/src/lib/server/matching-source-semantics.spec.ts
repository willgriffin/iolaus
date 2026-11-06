import { describe, expect, it } from 'vitest';
import { parseMatchingSourceExtraction } from './matching-source-extraction-contract.js';
import {
  type MatchingSourceSemanticProposal,
  matchingSourceSemanticMaterial,
  matchingSourceSemanticProposalDigest,
  parseMatchingSourceSemanticProposal,
  verifyMatchingSourceSemanticProposal,
} from './matching-source-semantics.js';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const raw = {
  title: 'Software Engineer',
  location: 'Remote (Canada)',
  description:
    'Qualifications:\nYou have previously written computer programs.',
};
const vocabulary = compileMatchingVocabulary([
  { slug: 'nodejs', label: 'Node.js' },
  { slug: 'typescript', label: 'TypeScript' },
]);
const candidate = normalizeMatchingCandidate(
  {
    targetRoles: ['Software engineering'],
    locations: ['Canada'],
    evidence: [
      { id: '1', text: 'Software development', kind: 'skill' },
      { id: '2', text: 'Node.js', kind: 'skill' },
    ],
  },
  vocabulary,
);
const atom = (conceptId: string | null, years: number | null = null) => ({
  conceptId,
  years,
  context: null,
  unsupportedQualifier: false,
});

function draft(
  source: typeof raw,
  alternatives = [atom('software-development')],
): MatchingSourceSemanticProposal {
  return {
    role: null,
    geography: null,
    ledger: matchingSourceSemanticMaterial(source).units.map(({ id }) => ({
      id,
      kind: id === 'd2' ? 'requirement' : 'context',
      groups: id === 'd2' ? [{ alternatives }] : [],
    })),
  };
}

function verification(
  source: typeof raw,
  proposed: MatchingSourceSemanticProposal,
  disagree?: string,
) {
  return {
    sourceDigest: matchingSourceSemanticMaterial(source).sourceDigest,
    proposalDigest: matchingSourceSemanticProposalDigest(proposed),
    roleCorrect: true,
    geographyCorrect: true,
    units: proposed.ledger.map(({ id }) => ({
      id,
      classificationCorrect: true,
      allConditionsRepresented: id !== disagree,
      logicAndQualifiersPreserved: true,
    })),
  };
}

function payload(
  source: typeof raw,
  proposed = draft(source),
  disagree?: string,
) {
  const semantic = verifyMatchingSourceSemanticProposal(
    verification(source, proposed, disagree),
    source,
    proposed,
  );
  return {
    coverage: 'partial' as const,
    role: null,
    geography: null,
    noRequirements: null,
    required: [],
    preferred: [],
    unresolved: [],
    semantic,
  };
}

function decision(
  source: typeof raw,
  proposed = draft(source),
  disagree?: string,
) {
  return evaluateNormalizedMatch(
    normalizeMatchingPosting(
      source,
      vocabulary,
      parseMatchingSourceExtraction(
        payload(source, proposed, disagree),
        source,
      ),
    ),
    candidate,
  );
}

describe('verified public semantic source interpretation', () => {
  it('covers an implied lexical parent only inside one verified exact capability span', () => {
    const governed = compileMatchingVocabulary([
      { slug: 'nodejs', label: 'Node.js', related: ['typescript'] },
      { slug: 'typescript', label: 'TypeScript' },
    ]);
    const use = (
      description: string,
      slug = 'scalable-full-stack-web-development',
    ) => {
      const source = { ...raw, description: `Qualifications:\n${description}` };
      const proposed = draft(source, [atom(slug, 3)]);
      const original = payload(source, proposed);
      const extraction = parseMatchingSourceExtraction(
        {
          ...original,
          semantic: {
            ...original.semantic,
            decision: {
              provider: 'typesafe',
              transport: 'direct',
              model: 'jev-1.14.0',
              revision: 'test-r1',
              maxInputBytes: 8192,
              preparationVersion: 'test/v1',
              observedModels: ['jev-1.14.0'],
              structures: { d2: 'whole' },
            },
          },
        },
        source,
      );
      return {
        baseline: normalizeMatchingPosting(source, governed),
        prepared: normalizeMatchingPosting(source, governed, extraction),
      };
    };
    const positive = use(
      '3 years as a full-stack engineer, developing scalable web applications.',
    );
    expect(positive.baseline.required).toHaveLength(0);
    expect(positive.prepared.required[0]?.alternatives).toMatchObject([
      { slug: 'scalable-full-stack-web-development', years: 3 },
    ]);
    expect(() =>
      use(
        '3 years developing scalable web applications in a full-stack role and building scalable web applications.',
      ),
    ).toThrow();
    const sibling = use(
      '3 years developing scalable web applications in a full-stack role, with Node.js.',
    );
    expect(
      sibling.prepared.required.some((g) =>
        g.alternatives.some(
          (a) => a.slug === 'scalable-full-stack-web-development',
        ),
      ),
    ).toBe(false);
    const related = use(
      '3 years developing with Node.js, using TypeScript.',
      'nodejs',
    );
    expect(
      related.prepared.required.some((g) =>
        g.alternatives.some((a) => a.slug === 'nodejs'),
      ),
    ).toBe(false);
    expect(() =>
      use(
        '3 years developing scalable web applications in a full-stack role and 2 years building scalable web applications.',
      ),
    ).toThrow();
  });

  it('only admits exact illustrative tools after current source classification is corroborated', () => {
    const source = {
      ...raw,
      description:
        'Requirements:\nFamiliarity with relevant technologies, such as Node.js and TypeScript',
    };
    const unconfirmed = normalizeMatchingPosting(source, vocabulary);
    expect(
      evaluateNormalizedMatch(unconfirmed, candidate).screenedWithGaps,
    ).not.toBe(true);
    const supported = decision(source, draft(source, [atom(null)]), 'd2');
    expect(supported).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(supported.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        citations: expect.arrayContaining([
          expect.objectContaining({ field: 'description' }),
        ]),
      }),
    );
    const waived = draft(source, [atom(null)]);
    const claim = waived.ledger.find(({ id }) => id === 'd2');
    if (!claim) throw new Error('Missing requirement fixture');
    claim.kind = 'context';
    claim.groups = [];
    expect(decision(source, waived).screenedWithGaps).not.toBe(true);

    const mixed = {
      ...source,
      description: `${source.description}, plus a current security clearance`,
    };
    expect(
      decision(mixed, draft(mixed, [atom(null)])).screenedWithGaps,
    ).not.toBe(true);
  });

  it('retains explicit scope and conflicts inside compound mandatory proof', () => {
    const source = {
      ...raw,
      description:
        'Requirements:\nAt least 5 years of back-end development experience operating Node.js in production\nTypeScript',
    };
    const proposed = draft(source, [atom(null)]);
    const typescript = proposed.ledger.find(({ id }) => id === 'd3');
    if (!typescript) throw new Error('Missing TypeScript fixture');
    typescript.kind = 'requirement';
    typescript.groups = [{ alternatives: [atom('typescript')] }];
    const posting = normalizeMatchingPosting(
      source,
      vocabulary,
      parseMatchingSourceExtraction(payload(source, proposed, 'd2'), source),
    );
    expect(posting.required[0]?.alternatives[0]).toMatchObject({
      slug: 'production-node-backend-engineering',
      years: 5,
      context: 'production',
      partialCapabilities: ['nodejs'],
    });
    const withEvidence = (text: string) =>
      normalizeMatchingCandidate(
        {
          targetRoles: ['Software engineering'],
          locations: ['Canada'],
          evidence: [
            { id: 'one', kind: 'skill', text: 'TypeScript' },
            { id: 'two', kind: 'fact', text },
          ],
        },
        vocabulary,
      );
    expect(
      evaluateNormalizedMatch(posting, withEvidence('Node.js')),
    ).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(
      evaluateNormalizedMatch(
        posting,
        withEvidence('No experience with Node.js'),
      ),
    ).toMatchObject({ status: 'conflict' });
  });

  it('requires every conjunct of a paraphrased qualitative list to be governed', () => {
    const condition =
      'Handling ambiguity, ability to create clarity, and willingness to solve problems and keep the team and its projects moving';
    const makeSource = (line: string) => ({
      ...raw,
      description: `Requirements:\n${line}\nNode.js`,
    });
    const source = makeSource(condition);
    const proposal = draft(source, [atom(null)]);
    const result = decision(source, proposal, 'd2');
    expect(result).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(
      result.reasons.filter(
        ({ code, outcome }) =>
          code === 'required-capability' && outcome === 'unknown',
      ),
    ).toHaveLength(3);

    const technicalTail = makeSource(
      `${condition}, and advanced geospatial raster processing`,
    );
    expect(
      decision(technicalTail, draft(technicalTail, [atom(null)]))
        .screenedWithGaps,
    ).not.toBe(true);
  });

  it('separates a corroborated plain title from mandatory conditions without waiving ambiguous suffixes', () => {
    const reviewTitle = (title: string, clearLogic = false) => {
      const source = { ...raw, title };
      const proposed = draft(source);
      const review = verification(source, proposed);
      const titleReview = review.units.find(({ id }) => id === 'title');
      if (!titleReview) throw new Error('Missing title coverage fixture');
      titleReview.logicAndQualifiersPreserved = clearLogic;
      review.roleCorrect = false;
      const semantic = verifyMatchingSourceSemanticProposal(
        review,
        source,
        proposed,
      );
      const facts = normalizeMatchingPosting(source, vocabulary, {
        ...payload(source, proposed),
        semantic,
      });
      return evaluateNormalizedMatch(facts, candidate);
    };
    expect(reviewTitle('Software Engineer - Billing')).toMatchObject({
      status: 'qualified',
    });
    for (const title of [
      'Software Engineer - Canada',
      'Software Engineer - Remote',
      'Software Engineer II',
      'Software Engineer - Unrecognized service scope',
      'Software Engineer - 5 years of Node.js',
      'Software Engineer - Security clearance required',
      'Software Engineer - Current work authorization required',
      'Software Engineer - Bachelor degree required',
    ]) {
      const result = reviewTitle(title);
      expect(result).toMatchObject({ status: 'insufficient-evidence' });
      expect(result.screenedWithGaps).not.toBe(true);
    }
    const hiddenCondition = reviewTitle(
      'Software Engineer - Security clearance required',
      true,
    );
    expect(hiddenCondition.reasons).toContainEqual(
      expect.objectContaining({
        code: 'posting-requirement-unknown',
        citations: [expect.objectContaining({ field: 'title' })],
      }),
    );
  });

  it('keeps an independently optional line soft only when the verifier confirms its classification', () => {
    for (const [line, hasHardCue] of [
      ['Experience integrating experimental vendor APIs', false],
      ['Applicants must possess an active security clearance', true],
    ] as const) {
      const source = {
        ...raw,
        description: `${raw.description}\nNice to Haves\n${line}`,
      };
      const proposal = draft(source);
      const preferred = proposal.ledger.find(({ id }) => id === 'd4');
      if (!preferred)
        throw new Error('Fixture needs its preferred source unit.');
      preferred.kind = 'preferred';
      preferred.groups = [{ alternatives: [atom(null)] }];
      const partlyVerified = decision(source, proposal, 'd4');
      expect(partlyVerified.status).toBe(
        hasHardCue ? 'insufficient-evidence' : 'qualified',
      );
      if (!hasHardCue)
        expect(partlyVerified.reasons).toContainEqual(
          expect.objectContaining({
            code: 'posting-preference-unknown',
            citations: [expect.objectContaining({ text: line })],
          }),
        );
      const disagreement = payload(source, proposal, 'd4');
      const report = disagreement.semantic.verification.units.find(
        ({ id }) => id === 'd4',
      );
      if (!report) throw new Error('Fixture needs its verification result.');
      report.classificationCorrect = false;
      const normalized = normalizeMatchingPosting(
        source,
        vocabulary,
        parseMatchingSourceExtraction(disagreement, source),
      );
      expect(evaluateNormalizedMatch(normalized, candidate).status).toBe(
        'insufficient-evidence',
      );
    }
  });

  it('includes host section hints while preserving the captured whole-unit quote', () => {
    const description = [
      '<h2>What will you do?</h2><p>Maintain the production system</p>',
      'How to be successful in this role:',
      'Node.js',
      'Preferred qualifications: Experience in an experimental runtime',
      'About the role',
      'A general description',
      'Benefits',
      'Flexible holidays',
    ].join('\n');
    const { units } = matchingSourceSemanticMaterial({ ...raw, description });
    expect(units.filter(({ field }) => field === 'description')).toEqual([
      expect.objectContaining({
        quote: 'What will you do?',
        sectionHint: 'duties',
        sectionHeading: true,
      }),
      expect.objectContaining({
        quote: 'Maintain the production system',
        sectionHint: 'duties',
        sectionHeading: false,
      }),
      expect.objectContaining({
        quote: 'How to be successful in this role:',
        sectionHint: 'required',
        sectionHeading: true,
      }),
      expect.objectContaining({
        quote: 'Node.js',
        sectionHint: 'required',
        sectionHeading: false,
      }),
      expect.objectContaining({
        sectionHint: 'preferred',
        sectionHeading: false,
      }),
      { id: 'd6', field: 'description', quote: 'About the role' },
      { id: 'd7', field: 'description', quote: 'A general description' },
      expect.objectContaining({
        sectionHint: 'administrative',
        sectionHeading: true,
      }),
      expect.objectContaining({
        sectionHint: 'administrative',
        sectionHeading: false,
      }),
    ]);
  });

  it('evaluates a governed paraphrase with complete source, independent verification, and exact whole-unit provenance', () => {
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary),
        candidate,
      ).status,
    ).toBe('insufficient-evidence');
    const result = decision(raw);
    expect(result.status).toBe('qualified');
    const source = result.reasons.find(
      ({ code }) => code === 'required-capability',
    )?.citations[0];
    expect(source?.text).toBe('You have previously written computer programs.');
    expect(raw.description.slice(source?.start, source?.end)).toBe(
      source?.text,
    );
    expect(decision(raw, draft(raw), 'd2').status).toBe(
      'insufficient-evidence',
    );
  });

  it('keeps an exactly named qualitative condition as a cited candidate gap', () => {
    const source = {
      ...raw,
      description:
        'Qualifications:\nRequired: Node.js\nWe value clear communication around technical concepts.',
    };
    const proposal = draft(source, [atom('nodejs')]);
    proposal.ledger[proposal.ledger.length - 1] = {
      id: 'd3',
      kind: 'requirement',
      groups: [{ alternatives: [atom('technical-communication')] }],
    };
    const result = decision(source, proposal);
    expect(result).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        citations: [
          expect.objectContaining({
            text: 'We value clear communication around technical concepts.',
          }),
        ],
      }),
    );
  });

  it('does not let a qualitative label erase mixed technical, duration, negated, or eligibility clauses', () => {
    for (const line of [
      'We value technical communication and Kafka.',
      'We value technical communication and 8 years with Kafka.',
      'We value technical communication in licensed clinical systems.',
      'We value technical communication and existing work authorization.',
      'We value technical communication in an unrelated technical specialty.',
      'We do not require technical communication without proof of Kafka.',
    ]) {
      const source = {
        ...raw,
        description: `Qualifications:\nRequired: Node.js\n${line}`,
      };
      const proposal = draft(source, [atom('nodejs')]);
      proposal.ledger[proposal.ledger.length - 1] = {
        id: 'd3',
        kind: 'requirement',
        groups: [{ alternatives: [atom('technical-communication')] }],
      };
      const result = decision(source, proposal);
      expect(result.status).toBe('insufficient-evidence');
      expect(result.screenedWithGaps).toBeUndefined();
      expect(result.reasons).toContainEqual(
        expect.objectContaining({ code: 'posting-requirement-unsupported' }),
      );
    }
  });

  it('rejects missing/duplicate units, fabricated concept IDs, stale source, and mismatched verification', () => {
    const proposed = draft(raw);
    expect(() =>
      parseMatchingSourceSemanticProposal(
        { ...proposed, ledger: proposed.ledger.slice(1) },
        raw,
      ),
    ).toThrow();
    expect(() =>
      parseMatchingSourceSemanticProposal(
        {
          ...proposed,
          ledger: [...proposed.ledger.slice(1), proposed.ledger[1]],
        },
        raw,
      ),
    ).toThrow();
    expect(() =>
      parseMatchingSourceSemanticProposal(
        draft(raw, [atom('fabricated-concept')]),
        raw,
      ),
    ).toThrow();
    expect(() =>
      parseMatchingSourceExtraction(payload(raw), {
        ...raw,
        description: raw.description.replace('written', 'studied'),
      }),
    ).toThrow();
    expect(() =>
      verifyMatchingSourceSemanticProposal(
        { ...verification(raw, proposed), proposalDigest: '0'.repeat(64) },
        raw,
        proposed,
      ),
    ).toThrow();
    expect(() =>
      parseMatchingSourceExtraction(
        { ...payload(raw), semantic: proposed },
        raw,
      ),
    ).toThrow();
  });

  it('cannot waive exact hard facts even with agreement on a mistaken classification', () => {
    const source = {
      ...raw,
      description: `${raw.description}\nRequired: TypeScript`,
    };
    const terms = compileMatchingVocabulary([
      { slug: 'typescript', label: 'TypeScript' },
    ]);
    const result = evaluateNormalizedMatch(
      normalizeMatchingPosting(
        source,
        terms,
        parseMatchingSourceExtraction(payload(source), source),
      ),
      candidate,
    );
    expect(result.status).toBe('insufficient-evidence');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        message: 'Your evidence does not establish TypeScript.',
      }),
    );
  });

  it('does not permit agreement on context to hide an uncued applicant condition', () => {
    const source = {
      ...raw,
      description:
        'About the role\nYou have previously written computer programs.\nFluent spoken Finnish.',
    };
    const result = decision(source);
    expect(result.status).toBe('insufficient-evidence');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({
        code: 'posting-requirement-unknown',
        citations: [
          expect.objectContaining({ text: 'Fluent spoken Finnish.' }),
        ],
      }),
    );
  });

  it('accepts verified employer disclosures but keeps hidden applicant conditions in the same unit', () => {
    const source = {
      ...raw,
      description: `${raw.description}\nBenefits\nThe salary range listed reflects the expected total wage range, which depends on experience and skills.`,
    };
    expect(decision(source).status).toBe('qualified');
    // The second review detects an uncued omitted condition in otherwise
    // ordinary employer prose and does not verify that unit.
    const omitted = {
      ...source,
      description: `${source.description} Current employees work nights; the new hire joins that rotation immediately.`,
    };
    expect(decision(omitted, draft(omitted), 'd4').status).toBe(
      'insufficient-evidence',
    );
    // A deterministically visible credential remains a blocker even when
    // both model responses incorrectly classify the whole unit as context.
    const obvious = {
      ...source,
      description: `${source.description} Applicants must hold a security clearance.`,
    };
    expect(decision(obvious).status).toBe('insufficient-evidence');
  });

  it('keeps authorization, duration and conjunctions from becoming a proven skill OR unknown', () => {
    for (const condition of [
      'You must have Node.js and unrestricted work authorization.',
      'You must have 5 years of experience with Node.js or another backend technology.',
      'Experience with Node.js and an unfamiliar vendor protocol.',
      'Experience with Node.js in a large-scale system.',
    ]) {
      const source = { ...raw, description: `Qualifications:\n${condition}` };
      const result = decision(
        source,
        draft(source, [atom('nodejs'), atom(null)]),
      );
      expect(result.status).toBe('insufficient-evidence');
      expect(result.reasons).toContainEqual(
        expect.objectContaining({ code: 'posting-requirement-unsupported' }),
      );
    }
  });

  it('keeps contradictory or narrowed geography and ambiguous levels out of qualified results', () => {
    const narrowed = { ...raw, location: 'Remote (Ontario, Canada)' };
    const geo = draft(narrowed);
    geo.geography = {
      mode: 'remote',
      countries: ['CA'],
      worldwide: false,
      unitId: 'location',
    };
    expect(decision(narrowed, geo).status).toBe('insufficient-evidence');

    const contradictory = {
      ...raw,
      description: `${raw.description}\nAbout the role\nThis position is remote and open to residents of the United States.`,
    };
    const conflict = draft(contradictory);
    conflict.geography = {
      mode: 'remote',
      countries: ['US'],
      worldwide: false,
      unitId: 'd4',
    };
    expect(decision(contradictory, conflict).reasons).toContainEqual(
      expect.objectContaining({ code: 'posting-geography-ambiguous' }),
    );
    expect(decision(contradictory, conflict).status).toBe(
      'insufficient-evidence',
    );

    const alternate = { ...raw, title: 'Senior or Staff Software Engineer' };
    const role = draft(alternate);
    role.role = {
      family: 'software-engineering',
      specialty: null,
      level: 'senior',
      unitId: 'title',
    };
    expect(decision(alternate, role).status).toBe('insufficient-evidence');
  });

  it('keeps direct source contradictions even when the verifier accepts the metadata', () => {
    const source = {
      ...raw,
      title: 'Software Engineer II — Payments',
      location: 'Remote Canada; Remote United States',
      description: `${raw.description}\nAs a Senior Software Engineer, you will build APIs.\nLocation - Remote United States`,
    };
    const proposal = draft(source);
    proposal.role = {
      family: 'software-engineering',
      specialty: null,
      level: null,
      unitId: 'title',
    };
    proposal.geography = {
      mode: 'remote',
      countries: ['CA', 'US'],
      worldwide: false,
      unitId: 'location',
    };
    const result = decision(source, proposal);
    expect(result.status).toBe('insufficient-evidence');
    expect(result.screenedWithGaps).toBeUndefined();
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'posting-role-ambiguous' }),
        expect.objectContaining({ code: 'posting-geography-ambiguous' }),
      ]),
    );
  });

  it('preserves a complete known OR unknown capability choice and keeps a separate unknown AND gate', () => {
    const source = {
      ...raw,
      description:
        'Qualifications:\nYou have worked with Node.js or an experimental runtime.',
    };
    expect(
      decision(source, draft(source, [atom('nodejs'), atom(null)])).status,
    ).toBe('qualified');
    const both = {
      ...source,
      description: `${source.description}\nYou can diagnose faults in a prototype compiler.`,
    };
    const proposal = draft(both, [atom('nodejs'), atom(null)]);
    const line = proposal.ledger.find(({ id }) => id === 'd3');
    if (!line) throw new Error('Fixture needs its third description line');
    line.kind = 'requirement';
    line.groups = [{ alternatives: [atom(null)] }];
    expect(decision(both, proposal).status).toBe('insufficient-evidence');
  });
});
