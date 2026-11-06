import { describe, expect, it } from 'vitest';
import { MATCHING_ROLE_SUGGESTIONS } from '../matching-role-suggestions.js';
import {
  type MatchingSourceExtraction,
  type MatchingSourceSpan,
  parseMatchingSourceExtraction,
} from './matching-source-extraction-contract.js';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  type MatchingCandidateInput,
  type MatchingPostingInput,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const vocabulary = compileMatchingVocabulary([
  {
    slug: 'nodejs',
    label: 'Node.js',
    aliases: ['node js', 'nodejs'],
    related: ['typescript'],
  },
  { slug: 'typescript', label: 'TypeScript', aliases: ['TS'] },
  { slug: 'postgresql', label: 'PostgreSQL', aliases: ['Postgres'] },
  { slug: 'sqlite', label: 'SQLite' },
  { slug: 'kubernetes', label: 'Kubernetes', aliases: ['K8s'] },
  { slug: 'c++', label: 'C++' },
  { slug: 'c#', label: 'C#' },
]);

const posting: MatchingPostingInput = {
  title: 'Senior Backend Engineer',
  location: 'Remote (Canada)',
  description:
    'Required skills: Node.js and either PostgreSQL or SQLite\nPreferred skills: Kubernetes',
};
const skill = (text: string) => ({ id: text, text, kind: 'skill' as const });
const fact = (text: string) => ({
  id: 'assertion',
  text,
  kind: 'fact' as const,
});
const candidate: MatchingCandidateInput = {
  targetRoles: ['Data Analyst', 'Backend Engineer'],
  locations: ['United Kingdom', 'CA'],
  workModes: ['remote'],
  evidence: [skill('Node JS'), skill('Postgres')],
};

function match(
  source: Partial<MatchingPostingInput> = {},
  profile: Partial<MatchingCandidateInput> = {},
) {
  return evaluateNormalizedMatch(
    normalizeMatchingPosting({ ...posting, ...source }, vocabulary),
    normalizeMatchingCandidate({ ...candidate, ...profile }, vocabulary),
  );
}

describe('normalized matching from raw text', () => {
  it('leaves ungoverned or conflicting role suffixes unresolved by default', () => {
    for (const title of [
      'Engineering Manager - Spark',
      'Engineering Manager - Account Executive',
    ])
      expect(
        normalizeMatchingPosting({ ...posting, title }, vocabulary).role,
      ).toBeUndefined();
  });

  it('keeps bare worldwide geography opt-in and does not widen a bare office', () => {
    const worldwide = {
      ...posting,
      location: 'Worldwide',
      workplaceType: 'remote',
    };
    const typed = { typedDecisionPreparation: true as const };
    expect(
      normalizeMatchingPosting(worldwide, vocabulary).geography,
    ).toBeUndefined();
    expect(
      normalizeMatchingPosting(worldwide, vocabulary, undefined, typed)
        .geography,
    ).toMatchObject({ mode: 'remote', worldwide: true });
    for (const source of [
      { ...worldwide, location: 'Canada' },
      { ...worldwide, workplaceType: 'hybrid' },
    ])
      expect(
        normalizeMatchingPosting(source, vocabulary, undefined, typed)
          .geography,
      ).toBeUndefined();
  });

  it('qualifies exact aliases, one alternative per group, and multi-choice role and location preferences', () => {
    const result = match();
    expect(result.status).toBe('qualified');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'required-capability',
          outcome: 'supported',
          citations: expect.arrayContaining([
            expect.objectContaining({
              field: 'evidence',
              id: 'Postgres',
              text: 'Postgres',
            }),
          ]),
        }),
        expect.objectContaining({
          code: 'preferred-capability',
          outcome: 'unknown',
        }),
      ]),
    );
    expect(
      match({}, { evidence: [...candidate.evidence, skill('K8s')] }).score,
    ).toBeGreaterThan(result.score);
    expect(
      match({}, { evidence: [skill('Node.js'), skill('SQLite')] }).status,
    ).toBe('qualified');
    expect(match({}, { evidence: [skill('Postgres')] }).status).toBe(
      'insufficient-evidence',
    );
  });

  it('supports conventional discipline shorthand without broadening architecture or ML specialty', () => {
    const profile = {
      targetRoles: [
        'Software engineering',
        'AI & ML development',
        'Technical architecture',
      ],
    };
    expect(match({ title: 'Backend Engineer' }, profile).status).toBe(
      'qualified',
    );
    expect(match({ title: 'AI/ML Engineer' }, profile).status).toBe(
      'qualified',
    );
    expect(match({ title: 'Technical Architect' }, profile).status).toBe(
      'qualified',
    );
    expect(match({ title: 'Solutions Architect' }, profile).status).toBe(
      'conflict',
    );
    expect(match({ title: 'Sales Engineer' }, profile).status).toBe('conflict');
    const specialized = { targetRoles: ['Fullstack', 'AI/LLM engineering'] };
    expect(match({ title: 'Full Stack Engineer' }, specialized).status).toBe(
      'qualified',
    );
    expect(match({ title: 'LLM Engineer' }, specialized).status).toBe(
      'qualified',
    );
    expect(
      match({ title: 'Machine Learning Engineer' }, specialized).status,
    ).toBe('insufficient-evidence');
    expect(match({ title: 'Backend Engineer' }, specialized).status).toBe(
      'conflict',
    );
  });

  it('separates common ATS title metadata and recognizes explicit role declarations', () => {
    expect(
      match({ title: 'Senior Software Engineer, Backend (Remote)' }).status,
    ).toBe('qualified');
    expect(
      match(
        { title: 'Software Engineer II — Payments' },
        { targetRoles: ['Software Engineer'] },
      ).status,
    ).toBe('qualified');
    expect(
      match(
        { title: 'Senior Software Engineer — Product Manager' },
        { targetRoles: ['Software Engineer'] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match({
        title: 'Opportunity',
        description: `We are hiring a Backend Engineer to build APIs.\n${posting.description}`,
      }).status,
    ).toBe('qualified');
  });

  it('recognizes common requirements, preserves optional clauses, and exits hiring footer sections', () => {
    const description = [
      '### What you’ll bring',
      '• Strong proficiency with Node.js',
      '• Knowledge of PostgreSQL, SQLite, or TypeScript',
      'Preferred Skills and Experience:',
      'A degree is preferred but not required.',
      'About our hiring process',
      'Only candidates selected for interview will be contacted.',
      'Our Benefits',
      'Eligible employees may receive a travel stipend.',
      'US Pay Range:',
      'The minimum varies by location.',
      'Equal Employment Opportunity',
      'Hiring requirements are applied consistently.',
    ].join('\n');
    expect(match({ description }).status).toBe('qualified');
    expect(
      match({
        description: `${description}\nCandidates must be authorized to work in Canada.`,
      }).status,
    ).toBe('insufficient-evidence');
    expect(
      match(
        {
          description:
            'Required: 3+ years’ relevant hands-on experience with PostgreSQL',
        },
        { evidence: [fact('4 years of experience with Postgres.')] },
      ).status,
    ).toBe('qualified');
  });

  it('admits classified ATS prose only with independently verified complete source groups', () => {
    const description =
      'About the role\nThe role calls for a working knowledge of Node.js or TypeScript.';
    const span = (quote: string): MatchingSourceSpan => ({
      field: 'description',
      start: description.indexOf(quote),
      end: description.indexOf(quote) + quote.length,
      quote,
    });
    const node = { capability: span('Node.js'), years: null, context: null };
    const typescript = {
      capability: span('TypeScript'),
      years: null,
      context: null,
    };
    const clause = span(
      'The role calls for a working knowledge of Node.js or TypeScript.',
    );
    const extraction: MatchingSourceExtraction = {
      coverage: 'complete',
      role: null,
      geography: null,
      noRequirements: null,
      required: [{ clause, alternatives: [node, typescript] }],
      preferred: [],
      unresolved: [],
    };
    const profile = normalizeMatchingCandidate(candidate, vocabulary);
    const evaluate = (proof?: MatchingSourceExtraction, raw = description) =>
      evaluateNormalizedMatch(
        normalizeMatchingPosting(
          { ...posting, description: raw },
          vocabulary,
          proof,
        ),
        profile,
      ).status;
    expect(evaluate()).toBe('insufficient-evidence');
    expect(evaluate(extraction)).toBe('qualified');
    expect(evaluate({ ...extraction, coverage: 'partial' })).toBe(
      'insufficient-evidence',
    );
    expect(
      evaluate({ ...extraction, required: [{ clause, alternatives: [node] }] }),
    ).toBe('insufficient-evidence');
    expect(
      evaluate(
        extraction,
        `${description}\nApplicants must have a security clearance.`,
      ),
    ).toBe('insufficient-evidence');

    const conjunctive = description.replace(
      ' or TypeScript',
      ' and TypeScript',
    );
    const andClause = {
      ...clause,
      end: clause.end + 1,
      quote: clause.quote.replace(' or ', ' and '),
    };
    expect(
      evaluate(
        {
          ...extraction,
          required: [{ clause: andClause, alternatives: [node] }],
        },
        conjunctive,
      ),
    ).toBe('insufficient-evidence');
  });

  it('keeps incomplete source requirements unresolved when interpretation omits a whole uncued line', () => {
    const line =
      'The role calls for a working knowledge of Node.js or TypeScript.';
    const description = `About the role\n${line}`;
    const span = (quote: string): MatchingSourceSpan => ({
      field: 'description',
      start: description.indexOf(quote),
      end: description.indexOf(quote) + quote.length,
      quote,
    });
    const extraction: MatchingSourceExtraction = {
      coverage: 'complete',
      role: null,
      geography: null,
      noRequirements: null,
      required: [
        {
          clause: span(line),
          alternatives: [
            { capability: span('Node.js'), years: null, context: null },
            { capability: span('TypeScript'), years: null, context: null },
          ],
        },
      ],
      preferred: [],
      unresolved: [],
    };
    const profile = normalizeMatchingCandidate(candidate, vocabulary);
    const decision = (raw: string) =>
      evaluateNormalizedMatch(
        normalizeMatchingPosting(
          { ...posting, description: raw },
          vocabulary,
          extraction,
        ),
        profile,
      );
    const roleLine =
      'We are hiring a Backend Engineer, and Kafka is a core skill.';
    const roleStart = description.length + 1;
    const mixed = evaluateNormalizedMatch(
      normalizeMatchingPosting(
        { ...posting, description: `${description}\n${roleLine}` },
        vocabulary,
        {
          ...extraction,
          role: {
            field: 'description',
            start: roleStart,
            end: roleStart + roleLine.length,
            quote: roleLine,
          },
          roleTitle: 'Backend Engineer',
        },
      ),
      profile,
    );
    expect(mixed.status).toBe('insufficient-evidence');
    expect(mixed.reasons).toContainEqual(
      expect.objectContaining({ code: 'posting-requirement-unknown' }),
    );
    const mixedSource = {
      ...posting,
      description: `${description}\n${roleLine}`,
    };
    const asEmployer = parseMatchingSourceExtraction(
      {
        ...extraction,
        nonRequirements: [
          {
            field: 'description',
            start: roleStart,
            end: roleStart + roleLine.length,
            quote: roleLine,
          },
        ],
      },
      mixedSource,
    );
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(mixedSource, vocabulary, asEmployer),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
    expect(decision(description).status).toBe('qualified');
    const uncued = decision(`${description}\nFluent spoken Finnish.`);
    expect(uncued.status).toBe('insufficient-evidence');
    expect(uncued.reasons).toContainEqual(
      expect.objectContaining({ code: 'posting-requirements-incomplete' }),
    );
    for (const requirement of [
      'Kafka experience is essential.',
      'You’ll need Kafka.',
    ]) {
      const omitted = decision(`${description}\n${requirement}`);
      expect(omitted.status).toBe('insufficient-evidence');
      expect(omitted.reasons).toContainEqual(
        expect.objectContaining({ code: 'posting-requirement-unknown' }),
      );
    }
    expect(
      decision(
        `${description}\nResponsibilities\nBuild product services.\nBenefits\nFlexible holidays.`,
      ).status,
    ).toBe('qualified');
    expect(
      decision(
        `${description}\nResponsibilities\nBuild product services.\nAbout the role\nFluent spoken Finnish.`,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it.each([
    ['About the role', 'We offer flexible hours and expect Kafka knowledge.'],
    [
      'About the company',
      'Our company makes scheduling flexible but expects Kafka knowledge.',
    ],
    [
      'Benefits',
      'We provide flexible hours and Kafka knowledge is a core skill.',
    ],
    ['Benefits', 'Kafka fluency.'],
    ['Benefits', 'Flexible hours; Kafka fluency.'],
    ['Responsibilities', 'Build services and demonstrate Kafka proficiency.'],
    [
      'Preferred skills',
      'Node.js preferred, but applicants should bring Kafka knowledge.',
    ],
    [
      'About the role',
      'We are hiring a Backend Engineer with Kafka knowledge.',
    ],
    ['About the role', 'Location: Toronto, and expect Kafka knowledge.'],
    ['About the role', 'Location: Toronto, Kafka proficiency.'],
  ])('does not exempt mixed candidate conditions under %s', (heading, mixed) => {
    const required = 'The role calls for a working knowledge of Node.js.';
    const raw = {
      ...posting,
      description: `About the role\n${required}\n${heading}\n${mixed}`,
    };
    const span = (quote: string): MatchingSourceSpan => ({
      field: 'description',
      quote,
      start: raw.description.indexOf(quote),
      end: raw.description.indexOf(quote) + quote.length,
    });
    const extraction: MatchingSourceExtraction = {
      coverage: 'complete',
      role: null,
      geography: null,
      noRequirements: null,
      required: [
        {
          clause: span(required),
          alternatives: [
            { capability: span('Node.js'), years: null, context: null },
          ],
        },
      ],
      preferred: [],
      unresolved: [],
      nonRequirements: [span(mixed)],
    };
    const profile = normalizeMatchingCandidate(candidate, vocabulary);
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary, extraction),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
    // The same mixed line must remain a gate even if deterministic parsing
    // found complete requirements elsewhere and does not need recovery.
    const deterministic = {
      ...raw,
      description: `Required: Node.js\n${heading}\n${mixed}`,
    };
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(deterministic, vocabulary),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('uses source interpretations of ordinary ATS prose beyond the fallback grammar', () => {
    const title = 'Senior Software Engineer — Merchandising Automation';
    const geography =
      "We're a remote-first team and this opening is available to applicants based in Canada.";
    const clause =
      'You have shipped services running on Node.js for 4+ years in production.';
    const employer =
      'We provide flexible holidays and maintain a supportive team.';
    const description = [
      geography,
      'Minimum Qualifications',
      clause,
      'Benefits',
      employer,
    ].join('\n');
    const raw = { title, description, location: 'Remote' };
    const span = (
      quote: string,
      field: MatchingSourceSpan['field'] = 'description',
    ): MatchingSourceSpan => ({
      field,
      quote,
      start: raw[field].indexOf(quote),
      end: raw[field].indexOf(quote) + quote.length,
    });
    const input: MatchingSourceExtraction = {
      coverage: 'complete',
      role: span(title, 'title'),
      roleTitle: 'Senior Software Engineer',
      geography: span(geography),
      workLocation: 'Canada',
      workplaceType: 'remote',
      noRequirements: null,
      required: [
        {
          clause: span(clause),
          alternatives: [
            { capability: span('Node.js'), years: 4, context: 'production' },
          ],
        },
      ],
      preferred: [],
      unresolved: [],
      nonRequirements: [span(employer)],
    };
    const profile = normalizeMatchingCandidate(
      {
        ...candidate,
        targetRoles: ['Software Engineer'],
        evidence: [fact('5 years of production experience with Node.js.')],
      },
      vocabulary,
    );
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
    const parsed = parseMatchingSourceExtraction(input, raw);
    const resolved = evaluateNormalizedMatch(
      normalizeMatchingPosting(raw, vocabulary, parsed),
      profile,
    );
    expect(resolved.status).toBe('qualified');
    expect(resolved.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        message:
          'Your evidence supports 4+ years of production experience with Node.js.',
      }),
    );
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary, {
          ...parsed,
          nonRequirements: [],
        }),
        profile,
      ).status,
    ).toBe('qualified');
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary, {
          ...parsed,
          required: [
            {
              ...input.required[0],
              alternatives: [
                { capability: span('Node.js'), years: null, context: null },
              ],
            },
          ],
        }),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
    const hidden =
      'We provide a flexible schedule but candidates must possess a security clearance.';
    const unsafeRaw = {
      ...raw,
      description: description.replace(employer, hidden),
    };
    const fakeFooter = {
      field: 'description',
      quote: hidden,
      start: description.indexOf(employer),
      end: description.indexOf(employer) + hidden.length,
    } as const;
    expect(() =>
      parseMatchingSourceExtraction(
        { ...input, nonRequirements: [fakeFooter] },
        unsafeRaw,
      ),
    ).toThrow();
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(unsafeRaw, vocabulary, {
          ...parsed,
          nonRequirements: [fakeFooter],
        }),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('preserves omitted alternatives and conjuncts even when source excerpts match exactly', () => {
    for (const remainder of [
      'or Redis',
      'and Redis',
      ', Redis',
      'and an occupational license',
    ]) {
      const line = `You have delivered customer features with Node.js ${remainder}.`;
      const description = `Minimum Qualifications\n${line}`;
      const raw = { ...posting, description };
      const span = (quote: string): MatchingSourceSpan => ({
        field: 'description',
        quote,
        start: description.indexOf(quote),
        end: description.indexOf(quote) + quote.length,
      });
      const proof: MatchingSourceExtraction = {
        coverage: 'complete',
        role: null,
        geography: null,
        noRequirements: null,
        required: [
          {
            clause: span(line),
            alternatives: [
              { capability: span('Node.js'), years: null, context: null },
            ],
          },
        ],
        preferred: [],
        unresolved: [],
      };
      expect(
        evaluateNormalizedMatch(
          normalizeMatchingPosting(raw, vocabulary, proof),
          normalizeMatchingCandidate(candidate, vocabulary),
        ).status,
      ).toBe('insufficient-evidence');
    }
  });

  it('keeps a duration that may cover multiple named capabilities unresolved', () => {
    const description =
      'Required: 4 years of experience with Node.js and PostgreSQL';
    const raw = { ...posting, description };
    const span = (quote: string): MatchingSourceSpan => ({
      field: 'description',
      quote,
      start: description.indexOf(quote),
      end: description.indexOf(quote) + quote.length,
    });
    const input: MatchingSourceExtraction = {
      coverage: 'complete',
      role: null,
      geography: null,
      noRequirements: null,
      required: [
        {
          clause: span('4 years of experience with Node.js'),
          alternatives: [
            { capability: span('Node.js'), years: 4, context: null },
          ],
        },
        {
          clause: span('PostgreSQL'),
          alternatives: [
            { capability: span('PostgreSQL'), years: null, context: null },
          ],
        },
      ],
      preferred: [],
      unresolved: [],
    };
    const parsed = parseMatchingSourceExtraction(input, raw);
    const profile = normalizeMatchingCandidate(
      {
        ...candidate,
        evidence: [
          fact('5 years of experience with Node.js.'),
          skill('PostgreSQL'),
        ],
      },
      vocabulary,
    );
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, vocabulary, parsed),
        profile,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('accepts explicit cited role and geography only when they fill missing facts', () => {
    const role = 'The primary role is a Senior Backend Engineer.';
    const geography = 'Employees may work remotely from anywhere in Canada.';
    const description = [role, geography, 'Required: Node.js'].join('\n');
    const span = (quote: string): MatchingSourceSpan => ({
      field: 'description',
      start: description.indexOf(quote),
      end: description.indexOf(quote) + quote.length,
      quote,
    });
    const extraction: MatchingSourceExtraction = {
      coverage: 'partial',
      role: span(role),
      geography: span(geography),
      noRequirements: null,
      required: [],
      preferred: [],
      unresolved: [],
    };
    const profile = normalizeMatchingCandidate(candidate, vocabulary);
    const decision = (
      title: string,
      location: string,
      proof: MatchingSourceExtraction,
    ) =>
      evaluateNormalizedMatch(
        normalizeMatchingPosting(
          { title, location, description },
          vocabulary,
          proof,
        ),
        profile,
      ).status;
    expect(decision('Opportunity', 'Remote', extraction)).toBe('qualified');
    expect(decision('Opportunity', 'Remote (EMEA)', extraction)).toBe(
      'insufficient-evidence',
    );
    expect(decision('Opportunity', 'Remote (United States)', extraction)).toBe(
      'insufficient-evidence',
    );
    expect(decision('Engineering Manager', 'Remote', extraction)).toBe(
      'insufficient-evidence',
    );
    expect(
      decision('Opportunity', 'Remote', {
        ...extraction,
        geography: span('Canada'),
      }),
    ).toBe('insufficient-evidence');
  });

  it('interprets disciplines as role targets while retaining explicit restrictions', () => {
    expect(match({}, { targetRoles: ['Software engineering'] }).status).toBe(
      'qualified',
    );
    expect(
      match({}, { targetRoles: ['Senior backend engineering'] }).status,
    ).toBe('qualified');
    expect(
      match({}, { targetRoles: ['Staff backend engineering'] }).status,
    ).toBe('conflict');
    expect(
      match({}, { targetRoles: ['Frontend software development'] }).status,
    ).toBe('conflict');
    expect(
      match(
        { title: 'Sales Manager' },
        { targetRoles: ['Software engineering'] },
      ).status,
    ).toBe('conflict');
    expect(
      match(
        { title: 'Sales Manager' },
        { targetRoles: ['Software engineering', 'Other idea'] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match({}, { targetRoles: ['Software engineering', 'Other idea'] }).status,
    ).toBe('qualified');
    expect(
      match(
        { title: 'Software engineering' },
        { targetRoles: ['Software engineering'] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match({}, { targetRoles: ['Software engineering or Sales'] }).reasons,
    ).toContainEqual(
      expect.objectContaining({ code: 'candidate-role-choice-unknown' }),
    );
  });

  it.each(
    MATCHING_ROLE_SUGGESTIONS,
  )('recognizes onboarding target %s', (targetRole) => {
    const normalized = normalizeMatchingCandidate(
      { ...candidate, targetRoles: [targetRole] },
      vocabulary,
    );
    expect(normalized.roles).toHaveLength(1);
    expect(normalized.rolePreferenceStatus).toBeUndefined();
    expect(normalized.roles[0]?.citation.text).toBe(targetRole);
    expect(
      match({ title: targetRole }, { targetRoles: [targetRole] }).status,
    ).toBe('qualified');
  });

  it('does not broaden explicit or ambiguous qualifications', () => {
    expect(
      match({}, { targetRoles: ['Software Engineer, Backend'] }).status,
    ).toBe('qualified');
    expect(
      match({}, { targetRoles: ['Software Engineer, Frontend'] }).status,
    ).toBe('conflict');
    expect(
      match({}, { targetRoles: ['Software Engineer, Platform'] }).status,
    ).toBe('insufficient-evidence');
    expect(match({}, { targetRoles: ['Software Engineer IV'] }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({}, { targetRoles: ['Technical Lead'] }).status).toBe(
      'conflict',
    );
    expect(match({}, { targetRoles: ['Software Architect'] }).status).toBe(
      'conflict',
    );
  });

  it('keeps title specialty and seniority distinct from broader role intent', () => {
    expect(match({}, { targetRoles: ['Software Engineer'] }).status).toBe(
      'qualified',
    );
    expect(match({}, { targetRoles: ['Frontend Engineer'] }).status).toBe(
      'conflict',
    );
    expect(match({}, { targetRoles: ['Staff Backend Engineer'] }).status).toBe(
      'conflict',
    );
    expect(
      match(
        { title: 'Backend Engineer' },
        { targetRoles: ['Senior Backend Engineer'] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(match({ title: 'Sales Manager, Software Engineering' }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({ title: 'Engineering Manager' }).status).toBe('conflict');
    expect(
      match(
        {},
        {
          targetRoles: [],
          evidence: [skill('Node.js'), fact('Senior Backend Engineer')],
        },
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('does not infer unrestricted remote access from a remote flag, an employer location, or a broad region', () => {
    expect(match({ location: 'Remote (United States)' }).status).toBe(
      'conflict',
    );
    expect(match({ location: 'Remote (Canada only)' }).status).toBe(
      'qualified',
    );
    expect(match({ location: 'Remote (Canada or UK)' }).status).toBe(
      'qualified',
    );
    expect(match({ location: 'Remote (EMEA)' }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({ location: 'Canada', workplaceType: 'remote' }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({ location: 'Remote worldwide' }).status).toBe('qualified');
    expect(
      match({
        location: 'Remote',
        description: `${posting.description}\nApplicants must be based in Canada.`,
      }).status,
    ).toBe('qualified');
    expect(
      match({
        location: 'Remote worldwide',
        description: `${posting.description}\nRemote within United States.`,
      }).status,
    ).toBe('insufficient-evidence');
    expect(match({}, { remoteCountries: ['GB'] }).status).toBe('conflict');
  });

  it('does not replace explicit unresolved remote choices with general locations', () => {
    expect(match({}, { remoteCountries: ['EU'] }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({}, { remoteCountries: ['EU', 'GB'] }).status).toBe(
      'insufficient-evidence',
    );
    expect(match({}, { remoteCountries: ['EU', 'Canada'] }).status).toBe(
      'qualified',
    );
    expect(match({ location: 'Remote (CA)' }).status).toBe(
      'insufficient-evidence',
    );
    expect(
      match({
        location: 'Remote',
        description: `${posting.description}\nLocation: Canada`,
      }).status,
    ).toBe('insufficient-evidence');
  });

  it('accepts direct experience assertions while abstaining on incidental mentions', () => {
    expect(
      match(
        {},
        {
          evidence: [
            fact(
              'I built HTTP services using Node.js and PostgreSQL. Never used TypeScript.',
            ),
          ],
        },
      ).status,
    ).toBe('qualified');
    expect(
      match(
        {},
        {
          evidence: [fact('The team evaluated using Node.js and PostgreSQL.')],
        },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match({}, { evidence: [fact('Used Node.js or PostgreSQL.')] }).status,
    ).toBe('insufficient-evidence');
    const optional = match({
      description:
        'Required: Node.js\nPreferred: complex optional industry experience',
    });
    expect(optional.status).toBe('qualified');
    expect(optional.reasons).toContainEqual(
      expect.objectContaining({
        code: 'posting-preference-unknown',
        outcome: 'unknown',
      }),
    );
  });

  it('records only the directly evidenced subset of a partially supported requirement', () => {
    const partial = match(
      {
        description: 'Required: 5+ years of production experience with Node.js',
      },
      { evidence: [skill('Node.js')] },
    );
    expect(partial.status).toBe('insufficient-evidence');
    expect(partial.reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        partialSupport: 'Node.js',
      }),
    );
    const related = match(
      { description: 'Required: People management' },
      { evidence: [skill('Mentoring')] },
    );
    expect(
      related.reasons.some(
        ({ partialSupport }) => partialSupport !== undefined,
      ),
    ).toBe(false);
  });

  it('does not highlight unproven conjuncts or disputed alternatives', () => {
    const source = normalizeMatchingPosting(posting, vocabulary);
    const citation = source.required[0]?.citation;
    if (!citation) throw new Error('Expected a required source group');
    const compound = {
      ...source,
      required: [
        {
          citation,
          alternatives: [{ slug: 'production-node-backend-engineering' }],
        },
      ],
    };
    const profile = normalizeMatchingCandidate(
      { ...candidate, evidence: [skill('Node.js')] },
      vocabulary,
    );
    expect(evaluateNormalizedMatch(compound, profile).reasons).toContainEqual(
      expect.objectContaining({
        code: 'required-capability',
        outcome: 'unknown',
        partialSupport: 'Node.js',
      }),
    );
    const choice = {
      ...source,
      required: [
        {
          citation,
          alternatives: [
            { slug: 'nodejs', years: 3 },
            { slug: 'postgresql', years: 3 },
          ],
        },
      ],
    };
    const disputed = normalizeMatchingCandidate(
      {
        ...candidate,
        evidence: [
          skill('Node.js'),
          fact('Never used Node.js.'),
          skill('PostgreSQL'),
        ],
      },
      vocabulary,
    );
    expect(
      evaluateNormalizedMatch(choice, disputed).reasons,
    ).not.toContainEqual(
      expect.objectContaining({
        partialSupport: expect.stringContaining('Node.js'),
      }),
    );
  });

  it('treats related terms and punctuation-distinct skills as separate capabilities', () => {
    expect(match({ description: 'Required: TypeScript' }).status).toBe(
      'insufficient-evidence',
    );
    expect(
      match(
        { description: 'Required: People management' },
        { evidence: [skill('Mentoring')] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match({ description: 'Required: C#' }, { evidence: [skill('C++')] })
        .status,
    ).toBe('insufficient-evidence');
  });

  it('uses narrower evidence in one direction and broad explicit absence in the reverse', () => {
    expect(
      match(
        { description: 'Required: Networking' },
        { evidence: [skill('IP routing')] },
      ).status,
    ).toBe('qualified');
    expect(
      match(
        { description: 'Required: IP routing' },
        { evidence: [skill('Networking')] },
      ).status,
    ).toBe('insufficient-evidence');
    expect(
      match(
        { description: 'Required: IP routing' },
        { evidence: [fact('No experience with Networking.')] },
      ).status,
    ).toBe('conflict');
    expect(
      match(
        { description: 'Required: Networking' },
        { evidence: [fact('No experience with IP routing.')] },
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('keeps a missing alternative unknown and requires evidence for a known conflict', () => {
    const source = { description: 'Required: Node.js or TypeScript' };
    expect(
      match(source, { evidence: [fact('Never used Node.js.')] }).status,
    ).toBe('insufficient-evidence');
    expect(
      match(source, {
        evidence: [fact('No experience with Node.js; never used TypeScript')],
      }).status,
    ).toBe('conflict');
    expect(
      match(source, {
        evidence: [skill('Node.js'), fact('Never used Node.js.')],
      }).status,
    ).toBe('insufficient-evidence');
    expect(
      match(source, { evidence: [skill('TS'), fact('Never used Node.js.')] })
        .status,
    ).toBe('qualified');
  });

  it('keeps ungoverned atomic alternatives unknown without vetoing proven OR choices', () => {
    const graph = compileMatchingVocabulary([
      { slug: 'go', label: 'Go' },
      { slug: 'rust', label: 'Rust' },
    ]);
    const or = 'Experience with production-level Go, Rust, or Scala';
    const and = 'Knowledge of an unmapped runtime';
    const description = `Basic qualifications:\n${or}\n${and}`;
    const raw = { ...posting, description };
    const span = (quote: string) => ({
      field: 'description' as const,
      start: description.indexOf(quote),
      quote,
    });
    const extraction = (includeConjunct: boolean) =>
      parseMatchingSourceExtraction(
        {
          coverage: 'complete',
          role: null,
          geography: null,
          noRequirements: null,
          required: [
            {
              clause: span(or),
              alternatives: ['Go', 'Rust', 'Scala'].map((name) => ({
                capability: span(name),
                years: null,
                context: 'production',
              })),
            },
            ...(includeConjunct
              ? [
                  {
                    clause: span(and),
                    alternatives: [
                      {
                        capability: span('an unmapped runtime'),
                        years: null,
                        context: null,
                      },
                    ],
                  },
                ]
              : []),
          ],
          preferred: [],
          unresolved: [],
        },
        raw,
      );
    const proof = (text: string) =>
      normalizeMatchingCandidate(
        { ...candidate, evidence: [fact(text)] },
        graph,
      );
    const choiceOnly = normalizeMatchingPosting(
      { ...raw, description: `Basic qualifications:\n${or}` },
      graph,
      extraction(false),
    );
    expect(choiceOnly.required[0]?.alternatives).toContainEqual(
      expect.objectContaining({ slug: '', label: 'Scala' }),
    );
    expect(
      evaluateNormalizedMatch(
        choiceOnly,
        proof('Production experience with Go'),
      ).status,
    ).toBe('qualified');
    expect(
      evaluateNormalizedMatch(choiceOnly, proof('Experience with Go')).status,
    ).toBe('insufficient-evidence');
    expect(
      evaluateNormalizedMatch(
        normalizeMatchingPosting(raw, graph, extraction(true)),
        proof('Production experience with Go'),
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('requires duration and usage context to come from applicable, attributable evidence', () => {
    const source = {
      description:
        'Required: 3+ years of production experience with PostgreSQL',
    };
    expect(match(source).status).toBe('insufficient-evidence');
    expect(
      match(source, {
        evidence: [
          fact('5 years of experience with PostgreSQL'),
          fact('Production experience with PostgreSQL'),
        ],
      }).status,
    ).toBe('insufficient-evidence');
    expect(
      match(source, {
        evidence: [fact('4 years of production experience with Postgres.')],
      }).status,
    ).toBe('qualified');
    expect(
      match(source, {
        evidence: [fact('5 years of professional experience with PostgreSQL')],
      }).status,
    ).toBe('insufficient-evidence');
    expect(
      match({
        description:
          'Required: 3 years of production experience with PostgreSQL and Node.js',
      }).status,
    ).toBe('insufficient-evidence');
  });

  it('abstains on incomplete requirements and unsupported hard conditions', () => {
    for (const description of [
      '',
      'We build exciting new products.',
      'Preferred skills: Node.js',
      'Required: Node.js or TypeScript and PostgreSQL',
      'Required: Node.js\nPreferred: Kubernetes, but you must travel monthly',
      'Required: Node.js\nMust be legally authorized to work in Canada.',
      'Required: Node.js\nA bachelor’s degree or equivalent',
      'Required:\nNode.js\nSpecial secret license',
    ])
      expect(match({ description }).status, description).toBe(
        'insufficient-evidence',
      );
    expect(match({ description: 'No required qualifications.' }).status).toBe(
      'qualified',
    );
  });

  it('maps supported questions and keeps subjective must-haves unresolved', () => {
    const base = { id: 'question', required: true, kind: 'source' as const };
    const text = 'Does the posting explicitly allow working from "Canada"?';
    expect(match({}, { questions: [{ ...base, text }] }).status).toBe(
      'qualified',
    );
    expect(
      match({}, { questions: [{ ...base, text, desiredAnswer: 'no' }] }).status,
    ).toBe('conflict');
    const question = { ...base, text: 'Will I enjoy the company culture?' };
    expect(match({}, { questions: [question] }).status).toBe(
      'insufficient-evidence',
    );
    expect(
      match({}, { questions: [{ ...question, required: false }] }).status,
    ).toBe('qualified');
    expect(match({}, { incomplete: true }).status).toBe(
      'insufficient-evidence',
    );
  });

  it('retains source offsets through HTML and leaves alias collisions unresolved', () => {
    const description =
      '<h3>Required skills</h3><ul><li><b>Node.js</b></li><li>PostgreSQL</li></ul>';
    const result = match({ description });
    expect(result.status).toBe('qualified');
    const quotes = result.reasons.flatMap(({ citations }) =>
      citations.filter(({ field }) => field === 'description'),
    );
    expect(quotes.map(({ text }) => text)).toEqual(['Node.js', 'PostgreSQL']);
    for (const { text, start, end } of quotes)
      expect(description.slice(start, end)).toBe(text);

    const ambiguous = compileMatchingVocabulary([
      { slug: 'one', label: 'Shared' },
      { slug: 'two', label: 'Two', aliases: ['Shared'] },
    ]);
    const input = normalizeMatchingPosting(
      { ...posting, description: 'Required: Shared' },
      ambiguous,
    );
    expect(input.uncertainties).toEqual([
      expect.objectContaining({ code: 'posting-requirement-unknown' }),
      expect.objectContaining({
        code: 'posting-source-interpretation-missing',
      }),
    ]);
  });
});
