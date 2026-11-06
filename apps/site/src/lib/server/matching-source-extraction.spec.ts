import { describe, expect, it } from 'vitest';
import { parseMatchingSourceExtraction } from './matching-source-extraction-contract.js';

const field = (
  quote: string,
  field: 'title' | 'description' | 'location' = 'description',
) => ({ field, quote });
const capability = (
  quote: string,
  years: number | null = null,
  context: 'professional' | 'production' | null = null,
) => ({ capability: field(quote), years, context });
const requirement = (
  quote: string,
  ...alternatives: ReturnType<typeof capability>[]
) => ({ clause: field(quote), alternatives });
const source = {
  title: 'Backend Engineer',
  location: 'Remote (Canada)',
  description:
    '🛠️ 3 years of production experience with Node.js. Required: PostgreSQL or SQLite. Kubernetes is preferred.',
};
const good = {
  coverage: 'complete',
  role: field(source.title, 'title'),
  geography: field(source.location, 'location'),
  noRequirements: null,
  required: [
    requirement(
      '3 years of production experience with Node.js',
      capability('Node.js', 3, 'production'),
    ),
    requirement(
      'Required: PostgreSQL or SQLite',
      capability('PostgreSQL'),
      capability('SQLite'),
    ),
  ],
  preferred: [requirement('Kubernetes is preferred', capability('Kubernetes'))],
  unresolved: [],
};

describe('matching source extraction validation', () => {
  it('retains AND-of-OR groups and computes exact UTF-16 offsets that can be revalidated', () => {
    const extraction = parseMatchingSourceExtraction(good, source);
    expect(extraction.required[0]?.clause.start).toBe(
      source.description.indexOf('3 years'),
    );
    expect(
      extraction.required[1]?.alternatives.map((atom) => atom.capability.quote),
    ).toEqual(['PostgreSQL', 'SQLite']);
    expect(parseMatchingSourceExtraction(extraction, source)).toEqual(
      extraction,
    );
  });

  it('rejects unsupported evidence or arbitrary nested fields', () => {
    expect(() =>
      parseMatchingSourceExtraction(
        { ...good, geography: field('Remote (US)', 'location') },
        source,
      ),
    ).toThrow(/citation/);
    expect(() =>
      parseMatchingSourceExtraction({ ...good, candidate: 'private' }, source),
    ).toThrow();
    expect(() =>
      parseMatchingSourceExtraction(
        { ...good, role: { ...good.role, start: 1 } },
        source,
      ),
    ).toThrow(/citation/);
  });

  it('rejects dropped alternatives, weakened conjunctions, and fabricated durations', () => {
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...good,
          required: [
            requirement(
              'Required: PostgreSQL or SQLite',
              capability('PostgreSQL'),
            ),
          ],
        },
        source,
      ),
    ).toThrow(/logic/);
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...good,
          required: [
            requirement(
              'Required: PostgreSQL and SQLite',
              capability('PostgreSQL'),
            ),
          ],
        },
        { ...source, description: 'Required: PostgreSQL and SQLite' },
      ),
    ).toThrow(/logic/);
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...good,
          required: [
            requirement(
              '3 years of production experience with Node.js',
              capability('Node.js', 1, 'production'),
            ),
          ],
        },
        source,
      ),
    ).toThrow(/qualification/);
  });

  it('retains partial unresolved evidence and requires a quote for explicit absence', () => {
    const description = 'Work authorization is required.';
    const partial = {
      ...good,
      coverage: 'partial',
      required: [],
      preferred: [],
      unresolved: [field(description)],
    };
    expect(
      parseMatchingSourceExtraction(partial, { ...source, description })
        .unresolved[0]?.quote,
    ).toBe(description);
    expect(() =>
      parseMatchingSourceExtraction(
        { ...partial, coverage: 'complete' },
        { ...source, description },
      ),
    ).toThrow(/coverage/);
    expect(() =>
      parseMatchingSourceExtraction(
        { ...good, required: [], preferred: [] },
        source,
      ),
    ).toThrow(/coverage/);
    const explicit = 'No mandatory qualifications.';
    expect(
      parseMatchingSourceExtraction(
        {
          ...good,
          required: [],
          preferred: [],
          noRequirements: field(explicit),
        },
        { ...source, description: explicit },
      ).noRequirements?.quote,
    ).toBe(explicit);
  });
  it('accepts Oxford-comma alternatives without allowing omitted disjuncts', () => {
    const clause = 'Required: Java, PostgreSQL, or SQLite';
    const posting = { ...source, description: clause };
    expect(
      parseMatchingSourceExtraction(
        {
          ...good,
          preferred: [],
          required: [
            requirement(
              clause,
              capability('Java'),
              capability('PostgreSQL'),
              capability('SQLite'),
            ),
          ],
        },
        posting,
      ).required[0]?.alternatives,
    ).toHaveLength(3);
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...good,
          preferred: [],
          required: [
            requirement(clause, capability('Java'), capability('SQLite')),
          ],
        },
        posting,
      ),
    ).toThrow(/logic/);
  });

  it('accepts independently safe whole duties lines and exact typed metadata', () => {
    const duties = 'You will build and maintain backend services.';
    const description = `<p>${duties}</p><p>No mandatory qualifications.</p>`;
    const interpretation = {
      ...good,
      roleTitle: 'Backend Engineer',
      workplaceType: 'remote',
      workLocation: 'Canada',
      required: [],
      preferred: [],
      noRequirements: field('No mandatory qualifications.'),
      nonRequirements: [field(duties)],
    };
    expect(
      parseMatchingSourceExtraction(interpretation, { ...source, description }),
    ).toMatchObject({
      roleTitle: 'Backend Engineer',
      workplaceType: 'remote',
      workLocation: 'Canada',
      nonRequirements: [{ quote: duties }],
    });
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...interpretation,
          nonRequirements: [field('You will build and maintain')],
        },
        { ...source, description },
      ),
    ).toThrow(/coverage/);
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...interpretation,
          workplaceType: 'hybrid',
        },
        { ...source, description },
      ),
    ).toThrow(/citation/);
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...interpretation,
          workLocation: 'United States',
        },
        { ...source, description },
      ),
    ).toThrow(/citation/);

    const hard = 'You will need a valid work permit.';
    expect(() =>
      parseMatchingSourceExtraction(
        {
          ...interpretation,
          nonRequirements: [field(hard)],
        },
        { ...source, description: description.replace(duties, hard) },
      ),
    ).toThrow(/coverage/);
  });
  it('repairs a unique quote offset only for provider output and salvages independent evidence', () => {
    const diagnostics: string[] = [];
    const malformed = {
      ...good,
      role: { ...good.role, start: 5 },
      geography: field('unquoted location', 'location'),
      required: [
        good.required[0],
        requirement('Required: PostgreSQL or SQLite', capability('PostgreSQL')),
      ],
    };
    const repaired = parseMatchingSourceExtraction(malformed, source, {
      repairProviderOutput: true,
      onDiagnostic: (code) => diagnostics.push(code),
    });
    expect(repaired).toMatchObject({
      role: { quote: source.title, start: 0 },
      geography: null,
      coverage: 'partial',
    });
    expect(repaired.required).toHaveLength(1);
    expect(repaired.unresolved[0]?.quote).toBe(
      'Required: PostgreSQL or SQLite',
    );
    expect(diagnostics).toEqual([
      'matching_extraction_logic',
      'matching_extraction_citation',
    ]);
    expect(parseMatchingSourceExtraction(repaired, source)).toEqual(repaired);
    expect(() =>
      parseMatchingSourceExtraction({ ...good, role: malformed.role }, source),
    ).toThrow(/citation/);
  });

  it('rejects structural shape errors with a safe stable code', () => {
    expect(() =>
      parseMatchingSourceExtraction(['arbitrary untrusted payload'], source, {
        repairProviderOutput: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'matching_extraction_schema' }));
  });
  it('preserves valid groups when provider fields are absent or malformed', () => {
    const schemaIssues: unknown[] = [];
    const interpreted = parseMatchingSourceExtraction(
      {
        required: [
          requirement(
            '3 years of production experience with Node.js',
            capability('Node.js', 3, 'production'),
          ),
          {
            clause: field('Required: PostgreSQL or SQLite'),
            alternatives: 'untrusted value',
          },
        ],
        arbitraryUnknownKey: 'untrusted value',
      },
      source,
      {
        repairProviderOutput: true,
        onSchemaDiagnostic: (issue) => schemaIssues.push(issue),
      },
    );
    expect(interpreted).toMatchObject({
      coverage: 'partial',
      role: null,
      geography: null,
      preferred: [],
      unresolved: [{ quote: 'Required: PostgreSQL or SQLite' }],
    });
    expect(interpreted.required).toHaveLength(1);
    expect(schemaIssues).toEqual([
      { field: 'response', issue: 'unrecognized_keys' },
      { field: 'coverage', issue: 'invalid_value' },
      { field: 'required', issue: 'invalid_type' },
      { field: 'unresolved', issue: 'invalid_type' },
    ]);
    expect(JSON.stringify(schemaIssues)).not.toContain('untrusted');
    expect(parseMatchingSourceExtraction(interpreted, source)).toEqual(
      interpreted,
    );
  });
});
