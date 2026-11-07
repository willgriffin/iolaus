import { describe, expect, it } from 'vitest';
import {
  type CandidateInterpretation,
  type CandidateInterpretationState,
  candidateEvidenceDigest,
  parseCandidateInterpretation,
} from './matching-candidate-contract.js';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  type MatchingCandidateInput,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const vocabulary = compileMatchingVocabulary([
  { slug: 'nodejs', label: 'Node.js' },
  { slug: 'postgresql', label: 'PostgreSQL' },
  { slug: 'react', label: 'React' },
  { slug: 'opentelemetry', label: 'OpenTelemetry' },
]);

const asOf = Date.UTC(2025, 0, 1);
type Record = MatchingCandidateInput['evidence'][number];
type Claim = CandidateInterpretation['assertions'][number];

function evidence(
  id: string,
  text: string,
  options: Partial<Record> = {},
): Record {
  return { id, text, kind: 'experience', ...options };
}

function claim(
  source: Record,
  conceptId: string,
  options: Partial<Claim> = {},
): Claim {
  return {
    sourceId: source.id,
    quote: source.text,
    activityQuote: null,
    conceptId,
    support: 'action',
    context: null,
    polarity: 'positive',
    period: null,
    duration: null,

    ...options,
  };
}

function proposal(sources: Record[], claims: Claim[]): CandidateInterpretation {
  return {
    assertions: claims,
    reviewedSourceIds: sources.map(({ id }) => id),
    unresolvedSourceIds: [],
  };
}

function candidate(
  sources: Record[],
  claims?: Claim[],
  date = asOf,
  state?: CandidateInterpretationState,
) {
  return normalizeMatchingCandidate(
    {
      targetRoles: ['Software Engineer'],
      locations: ['Canada'],
      workModes: ['remote'],
      evidence: sources,
    },
    vocabulary,
    state ??
      (claims
        ? { state: 'complete', interpretation: proposal(sources, claims) }
        : undefined),
    date,
  );
}

function decide(
  requirement: string,
  sources: Record[],
  claims?: Claim[],
  date = asOf,
  state?: CandidateInterpretationState,
) {
  const posting = normalizeMatchingPosting(
    {
      title: 'Software Engineer',
      location: 'Remote (Canada)',
      description: `Required skills: ${requirement}`,
    },
    vocabulary,
  );
  // Pair tests isolate candidate evidence after source interpretation has
  // established the posting's role, location and requirement coverage.
  return evaluateNormalizedMatch(
    { ...posting, uncertainties: [] },
    candidate(sources, claims, date, state),
  );
}

describe('candidate interpretation validation', () => {
  const source = evidence(
    'x',
    '🦉\nReworked the query plan and reindexed the live PostgreSQL service.',
  );
  const quote = source.text.slice(2).trim();
  const valid = claim(source, 'postgresql', { quote, context: 'production' });

  it('accepts only canonical claims grounded in the current source and binds UTF-16 offsets', () => {
    expect(
      parseCandidateInterpretation(
        proposal([source], [valid]),
        { evidence: [source] },
        vocabulary,
      ),
    ).toEqual(proposal([source], [valid]));
    const { evidence: proofs } = candidate([source], [valid]);
    expect(proofs[0]?.citation).toEqual({
      field: 'evidence',
      id: 'x',
      start: 2 + 1,
      end: source.text.length,
      text: quote,
      evidenceDigest: candidateEvidenceDigest(source),
    });
    expect(
      candidateEvidenceDigest({ ...source, text: `${source.text}!` }),
    ).not.toBe(candidateEvidenceDigest(source));
  });

  it('rejects missing coverage, extra fields, unknown concepts, fabricated and ambiguous quotes', () => {
    const cases = [
      { ...proposal([source], [valid]), reviewedSourceIds: [] },
      proposal(
        [source],
        [{ ...valid, activityId: 'invented-project' } as Claim],
      ),
      proposal([source], [{ ...valid, conceptId: 'unknown-database' }]),
      proposal([source], [{ ...valid, conceptId: 'nodejs' }]),
      proposal(
        [source],
        [{ ...valid, support: 'guessed' } as unknown as Claim],
      ),
      proposal([source], [{ ...valid, quote: 'fabricated-private-content' }]),
      proposal([source], [valid, valid]),
    ];
    for (const raw of cases) {
      expect(() =>
        parseCandidateInterpretation(raw, { evidence: [source] }, vocabulary),
      ).toThrow(/^Candidate evidence interpretation failed validation\.$/u);
    }
    expect(() =>
      parseCandidateInterpretation(
        proposal([source], [valid]),
        { evidence: [{ ...source, text: `${quote}\n${quote}` }] },
        vocabulary,
      ),
    ).toThrow();
  });

  it('reports malformed stored interpretation separately from a candidate evidence gap', () => {
    const changed = { ...source, text: 'Different source revision.' };
    const result = decide('PostgreSQL', [changed], [valid]);
    expect(result.status).toBe('insufficient-evidence');
    expect(result.reasons.map(({ code }) => code)).toContain(
      'candidate-interpretation-failed',
    );
    expect(
      decide('PostgreSQL', [changed], []).reasons.map(({ code }) => code),
    ).not.toContain('candidate-interpretation-failed');
  });

  it('retains verified proof while holding incomplete interpretation out of Qualified', () => {
    const unread = evidence('unread', 'An unresolved source may affect fit.');
    const normalizedCandidate = normalizeMatchingCandidate(
      {
        targetRoles: ['Software Engineer'],
        locations: ['Canada'],
        workModes: ['remote'],
        evidence: [source, unread],
      },
      vocabulary,
      {
        state: 'failed',
        interpretation: {
          assertions: [valid],
          reviewedSourceIds: [source.id],
          unresolvedSourceIds: [unread.id],
        },
      },
    );
    const posting = normalizeMatchingPosting(
      {
        title: 'Software Engineer',
        location: 'Remote (Canada)',
        description: 'Required skills: PostgreSQL',
      },
      vocabulary,
    );
    const result = evaluateNormalizedMatch(
      { ...posting, uncertainties: [] },
      normalizedCandidate,
    );
    expect(result).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'required-capability',
          outcome: 'supported',
        }),
        expect.objectContaining({
          code: 'candidate-interpretation-failed',
          outcome: 'unknown',
        }),
      ]),
    );
  });

  it('rejects wrong context, skill-label actions, role titles and unrelated interval dates', () => {
    const skill = evidence('skill', 'Experienced end-to-end project owner', {
      kind: 'skill',
    });
    const title = 'Full Stack Software Engineer';
    const position = evidence('job', `${title}\n2015\n2023`, {
      position: { role: title, start: '2015', end: '2023' },
    });
    const lab = evidence(
      'lab',
      'Tuned a test PostgreSQL service in a pre-production environment.',
    );
    const unrelated = evidence(
      'unrelated',
      'Joined in 2015 and learned about Node.js in 2023.',
    );
    for (const [source, assertion] of [
      [skill, claim(skill, 'end-to-end-project-ownership')],
      [position, claim(position, 'full-stack-development', { quote: title })],
      [lab, claim(lab, 'postgresql', { context: 'production' })],
      [
        unrelated,
        claim(unrelated, 'nodejs', { period: { start: '2015', end: '2023' } }),
      ],
    ] as const) {
      expect(() =>
        parseCandidateInterpretation(
          proposal([source], [assertion]),
          { evidence: [source] },
          vocabulary,
          asOf,
        ),
      ).toThrow();
    }
  });
});

describe('deterministic evidence composition', () => {
  const requirement =
    'Experience with production PostgreSQL, including performance tuning and troubleshooting';
  const passage = evidence(
    'database',
    'Diagnosed lock contention and rebuilt indexes on the live PostgreSQL service.',
  );
  const database = claim(passage, 'postgresql', { context: 'production' });
  const tuning = claim(passage, 'database-performance-tuning');
  const diagnosis = claim(passage, 'database-troubleshooting');

  it('requires every condition with the same technology attribution', () => {
    expect(
      decide(requirement, [passage], [database, tuning, diagnosis]),
    ).toMatchObject({ status: 'qualified' });
    const partial = decide(requirement, [passage], [database, tuning]);
    expect(partial.status).toBe('insufficient-evidence');
    expect(
      partial.reasons.find(({ code }) => code === 'required-capability')
        ?.message,
    ).toContain('database troubleshooting');
    const other = evidence(
      'other',
      'Investigated stalled transactions on a separate MySQL service.',
    );
    const joined = [
      { ...passage, activityId: 'same-position' },
      { ...other, activityId: 'same-position' },
    ];
    expect(
      decide(requirement, joined, [
        database,
        tuning,
        claim(other, 'database-troubleshooting'),
      ]).status,
    ).toBe('insufficient-evidence');
    const separated = { ...passage, text: `${passage.text}\n${other.text}` };
    expect(
      decide(
        requirement,
        [separated],
        [
          database,
          tuning,
          claim(separated, 'database-troubleshooting', { quote: other.text }),
        ],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('does not turn mixed database actions in the same quote into PostgreSQL tuning', () => {
    const mixed = evidence(
      'mixed',
      'Ran production PostgreSQL and tuned indexes and diagnosed slow queries on MySQL and Redis.',
    );
    expect(
      decide(
        requirement,
        [mixed],
        [
          claim(mixed, 'postgresql', { context: 'production' }),
          claim(mixed, 'database-performance-tuning'),
          claim(mixed, 'database-troubleshooting'),
        ],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('does not treat a positive action as a waiver of explicit contradictory evidence', () => {
    const denial = evidence('denial', 'I have no experience with PostgreSQL.', {
      kind: 'fact',
    });
    const result = decide(
      requirement,
      [passage, denial],
      [database, tuning, diagnosis],
    );
    expect(result.status).toBe('insufficient-evidence');
    expect(result.reasons.map(({ code }) => code)).toContain(
      'required-capability-disputed',
    );
  });

  it('binds a relational requirement to one verified activity and keeps separate projects apart', () => {
    const distributed =
      'Designed independently deployed Orbit workers that partitioned the event stream.';
    const scale = 'Increased Orbit worker capacity for billing spikes.';
    const orbit = [distributed, scale].join(' ');
    const another =
      'For Beacon, expanded the worker pool to handle file imports.';
    const row = evidence('portfolio', `${orbit} ${another}`);
    const required = 'Highly scalable distributed systems';
    const assertions = [
      claim(row, 'distributed-systems', {
        quote: distributed,
        activityQuote: distributed,
      }),
      claim(row, 'system-scalability', { quote: scale, activityQuote: orbit }),
    ];
    expect(decide(required, [row], assertions).status).toBe('qualified');
    expect(
      decide(
        required,
        [row],
        assertions.map((item) => ({ ...item, activityQuote: null })),
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      decide(
        required,
        [row],
        [
          assertions[0],
          claim(row, 'system-scalability', {
            quote: another,
            activityQuote: another,
          }),
        ],
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      decide(
        required,
        [row],
        assertions.map((item) => ({
          ...item,
          quote: row.text,
          activityQuote: null,
        })),
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      candidate(
        [row],
        [
          claim(row, 'system-scalability', {
            quote: another,
            activityQuote: orbit,
          }),
        ],
      ).interpretationIssue?.code,
    ).toBe('candidate-interpretation-failed');
    const architecture = evidence('architecture', distributed, {
      projectActivityId: 'orbit',
    });
    const growth = evidence('growth', scale, { projectActivityId: 'orbit' });
    const projectProofs = [
      claim(architecture, 'distributed-systems'),
      claim(growth, 'system-scalability'),
    ];
    expect(decide(required, [architecture, growth], projectProofs).status).toBe(
      'qualified',
    );
    expect(
      decide(
        required,
        [architecture, { ...growth, projectActivityId: 'beacon' }],
        projectProofs,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('rejects a cropped or operation-specific database denial without erasing hobby proof', () => {
    const hobby = evidence('hobby', 'Built a hobby archive using PostgreSQL.');
    const scoped = evidence(
      'scope',
      'I have never used PostgreSQL in production.',
    );
    const narrow = evidence(
      'operation',
      'I never operated PostgreSQL in production.',
    );
    const hobbyClaim = claim(hobby, 'postgresql');
    const scopedDenial = claim(scoped, 'postgresql', {
      support: 'stated',
      polarity: 'negative',
      context: 'production',
    });
    const cropped = {
      ...scopedDenial,
      context: null,
      quote: 'I have never used PostgreSQL',
    };
    const narrowDenial = claim(narrow, 'postgresql', {
      support: 'stated',
      polarity: 'negative',
      context: 'production',
    });
    expect(
      decide('PostgreSQL', [hobby, scoped], [hobbyClaim, scopedDenial]).status,
    ).toBe('qualified');
    expect(candidate([scoped], [cropped]).interpretationIssue?.code).toBe(
      'candidate-interpretation-failed',
    );
    expect(candidate([narrow], [narrowDenial]).interpretationIssue?.code).toBe(
      'candidate-interpretation-failed',
    );
  });

  it('composes independent cross-stack capabilities across projects and requires each operation', () => {
    const a = evidence(
      'app',
      'Built endpoints for a customer billing portal.',
      { projectActivityId: 'portal' },
    );
    const b = evidence(
      'deploy',
      'Deployed the portal behind a rolling release gate.',
      { projectActivityId: 'portal' },
    );
    const c = evidence(
      'monitor',
      'Watched queue depth and traced slow requests.',
      { projectActivityId: 'portal' },
    );
    const d = evidence(
      'scale',
      'Expanded worker capacity to handle billing spikes.',
      { projectActivityId: 'portal' },
    );
    const records = [a, b, c, d];
    const assertions = [
      claim(a, 'backend-development'),
      claim(b, 'service-deployment'),
      claim(c, 'service-monitoring'),
      claim(d, 'service-scaling'),
    ];
    const required =
      'Comfortable working across the stack - backend application development, infrastructure operations including deployment, monitoring, and scaling';
    expect(decide(required, records, assertions).status).toBe('qualified');
    expect(
      decide(
        required,
        [a, b, c, { ...d, projectActivityId: 'other' }],
        assertions,
      ).status,
    ).toBe('qualified');
    const unrelated = evidence(
      'team',
      'Expanded the support team as hiring increased.',
    );
    expect(
      decide(
        required,
        [a, b, c, unrelated],
        [...assertions.slice(0, 3), claim(unrelated, 'people-management')],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('supports qualitative behavior from attributed actions, and leaves claims and inference partial', () => {
    const ownership = evidence(
      'lead',
      'Turned stakeholder notes into a plan, coordinated delivery through launch, and handled post-launch issues.',
    );
    const claimOnly = evidence('claim', 'End-to-end project ownership', {
      kind: 'skill',
    });
    const required = 'End-to-end project ownership';
    expect(
      decide(
        required,
        [claimOnly],
        [
          claim(claimOnly, 'end-to-end-project-ownership', {
            support: 'stated',
          }),
        ],
      ).status,
    ).toBe('insufficient-evidence');
    const interpreted = claim(ownership, 'end-to-end-project-ownership');
    expect(decide(required, [ownership], [interpreted]).status).toBe(
      'qualified',
    );
    expect(
      decide(required, [ownership], [{ ...interpreted, support: 'inferred' }])
        .status,
    ).toBe('insufficient-evidence');
    expect(decide(required, [ownership]).status).toBe('insufficient-evidence');
  });

  it('supports developer empathy from work that addressed developers’ needs', () => {
    const workflow = evidence(
      'workflow',
      'Interviewed developers about broken handoffs and redesigned the release workflow around their feedback.',
    );
    const required = 'Demonstrate empathy for developer experience';
    expect(
      decide(
        required,
        [workflow],
        [claim(workflow, 'developer-experience-empathy')],
      ).status,
    ).toBe('qualified');
    expect(
      decide(
        required,
        [workflow],
        [claim(workflow, 'developer-workflow-automation')],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('preserves explicitly declared professional and production qualifiers independently', () => {
    const both = evidence(
      'both',
      'I have 6 years of professional experience with Node.js in production.',
    );
    const unqualified = evidence(
      'unqualified',
      'I have 6 years of experience with Node.js in production.',
      {
        activityId: 'employer',
        activityPosition: {
          role: 'Backend Engineer',
          start: '2010',
          end: '2024',
        },
      },
    );
    const declaration = (row: Record) =>
      claim(row, 'nodejs', {
        context: 'production',
        support: 'stated',
        duration: {
          minimumYears: 6,
          maximumYears: null,
          entirePosition: false,
        },
      });
    const professional = '6 years of professional experience with Node.js';
    const production = '6 years of production experience with Node.js';
    expect(decide(professional, [both], [declaration(both)]).status).toBe(
      'qualified',
    );
    expect(decide(production, [both], [declaration(both)]).status).toBe(
      'qualified',
    );
    expect(
      decide(professional, [unqualified], [declaration(unqualified)]).status,
    ).toBe('insufficient-evidence');
  });

  it('preserves explicit alternatives when another option is disputed', () => {
    const react = evidence('react', 'Built accessible controls with React.');
    const positive = evidence(
      'node',
      'Maintained request routing on a Node.js service.',
    );
    const denial = evidence('denial', 'I have no experience with Node.js.', {
      kind: 'fact',
    });
    expect(
      decide(
        'Node.js or React',
        [react, positive, denial],
        [claim(react, 'react'), claim(positive, 'nodejs')],
      ).status,
    ).toBe('qualified');
  });

  it('keeps employment limits scoped while recognizing hobby experience', () => {
    const hobby = evidence('hobby', 'Built a hobby server using Node.js.');
    const denial = evidence(
      'denial',
      'I have no professional experience with Node.js.',
      { kind: 'fact' },
    );
    const cap = evidence(
      'cap',
      'I have at most 2 years of professional experience with Node.js.',
      { kind: 'fact' },
    );
    const hobbyClaim = claim(hobby, 'nodejs');
    const sources = [hobby, denial, cap];
    expect(decide('Node.js', sources, [hobbyClaim]).status).toBe('qualified');
    expect(
      decide('5 years of experience with Node.js', sources, [hobbyClaim]),
    ).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(
      decide('5 years of production experience with Node.js', sources, [
        hobbyClaim,
      ]),
    ).toMatchObject({
      status: 'insufficient-evidence',
      screenedWithGaps: true,
    });
    expect(
      decide('5 years of professional experience with Node.js', sources, [
        hobbyClaim,
      ]).status,
    ).toBe('conflict');
  });

  it('retains explicit professional attribution on a production action', () => {
    const paid = evidence(
      'paid',
      'In paid work I built the production backend using Node.js.',
    );
    const hobby = evidence(
      'hobby',
      'I built the production backend for my hobby site using Node.js.',
    );
    const required = 'professional experience with Node.js';
    expect(
      decide(
        required,
        [paid],
        [claim(paid, 'nodejs', { context: 'production' })],
      ).status,
    ).toBe('qualified');
    expect(
      decide(
        required,
        [hobby],
        [claim(hobby, 'nodejs', { context: 'production' })],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('does not derive professional tenure from a linked personal production action', () => {
    const position = {
      role: 'Backend Engineer',
      start: '2015-01-01',
      end: '2024-01-01',
    };
    const employment = evidence('role', position.role, { position });
    const actions = [
      'From 2016-01-01 to 2023-01-01 I ran a production Node.js service for my hobby group.',
      'From 2016-01-01 to 2023-01-01 I operated a production Node.js service for a community I supported independently of my employer.',
      'I operated my employer’s production Node.js service from 2016-01-01 to 2023-01-01 as an unpaid volunteer.',
    ];
    const period = { start: '2016-01-01', end: '2023-01-01' };
    for (const text of actions) {
      const personal = evidence('personal', text, {
        activityId: employment.id,
      });
      const production = claim(personal, 'nodejs', {
        context: 'production',
        period,
      });
      const sources = [employment, personal];
      expect(
        decide('5 years of production experience with Node.js', sources, [
          production,
        ]).status,
      ).toBe('qualified');
      for (const context of ['production', null] as const)
        expect(
          decide('5 years of professional experience with Node.js', sources, [
            { ...production, context },
          ]).status,
        ).toBe('insufficient-evidence');
    }

    const employerWork = evidence(
      'employer-work',
      'I operated my employer’s production Node.js service from 2016-01-01 to 2023-01-01.',
    );
    const production = claim(employerWork, 'nodejs', {
      context: 'production',
      period,
    });
    for (const context of ['professional', 'production'])
      expect(
        decide(
          `5 years of ${context} experience with Node.js`,
          [employerWork],
          [production],
        ).status,
      ).toBe('qualified');
    expect(
      decide(
        '8 years of professional experience with Node.js',
        [employment, { ...employerWork, activityId: employment.id }],
        [production],
      ).status,
    ).toBe('insufficient-evidence');

    const wholeRole = evidence(
      'owned-work',
      'Throughout this position I operated the production Node.js service.',
      { activityId: employment.id },
    );
    expect(
      decide(
        '5 years of professional experience with Node.js',
        [employment, wholeRole],
        [
          claim(wholeRole, 'nodejs', {
            context: 'production',
            duration: {
              entirePosition: true,
              minimumYears: null,
              maximumYears: null,
            },
          }),
        ],
      ).status,
    ).toBe('qualified');
  });
});

describe('observed time bounds', () => {
  const first = evidence(
    'one',
    'Operated the live Node.js backend from 2015-01-01 to 2019-01-01.',
  );
  const second = evidence(
    'two',
    'Rebuilt the live Node.js backend from 2017-01-01 to 2021-01-01.',
  );
  const third = evidence(
    'three',
    'Reworked the live Node.js backend from 2021-02-01 to 2023-04-01.',
  );
  function claims(source: Record, start: string, end: string) {
    return [
      claim(source, 'nodejs', {
        context: 'production',
        period: { start, end },
      }),
      claim(source, 'backend-development', { period: { start, end } }),
    ];
  }
  const periods = [
    ...claims(first, '2015-01-01', '2019-01-01'),
    ...claims(second, '2017-01-01', '2021-01-01'),
  ];

  it('accepts explicit natural-language duration without summing undated observations', () => {
    const six = evidence(
      'six',
      'Spent six years developing production Node backends.',
    );
    const four = evidence(
      'four',
      'Spent 4 years developing production Node.js backends.',
    );
    const seven =
      '7+ years of backend engineering experience running Node.js in production';
    const bounded = (source: Record, years: number) => {
      const duration = {
        minimumYears: years,
        maximumYears: null,
        entirePosition: false,
      };
      return [
        claim(source, 'nodejs', { context: 'production', duration }),
        claim(source, 'backend-development', { duration }),
      ];
    };
    expect(
      decide(seven.replace('7+', '6+'), [six], bounded(six, 6)).status,
    ).toBe('qualified');
    expect(
      decide(seven, [six, four], [...bounded(six, 6), ...bounded(four, 4)])
        .status,
    ).toBe('insufficient-evidence');
    expect(candidate([six], bounded(six, 7)).interpretationIssue?.code).toBe(
      'candidate-interpretation-failed',
    );
    const mixed = evidence(
      'mixed',
      'Spent six years maintaining Java backends and a production Node.js CLI.',
    );
    expect(
      decide(seven.replace('7+', '6+'), [mixed], bounded(mixed, 6)).status,
    ).toBe('insufficient-evidence');
  });

  it('honors an explicit total upper bound and rejects an activity-local cap', () => {
    const upper = {
      minimumYears: null,
      maximumYears: 4,
      entirePosition: false,
    };
    const only = evidence(
      'only',
      'I have at most four years of experience with Node.js.',
    );
    const local = evidence(
      'local',
      'I spent at most four years with Node.js on the portal.',
    );
    const a = claim(only, 'nodejs', { support: 'stated', duration: upper });
    const b = claim(local, 'nodejs', { duration: upper });
    const total = evidence(
      'total',
      'My total Node.js experience is limited to four years of independent study.',
    );
    const explicitTotal = claim(total, 'nodejs', {
      support: 'stated',
      duration: upper,
    });
    expect(
      decide('5 years of experience with Node.js', [total], [explicitTotal])
        .status,
    ).toBe('conflict');
    expect(decide('5 years of experience with Node.js', [total]).status).toBe(
      'conflict',
    );
    expect(
      decide('5 years of experience with Node.js', [only], [a]).status,
    ).toBe('conflict');
    expect(candidate([local], [b]).interpretationIssue?.code).toBe(
      'candidate-interpretation-failed',
    );
  });

  it.each([
    ['at most', null],
    ['up to', null],
    ['only', 1],
    ['exactly', 1],
  ] as const)('applies a candidate-wide %s declaration without erasing hobby familiarity', (modifier, minimumYears) => {
    const total = evidence(
      'total',
      `My total Node.js experience is ${modifier} one year.`,
    );
    const hobby = evidence(
      'hobby',
      'I used Node.js on a personal learning project.',
    );
    const maximum = claim(total, 'nodejs', {
      support: 'stated',
      duration: { minimumYears, maximumYears: 1, entirePosition: false },
    });
    expect(candidate([total], [maximum]).interpretationIssue).toBeUndefined();
    const required = '5 years of production experience with Node.js';
    expect(decide(required, [total]).status).toBe('conflict');
    expect(
      decide(required, [total, hobby], [claim(hobby, 'nodejs')]).status,
    ).toBe('conflict');
    expect(
      decide('Node.js', [total, hobby], [claim(hobby, 'nodejs')]).status,
    ).toBe('qualified');
    expect(decide('1 year of experience with Node.js', [total]).status).toBe(
      minimumYears === 1 ? 'qualified' : 'insufficient-evidence',
    );
  });

  it.each([
    'My total Node.js experience is at most one year if I count only the prototype.',
    'My total Node.js experience is at most one to two years.',
    'My total Node.js experience is not at most one year.',
    'My total Node.js experience would be at most one year.',
    'My team’s total Node.js experience is at most one year.',
    'I used Node.js for at most one year on the prototype.',
  ])('does not use a conditional, ambiguous or out-of-scope cap as a candidate-wide limit', (text) => {
    const source = evidence('non-total', text);
    expect(
      decide('5 years of production experience with Node.js', [source]).status,
    ).toBe('insufficient-evidence');
  });

  it('uses verified position dates only for expressly whole-tenure actions', () => {
    const position = { role: 'Backend Engineer', start: '2015', end: '2024' };
    const job = evidence('job', 'Backend Engineer\n2015\n2024', {
      position,
      activityId: 'role',
    });
    const tenure = evidence(
      'activity',
      'Maintained production Node.js backends throughout my tenure.',
      {
        activityId: 'role',
        activityPosition: position,
      },
    );
    const bare = { ...tenure, text: 'Maintained production Node.js backends.' };
    const duration = {
      minimumYears: null,
      maximumYears: null,
      entirePosition: true,
    };
    const proofs = (source: Record) => [
      claim(source, 'nodejs', { context: 'production', duration }),
      claim(source, 'backend-development', { duration }),
    ];
    const required =
      '7+ years of backend engineering experience running Node.js in production';
    const qualified = decide(required, [job, tenure], proofs(tenure));
    expect(qualified.status).toBe('qualified');
    expect(
      qualified.reasons
        .find(({ code }) => code === 'required-capability')
        ?.citations.map(({ id }) => id),
    ).toEqual(expect.arrayContaining(['job', 'activity']));
    expect(decide(required, [tenure], proofs(tenure)).status).toBe('qualified');
    expect(candidate([job, bare], proofs(bare)).interpretationIssue?.code).toBe(
      'candidate-interpretation-failed',
    );
    expect(
      decide(
        required,
        [job, bare],
        proofs(bare).map((item) => ({ ...item, duration: null })),
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('separates recognized context and duration gaps from missing capability evidence', () => {
    const scope = evidence(
      'scope',
      'Implemented job scheduling for a Node.js service.',
    );
    const production = 'production experience with Node.js';
    const findGap = (result: ReturnType<typeof decide>) =>
      result.reasons.find(({ code }) => code === 'required-capability');
    expect(
      findGap(decide(production, [scope], [claim(scope, 'nodejs')])),
    ).toMatchObject({
      evidenceGaps: [
        { conceptId: 'nodejs', missing: 'context', context: 'production' },
      ],
      message: expect.stringContaining(
        'Matching still needs confirmation of production experience',
      ),
    });
    expect(findGap(decide(production, [], []))?.evidenceGaps).toBeUndefined();
    const requirement =
      '7+ years of backend engineering experience running Node.js in production';
    expect(
      findGap(decide(requirement, [first, second], periods)),
    ).toMatchObject({
      evidenceGaps: [
        { missing: 'duration', observedYears: 5, requiredYears: 7 },
      ],
      message: expect.stringContaining('a lower bound of 5 years'),
    });
    const undated = periods
      .slice(0, 2)
      .map((assertion) => ({ ...assertion, period: null }));
    expect(findGap(decide(requirement, [first], undated))).toMatchObject({
      evidenceGaps: [{ missing: 'duration', requiredYears: 7 }],
      message: expect.stringContaining(
        'dates do not establish the required 7+ years',
      ),
    });
  });

  it('unions overlapping observations, combines only overlapping compound periods and remains monotone', () => {
    expect(
      decide(
        '5+ years of backend engineering experience running Node.js in production',
        [first, second],
        periods,
      ).status,
    ).toBe('qualified');
    const withoutTechnologyDates = periods.map((assertion) =>
      assertion.conceptId === 'nodejs'
        ? { ...assertion, period: null }
        : assertion,
    );
    expect(
      decide(
        '5+ years of backend engineering experience running Node.js in production',
        [first, second],
        withoutTechnologyDates,
      ).status,
    ).toBe('insufficient-evidence');
    const seven =
      '7+ years of backend engineering experience running Node.js in production';
    expect(decide(seven, [first, second], periods).status).toBe(
      'insufficient-evidence',
    );
    expect(
      decide(
        seven,
        [first, second, third],
        [...periods, ...claims(third, '2021-02-01', '2023-04-01')],
      ).status,
    ).toBe('qualified');
    expect(
      decide(
        seven,
        [first, second, third],
        [
          ...periods,
          claim(third, 'nodejs', {
            context: 'production',
            period: { start: '2021-02-01', end: '2023-04-01' },
          }),
          claim(third, 'backend-development'),
        ],
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('advances explicitly ongoing observations against an injected as-of date', () => {
    const current = evidence(
      'current',
      'Maintained the live Node.js backend from 2020-01-01 through present.',
    );
    const records = [current];
    const interpreted = claims(current, '2020-01-01', 'present');
    const required =
      '5+ years of backend engineering experience running Node.js in production';
    expect(candidate(records, interpreted).hasOngoingExperience).toBe(true);
    expect(
      decide(required, records, interpreted, Date.UTC(2024, 0, 1)).status,
    ).toBe('insufficient-evidence');
    expect(
      decide(required, records, interpreted, Date.UTC(2026, 0, 1)).status,
    ).toBe('qualified');
    expect(
      candidate([first], periods.slice(0, 2)).hasOngoingExperience,
    ).toBeUndefined();
  });
});

describe('owner explanations for related verified work', () => {
  it.each([
    {
      requirement: 'Software performance tuning',
      related: 'software-performance-engineering',
      text: 'I designed the rendering architecture for a scalable application.',
      missing: 'measured software performance improvement',
    },
    {
      requirement: 'Empathy for developer experience',
      related: 'developer-tooling',
      text: 'I built a command-line toolkit for application developers.',
      missing: 'identified and responded to developer needs',
    },
  ])('shows $related as related evidence without qualifying or screening it', ({
    requirement,
    related,
    text,
    missing,
  }) => {
    const source = evidence('owned-related', text);
    const proof = claim(source, related);
    const result = decide(requirement, [source], [proof]);
    expect(result).toMatchObject({ status: 'insufficient-evidence', score: 0 });
    expect(result.screenedWithGaps).toBeUndefined();
    const requirementReason = (value: typeof result) =>
      value.reasons.find(({ code }) => code === 'required-capability');
    expect(requirementReason(result)).toMatchObject({
      outcome: 'unknown',
      evidenceGaps: [{ missing: 'related', relatedCapabilities: [related] }],
      citations: expect.arrayContaining([
        expect.objectContaining({
          field: 'evidence',
          id: source.id,
          evidenceDigest: candidateEvidenceDigest(source),
        }),
      ]),
    });
    expect(requirementReason(result)?.message).toMatch(/^Your evidence shows/u);
    expect(requirementReason(result)?.message).toContain(missing);
    for (const nonProof of [
      claim(source, 'software-development'),
      { ...proof, support: 'stated' as const },
      { ...proof, support: 'inferred' as const },
    ]) {
      const weak = decide(requirement, [source], [nonProof]);
      expect(requirementReason(weak)?.evidenceGaps).toBeUndefined();
      expect(weak.score).toBe(0);
    }
  });
});

describe('source coverage and requirement explanations', () => {
  const node = evidence('node', 'Built a Node.js request router for a lab.');
  const react = evidence('react', 'Added keyboard navigation in React.');
  const omitted = evidence(
    'omitted',
    'Operated the live Node.js service. The frontend runs separately.',
  );
  const relevantQuote = 'Operated the live Node.js service.';
  const assertions = [claim(node, 'nodejs'), claim(react, 'react')];
  const sources = [node, react, omitted];
  type Coverage = NonNullable<CandidateInterpretation['sourceCoverage']>;
  function partial(issue: Coverage[number]['issues'][number]) {
    return {
      state: 'partial',
      interpretation: {
        assertions,
        reviewedSourceIds: [node.id, react.id],
        unresolvedSourceIds: [omitted.id],
        sourceCoverage: [
          { sourceId: node.id, issues: [] },
          { sourceId: react.id, issues: [] },
          { sourceId: omitted.id, issues: [issue] },
        ],
      },
    } satisfies CandidateInterpretationState;
  }
  const omittedPositive = partial({
    kind: 'omitted-positive',
    conceptId: 'nodejs',
    quote: relevantQuote,
  });
  const match = (required: string, state: CandidateInterpretationState) =>
    decide(required, sources, undefined, asOf, state);
  const requirement = (result: ReturnType<typeof decide>) =>
    result.reasons.find(({ code }) => code === 'required-capability');

  it('cites the exact relevant omitted positive and preserves unrelated specificity gaps', () => {
    const result = match('production experience with Node.js', omittedPositive);
    expect(result.status).toBe('insufficient-evidence');
    expect(requirement(result)).toMatchObject({
      outcome: 'unknown',
      message: expect.stringContaining('relevant evidence'),
      citations: expect.arrayContaining([
        {
          field: 'evidence',
          id: omitted.id,
          start: 0,
          end: relevantQuote.length,
          text: relevantQuote,
          evidenceDigest: candidateEvidenceDigest(omitted),
        },
      ]),
    });
    expect(requirement(result)?.evidenceGaps).toBeUndefined();
    const unrelated = requirement(
      match('production experience with React', omittedPositive),
    );
    expect(unrelated?.message).toContain(
      'Matching still needs confirmation of production',
    );
    expect(unrelated?.citations.some(({ id }) => id === omitted.id)).toBe(
      false,
    );
  });

  it('qualifies already proven requirements only when exact coverage leaves positive omissions alone', () => {
    expect(match('React', omittedPositive).status).toBe('qualified');
    const { sourceCoverage: _coverage, ...legacy } =
      omittedPositive.interpretation;
    expect(
      match('React', { state: 'partial', interpretation: legacy }).status,
    ).toBe('insufficient-evidence');
    expect(
      match('React', {
        state: 'failed',
        interpretation: omittedPositive.interpretation,
      }).status,
    ).toBe('insufficient-evidence');
    expect(
      match('React', {
        ...omittedPositive,
        interpretation: {
          ...omittedPositive.interpretation,
          sourceCoverage:
            omittedPositive.interpretation.sourceCoverage.slice(1),
        },
      }).status,
    ).toBe('insufficient-evidence');
  });

  it('distinguishes a possible restriction from unread evidence and blocks qualification for both', () => {
    const restriction = partial({
      kind: 'unassessed-restriction',
      conceptId: 'react',
      quote: null,
    });
    const unread = partial({
      kind: 'unread',
      conceptId: null,
      quote: null,
    });
    const restricted = match('React', restriction);
    expect(restricted.status).toBe('insufficient-evidence');
    expect(requirement(restricted)?.message).toContain('possible restriction');
    const unreadResult = match('React', unread);
    expect(unreadResult.status).toBe('insufficient-evidence');
    expect(requirement(unreadResult)?.message).toContain(
      'has not been reviewed',
    );
    const missing = requirement(
      match('production experience with React', unread),
    );
    expect(missing?.evidenceGaps).toBeUndefined();
    expect(missing?.message).not.toContain(
      'Matching still needs confirmation of production',
    );
  });
});
