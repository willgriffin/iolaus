import { describe, expect, it } from 'vitest';
import {
  matchingSourceStructureMatches,
  matchingSourceStructures,
} from './matching-source-jev-structure.js';

const noQualifier = { years: null, context: null };

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
