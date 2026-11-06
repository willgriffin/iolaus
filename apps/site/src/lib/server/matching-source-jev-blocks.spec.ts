import { describe, expect, it } from 'vitest';
import { matchingSourceJevBlocks as discoverBlocks } from './matching-source-jev-blocks.js';
import { matchingSourceSemanticUnits } from './matching-source-units.js';

import { matchingSourceSectionHints } from './normalized-matching.js';

const source = (description: string) => ({
  title: 'Principal Software Engineer',
  location: 'Remote within Canada',
  description,
});

function matchingSourceJevBlocks(posting: ReturnType<typeof source>) {
  return discoverBlocks(
    posting,
    matchingSourceSectionHints(posting.description),
  );
}

describe('JEV explicit multiline requirement blocks', () => {
  it('keeps the actual one-or-more capabilities and anchor on exact source units', () => {
    const posting = source(
      [
        'Qualifications:',
        'Deep expertise in one or more of:',
        '- Distributed systems',
        '- Data platforms and pipelines',
        '- AI/ML-powered extraction or classification systems',
        'Candidates must be authorized to work in Canada.',
      ].join('\n'),
    );
    const blocks = matchingSourceJevBlocks(posting);
    expect(blocks).toEqual([
      {
        anchorId: 'd2',
        unitIds: ['d2', 'd3', 'd4', 'd5'],
        kind: 'requirement',
        operator: 'any',
      },
    ]);
    const byId = new Map(
      matchingSourceSemanticUnits(posting).map((unit) => [unit.id, unit]),
    );
    expect(
      blocks[0]?.unitIds.map((id) => {
        const unit = byId.get(id);
        return posting.description.slice(unit?.start, unit?.end);
      }),
    ).toEqual([
      'Deep expertise in one or more of:',
      'Distributed systems',
      'Data platforms and pipelines',
      'AI/ML-powered extraction or classification systems',
    ]);
  });

  it('recovers flattened Staff posting bullets and leaves the next qualification independent', () => {
    const posting = source(
      [
        'Qualifications:',
        '- Deep expertise in one or more of:',
        '- Distributed systems',
        '- Data platforms and pipelines',
        '- AI/ML-powered extraction or classification systems',
        '- Platform or infrastructure engineering',
        '- Demonstrated ability to design trustworthy systems that handle failures.',
        '- Strong understanding of operational constraints.',
      ].join('\n\n'),
    );
    const [block] = matchingSourceJevBlocks(posting);
    expect(block).toEqual({
      anchorId: 'd2',
      unitIds: ['d2', 'd3', 'd4', 'd5', 'd6'],
      kind: 'requirement',
      operator: 'any',
    });
    expect(
      matchingSourceSemanticUnits(posting).find(({ id }) => id === 'd7')?.quote,
    ).toBe(
      'Demonstrated ability to design trustworthy systems that handle failures.',
    );
  });

  it('accepts a flattened required list closed by an exact new heading', () => {
    const posting = source(
      [
        'Requirements:',
        '- Experience with all of:',
        '- Distributed systems',
        '- Platform engineering',
        'Preferred qualifications:',
        '- Experience with Go',
      ].join('\n\n'),
    );
    expect(matchingSourceJevBlocks(posting)).toEqual([
      {
        anchorId: 'd2',
        unitIds: ['d2', 'd3', 'd4'],
        kind: 'requirement',
        operator: 'all',
      },
    ]);
  });

  it.each([
    '',
    '- Candidates must be authorized to work in Canada.\n\n- Strong understanding of reliability.',
    '- Go is preferred.\n\n- Strong understanding of reliability.',
    '- Go or experience with another platform.\n\n- Strong understanding of reliability.',
    '- Build reliable systems.\n\n- Strong understanding of reliability.',
    'Strong understanding of reliability.',
  ])('refuses a flattened list without a safe and explicit closing boundary: %s', (tail) => {
    expect(
      matchingSourceJevBlocks(
        source(
          [
            'Requirements:',
            '- Deep expertise in one or more of:',
            '- Distributed systems',
            '- Data platforms and pipelines',
            tail,
          ].join('\n\n'),
        ),
      ),
    ).toEqual([]);
  });

  it('reads only direct HTML siblings and preserves a new preferred heading', () => {
    const posting = source(
      [
        '<h2>Required skills</h2>',
        '<p>Experience with each of the following:</p>',
        '<ul><li>Python</li><li><strong>Go</strong></li></ul>',
        '<h2>Preferred qualifications</h2>',
        '<p>Familiarity with any one of the following:</p>',
        '<ol><li>Kafka</li><li>RabbitMQ</li></ol>',
        '<p>Additional travel is required.</p>',
      ].join(''),
    );
    expect(matchingSourceJevBlocks(posting)).toEqual([
      {
        anchorId: 'd2',
        unitIds: ['d2', 'd3', 'd4'],
        kind: 'requirement',
        operator: 'all',
      },
      {
        anchorId: 'd6',
        unitIds: ['d6', 'd7', 'd8'],
        kind: 'preferred',
        operator: 'any',
      },
    ]);
  });

  it('ends a nested block at an outdented eligibility sibling', () => {
    const posting = source(
      [
        'Requirements:',
        '- Experience with all of:',
        '  - Kafka',
        '  - RabbitMQ',
        '- Current work authorization is required.',
      ].join('\r\n'),
    );
    expect(matchingSourceJevBlocks(posting)).toEqual([
      {
        anchorId: 'd2',
        unitIds: ['d2', 'd3', 'd4'],
        kind: 'requirement',
        operator: 'all',
      },
    ]);
  });

  it('does not absorb another listed heading or a new independent list', () => {
    const posting = source(
      [
        'Requirements:',
        'Experience with any of:',
        '- Python',
        '- Go',
        '- Compensation:',
        '  - $100,000',
      ].join('\n'),
    );
    expect(matchingSourceJevBlocks(posting)[0]?.unitIds).toEqual([
      'd2',
      'd3',
      'd4',
    ]);
    expect(
      matchingSourceJevBlocks(
        source(
          [
            '<h2>Requirements</h2><p>Experience with any of:</p>',
            '<ul><li>Python</li><li>Go</li></ul><ul><li>Compensation details</li></ul>',
          ].join(''),
        ),
      )[0]?.unitIds,
    ).toEqual(['d2', 'd3', 'd4']);
  });

  it.each([
    'Experience with the following:\n- Python\n- Go',
    'Experience with any of:\nPython\nGo',
    '- Experience with any of:\n- Python\n- Go',
    'Experience with any of:\n- Python\n- Go\n- Work authorization in Canada',
    'Experience with any of:\n- Python\n- Go\n- A bachelor’s degree',
    'Experience with any of:\n- Python\n- Go preferred',
    'Experience with any of:\n- Python\n- Go\n  in a regulated domain',
    'Experience with any of:\n- Python\n- Go\n\n- Rust',
    'Experience with any of:\n- Python\n- Either Go or Rust',
    'Experience with any of:\n- Python\n- Go and at least 3 years of Rust',
    'Experience with any of:\n- Python\n- Go\n  - Rust',
    'At least 3 years of experience with any of:\n- Python\n- Go',
    'Professional experience with any of:\n- Python\n- Go',
    'Experience with exactly one of:\n- Python\n- Go',
    'Experience with both of:\n- Python\n- Go\n- Rust',
    'Preferred experience with any of:\n- Python\n- Go',
  ])('declines ambiguous or unsupported blocks: %s', (block) => {
    expect(matchingSourceJevBlocks(source(`Requirements:\n${block}`))).toEqual(
      [],
    );
  });

  it('declines an HTML item with separate source units or nested alternatives', () => {
    for (const html of [
      '<ul><li><p>Python</p><p>in a regulated domain</p></li><li>Go</li></ul>',
      '<ul><li>Python</li><li>Go<h3>Additional condition:</h3>in production</li></ul>',
      '<ul><li>Python<ul><li>Rust</li></ul></li><li>Go</li></ul>',
    ])
      expect(
        matchingSourceJevBlocks(
          source(`<h2>Requirements</h2><p>Experience with any of:</p>${html}`),
        ),
      ).toEqual([]);
  });

  it('requires the anchor itself to be governed by a relevant source heading', () => {
    expect(
      matchingSourceJevBlocks(
        source(
          [
            'Responsibilities:',
            'Experience with any of:',
            '- Python',
            '- Go',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
    expect(
      matchingSourceJevBlocks(
        source('Experience with any of:\n- Python\n- Go'),
      ),
    ).toEqual([]);
  });
});
