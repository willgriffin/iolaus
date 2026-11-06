import { describe, expect, it } from 'vitest';
import {
  matchingSourceStructureMatches,
  matchingSourceStructures,
} from './matching-source-jev-structure.js';

const noQualifier = { years: null, context: null };

it('does not convert typical tenure to a minimum', () => {
  expect(
    matchingSourceStructures(
      'Significant software engineering experience, typically 8+ years',
    ),
  ).toEqual([]);
  expect(
    matchingSourceStructures(
      'At least 8 years of professional experience with TypeScript',
    )[0]?.groups[0]?.[0]?.years,
  ).toBe(8);
});

describe('JEV host source structure grammar', () => {
  it('offers whole, ALL, ANY on ordinary commas and keeps every fragment exact', () => {
    const quote =
      'Required skills: Experience with Node.js, Python, PostgreSQL.';
    const options = matchingSourceStructures(quote);
    expect(
      options.map(({ key, groups }) => [
        key,
        groups.map((parts) => parts.map(({ text }) => text)),
      ]),
    ).toEqual([
      ['whole', [['Experience with Node.js, Python, PostgreSQL']]],
      ['list-all', [['Node.js'], ['Python'], ['PostgreSQL']]],
      ['list-any', [['Node.js', 'Python', 'PostgreSQL']]],
    ]);
    for (const { groups } of options)
      for (const { start, end, text } of groups.flat())
        expect(quote.slice(start, end)).toBe(text);
    const all = Array.from({ length: 3 }, () => ({
      alternatives: [noQualifier],
    }));
    expect(matchingSourceStructureMatches(quote, 'list-all', all)).toBe(true);
    expect(matchingSourceStructureMatches(quote, 'list-any', all)).toBe(false);
  });

  it('supports AND of explicit parenthesized OR and final Oxford OR', () => {
    for (const [quote, expected] of [
      [
        'Experience with (Node.js or Python) and TypeScript.',
        [['Node.js', 'Python'], ['TypeScript']],
      ],
      [
        'TypeScript, Python, or Node.js.',
        [['TypeScript', 'Python', 'Node.js']],
      ],
    ] as const) {
      const structures = matchingSourceStructures(quote);
      expect(structures).toHaveLength(1);
      expect(
        structures[0]?.groups.map((parts) => parts.map(({ text }) => text)),
      ).toEqual(expected);
    }
  });

  it('keeps one inherited-depth OR and preserves all five exact alternatives', () => {
    const prefix = 'Deep expertise in one or more of: ';
    const quote = `${prefix}distributed systems, data pipelines, reference data platforms, platform engineering, or AI-powered classification and validation.`;
    const options = matchingSourceStructures(quote);
    expect(options).toHaveLength(1);
    const variant = options[0];
    expect(variant).toMatchObject({
      key: 'inline-depth-any',
      scope: {
        kind: 'deep-expertise',
        start: 0,
        end: prefix.length,
        text: prefix,
      },
    });
    const parts = variant?.groups[0] ?? [];
    expect(parts.map(({ text }) => text)).toEqual([
      'distributed systems',
      'data pipelines',
      'reference data platforms',
      'platform engineering',
      'AI-powered classification and validation',
    ]);
    expect(
      parts.every(
        ({ start, end, text, unsupported }) =>
          !unsupported && quote.slice(start, end) === text,
      ),
    ).toBe(true);
    const alternatives = parts.map(() => noQualifier);
    expect(
      matchingSourceStructureMatches(quote, 'inline-depth-any', [
        { alternatives },
      ]),
    ).toBe(true);
    expect(
      matchingSourceStructureMatches(
        quote,
        'inline-depth-any',
        alternatives.map((part) => ({ alternatives: [part] })),
      ),
    ).toBe(false);
    expect(
      matchingSourceStructureMatches(quote, 'explicit', [{ alternatives }]),
    ).toBe(false);
  });

  it('inherits familiarity over two conjuncts and keeps only the first examples illustrative', () => {
    const prefix = 'Posses familiarity with ';
    const quote = `${prefix}observability tools (OpenTelemetry, Prometheus, Grafana) and performance tuning.`;
    const options = matchingSourceStructures(quote);
    expect(options).toHaveLength(1);
    const variant = options[0];
    expect(variant).toMatchObject({
      key: 'familiarity-all',
      scope: {
        kind: 'familiarity',
        start: 0,
        end: prefix.length,
        text: prefix,
      },
      groups: [
        [
          {
            text: 'observability tools',
            examples: ['OpenTelemetry', 'Prometheus', 'Grafana'],
            unsupported: false,
          },
        ],
        [{ text: 'performance tuning', unsupported: false }],
      ],
    });
    expect(variant?.groups[1]?.[0]?.examples).toBeUndefined();
    const spans = variant?.groups
      .flat()
      .map(({ start, end }) => quote.slice(start, end));
    expect(spans).toEqual([
      'observability tools (OpenTelemetry, Prometheus, Grafana)',
      'performance tuning',
    ]);
    expect(
      matchingSourceStructureMatches(quote, 'familiarity-all', [
        { alternatives: [noQualifier] },
        { alternatives: [noQualifier] },
      ]),
    ).toBe(true);
    expect(
      matchingSourceStructureMatches(quote, 'familiarity-all', [
        { alternatives: [noQualifier, noQualifier] },
      ]),
    ).toBe(false);
  });

  it('leaves an ordinary parenthetical alias on the existing grammar', () => {
    const options = matchingSourceStructures(
      'Familiarity with Amazon Web Services (AWS) and Terraform.',
    );
    expect(options[0]?.key).toBe('explicit');
    expect(options[0]?.scope).toBeUndefined();
  });

  it.each([
    'Deep expertise in one or more of: distributed systems, data pipelines, or',
    'Deep expertise in one or more of distributed systems, data pipelines, or Go',
    'Deep expertise in one or more of: distributed systems, or data pipelines, and a visa',
    'Deep expertise in one or more of: distributed systems, Python and Go',
    'Deep expertise in one or more of: distributed systems and Python, or Go',
    'Deep expertise in one or more of: distributed systems, data pipelines, or right to work in Canada',
    'Deep expertise in one or more of: distributed systems, or Python preferred, and Go required',
    'Posses familiarity with observability tools (OpenTelemetry or Prometheus) and performance tuning',
    'Posses familiarity with observability tools (OpenTelemetry, Prometheus) and work authorization in Canada',
    'Posses familiarity with observability tools (OpenTelemetry, Prometheus) and performance tuning or SQL',
    'Posses familiarity with observability tools (OpenTelemetry, Prometheus) and',
    'Posses familiarity with observability tools (OpenTelemetry, Prometheus required) and performance tuning preferred',
  ])('declines incomplete, mixed, nested, or ineligible scoped clauses: %s', (quote) => {
    expect(matchingSourceStructures(quote)).toEqual([]);
  });

  it('binds distinct or explicitly shared tenure without inventing qualifiers', () => {
    const separate =
      '2 years of professional experience with Node.js and 3 years of production experience with Python.';
    expect(
      matchingSourceStructureMatches(separate, 'explicit', [
        { alternatives: [{ years: 2, context: 'professional' }] },
        { alternatives: [{ years: 3, context: 'production' }] },
      ]),
    ).toBe(true);
    const shared =
      '3+ years of production experience with either Node.js or Python.';
    expect(
      matchingSourceStructureMatches(shared, 'explicit', [
        {
          alternatives: [
            { years: 3, context: 'production' },
            { years: 3, context: 'production' },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      matchingSourceStructureMatches(shared, 'explicit', [
        { alternatives: [{ years: 3, context: 'production' }, noQualifier] },
      ]),
    ).toBe(false);
  });

  it('leaves ambiguous Boolean or strength combinations and unmodeled scope unresolved', () => {
    for (const quote of [
      'Node.js or Python and TypeScript.',
      'Node.js is required and Python is preferred.',
      'You must have Node.js and Python preferred.',
      '(Node.js and Python) or TypeScript.',
    ])
      expect(matchingSourceStructures(quote)).toEqual([]);
    const residual = 'Experience with Node.js, including work authorization.';
    const variant = matchingSourceStructures(residual).find(
      ({ key }) => key === 'list-all',
    );
    expect(variant?.groups[1]?.[0]).toMatchObject({
      text: 'including work authorization',
      unsupported: true,
    });
    expect(
      matchingSourceStructureMatches(residual, 'list-all', [
        { alternatives: [noQualifier] },
        { alternatives: [noQualifier] },
      ]),
    ).toBe(false);
  });
});
