import { describe, expect, it } from 'vitest';
import { parseMatchingSourceExtraction } from './matching-source-extraction-contract.js';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';

const vocabulary = compileMatchingVocabulary([
  { slug: 'nodejs', label: 'Node.js' },
  { slug: 'typescript', label: 'TypeScript' },
  { slug: 'postgresql', label: 'PostgreSQL' },
]);
const raw = {
  title: 'Software Engineer',
  location: 'Remote - Canada',
  workplaceType: 'remote',
};
const posting = (description: string, location = raw.location) =>
  normalizeMatchingPosting({ ...raw, location, description }, vocabulary);
const candidate = normalizeMatchingCandidate(
  {
    targetRoles: ['Software Engineer'],
    locations: ['Canada'],
    workModes: ['remote'],
    remoteCountries: ['Canada'],
    evidence: [
      {
        id: '1',
        text: '4 years of professional experience with software development.',
      },
      { id: '2', text: 'Node.js', kind: 'skill' },
      { id: '3', text: 'PostgreSQL', kind: 'skill' },
    ],
  },
  vocabulary,
);

describe('public posting normalization', () => {
  it('recognizes ordinary required and optional ATS headings and scoped experience', () => {
    const description = [
      'What You Should Bring',
      '• 3+ years of professional software engineering experience',
      '• Proficiency in either Node.js or TypeScript',
      '• Experience with PostgreSQL',
      'Bonus points if you have:',
      '• Deep expertise in hypothetical optional framework',
    ].join('\n');
    const normalized = posting(description);
    expect(normalized.required).toHaveLength(3);
    expect(normalized.required[0]?.alternatives).toEqual([
      expect.objectContaining({
        slug: 'software-development',
        years: 3,
        context: 'professional',
      }),
    ]);
    expect(
      normalized.required[1]?.alternatives.map(({ slug }) => slug),
    ).toEqual(['nodejs', 'typescript']);
    expect(normalized.required[1]?.citation.text).toBe(
      'Proficiency in either Node.js or TypeScript',
    );
    expect(evaluateNormalizedMatch(normalized, candidate).status).toBe(
      'qualified',
    );
    expect(
      evaluateNormalizedMatch(
        posting(description.replace('3+ years', '7+ years')),
        candidate,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('keeps independent unknown requirements and unsupported scope unresolved', () => {
    for (const condition of [
      'Proficiency in either Node.js or TypeScript and an active security clearance',
      '3+ years of professional experience with Node.js and PostgreSQL',
      'Node.js or TypeScript and PostgreSQL',
      'You must have Node.js and familiarity with an unknown framework',
    ]) {
      const normalized = posting(
        `What You Should Bring\nExperience with PostgreSQL\n${condition}`,
      );
      expect(normalized.uncertainties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'posting-requirement-unknown' }),
        ]),
      );
      expect(evaluateNormalizedMatch(normalized, candidate).status).toBe(
        'insufficient-evidence',
      );
    }
  });

  it('preserves explicitly nested AND and OR rather than treating each leaf as independent', () => {
    const normalized = posting(
      'Minimum requirements: (Node.js and TypeScript) or PostgreSQL',
    );
    expect(
      normalized.required.map(({ alternatives }) =>
        alternatives.map(({ slug }) => slug),
      ),
    ).toEqual([
      ['nodejs', 'postgresql'],
      ['typescript', 'postgresql'],
    ]);
    expect(evaluateNormalizedMatch(normalized, candidate).status).toBe(
      'qualified',
    );
    expect(
      evaluateNormalizedMatch(
        posting('Minimum requirements: (Node.js or PostgreSQL) and TypeScript'),
        candidate,
      ).status,
    ).toBe('insufficient-evidence');
  });

  it('normalizes explicit source roles without discarding specialties or alternate titles', () => {
    const normalize = (title: string) =>
      normalizeMatchingPosting(
        { ...raw, title, description: 'Required: Node.js' },
        vocabulary,
      ).role;
    expect(normalize('Sr.Software Dev Engineer III')).toEqual(
      expect.objectContaining({
        family: 'software-engineering',
        level: 'senior',
      }),
    );
    expect(normalize('Software Engineer 2, Managed Gateways')).toEqual(
      expect.objectContaining({
        family: 'software-engineering',
        level: undefined,
      }),
    );
    expect(normalize('Enterprise Account Executive-ASEAN')?.family).toBe(
      'sales',
    );
    expect(
      normalize('Executive Assistant to CRO & Head of Strategic Sales')?.family,
    ).toBe('executive-support');
    expect(
      normalize('Executive Assistant to CRO / Software Engineer'),
    ).toBeUndefined();
    expect(normalize('Senior / Staff Software Engineer')).toBeUndefined();
  });

  it('uses repeated explicit remote country scopes without treating extra office metadata as permission', () => {
    const description = 'Required: Node.js';
    const normalized = posting(
      description,
      'Remote (Canada); Canada; Remote (United States); United States',
    );
    expect(normalized.geography?.regions).toEqual([
      { country: 'CA' },
      { country: 'US' },
    ]);
    expect(normalized.geography?.citation.text).toBe(
      'Remote (Canada); Canada; Remote (United States); United States',
    );
    expect(
      posting(description, 'Remote (Poland); Remote Spain').geography?.regions,
    ).toEqual([{ country: 'PL' }, { country: 'ES' }]);
    expect(
      posting(description, 'Remote (Canada); United States').geography,
    ).toBeUndefined();
    expect(
      posting(description, 'Remote (Canada); Hybrid - United States').geography,
    ).toBeUndefined();
    expect(
      posting(description, 'Remote - Canada: Select locations; Canada')
        .geography,
    ).toBeUndefined();
  });

  it('keeps conflicting structured and direct description locations unresolved', () => {
    for (const [location, workplaceType, description] of [
      [
        'Remote Germany; Remote France',
        'remote',
        'We have an office in Paris, but we do require that someone is based in Germany for the role.',
      ],
      ['Remote Germany; Remote France', 'remote', 'Location - Remote Germany'],
      [
        'Seattle, WA; Austin, TX',
        'onsite',
        'This role is based onsite in Seattle, WA.',
      ],
    ]) {
      const normalized = normalizeMatchingPosting(
        {
          ...raw,
          location,
          workplaceType,
          description: `${description}\nRequired: Node.js`,
        },
        vocabulary,
      );
      expect(normalized.geography).toBeUndefined();
      expect(normalized.uncertainties).toContainEqual(
        expect.objectContaining({
          code: 'posting-geography-ambiguous',
          citations: [
            expect.objectContaining({ text: location }),
            expect.objectContaining({ text: description }),
          ],
        }),
      );
    }
    const confirmed = posting(
      'This role is based remotely in Canada.\nLocation - Remote Canada\nRequired: Node.js',
    );
    expect(confirmed.geography?.regions).toEqual([{ country: 'CA' }]);
    expect(
      posting('Our office is based in Paris.\nRequired: Node.js').geography
        ?.regions,
    ).toEqual([{ country: 'CA' }]);
  });

  it('holds a direct description role that contradicts a known title or numbered grade', () => {
    for (const [title, line] of [
      [
        'Software Engineer II — Payments',
        'As a Senior Software Engineer, you’ll build payment services.',
      ],
      [
        'Senior Software Engineer',
        'As a Staff Software Engineer, you will build payment services.',
      ],
      ['Software Engineer', 'This position is for a Sales Manager.'],
    ]) {
      const normalized = normalizeMatchingPosting(
        {
          ...raw,
          title,
          description: `${line}\nRequired: Node.js`,
        },
        vocabulary,
      );
      expect(normalized.role).toBeUndefined();
      expect(normalized.uncertainties).toContainEqual(
        expect.objectContaining({
          code: 'posting-role-ambiguous',
          citations: [
            expect.objectContaining({ text: title }),
            expect.objectContaining({ text: line }),
          ],
        }),
      );
    }
    expect(
      posting('As a Software Engineer, you will build APIs.\nRequired: Node.js')
        .role?.family,
    ).toBe('software-engineering');
  });

  it('rejects a provider witness that drops the domain restriction from a named capability', () => {
    const line = 'Experience with Node.js for embedded payment terminals.';
    const description = `Qualifications\n${line}`;
    const source = { ...raw, description };
    const span = (quote: string) => ({
      field: 'description' as const,
      start: description.indexOf(quote),
      quote,
    });
    const extraction = parseMatchingSourceExtraction(
      {
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
      },
      source,
    );
    const result = evaluateNormalizedMatch(
      normalizeMatchingPosting(source, vocabulary, extraction),
      candidate,
    );
    expect(result.status).toBe('insufficient-evidence');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'posting-requirement-unsupported' }),
    );
    expect(result.reasons).not.toContainEqual(
      expect.objectContaining({
        code: 'posting-source-interpretation-missing',
      }),
    );
  });
});
