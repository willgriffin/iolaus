import { describe, expect, it } from 'vitest';
import {
  compensationLocationVariants,
  longPosting,
  malformedHeadingPosting,
  repeatedBoilerplatePosting,
} from './fixtures/opportunity-postings.js';
import {
  buildBoundedPreparedPostingChunks,
  conservativeTokenEstimate,
  inputTokenCeilingForModel,
  inputTokenTargetForHeadroom,
  mergeOpportunityExtractionChunks,
  OPPORTUNITY_EXTRACTION_MAX_CALLS,
  OPPORTUNITY_EXTRACTION_MAX_CHUNKS,
  OPPORTUNITY_PREPARED_POSTING_VERSION,
  type PreparedPostingChunk,
  preparedPostingFactsAsOutput,
  prepareOpportunityPosting,
} from './opportunity-posting-preparation.js';

function messages(chunk: PreparedPostingChunk) {
  return [
    { content: 'Extract a JSON object.', role: 'system' as const },
    { content: JSON.stringify(chunk), role: 'user' as const },
  ];
}

describe('opportunity posting preparation', () => {
  it('normalizes repeated boilerplate and retains section provenance', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw: repeatedBoilerplatePosting,
      postingUrl: 'https://example.com/jobs/platform',
      sourceContentFingerprint: 'content-sha',
      sourceContentVersion: 3,
      title: 'Senior Platform Engineer',
    });

    expect(prepared.version).toBe(OPPORTUNITY_PREPARED_POSTING_VERSION);
    expect(prepared.provenance).toMatchObject({
      removedBoilerplateCount: 3,
      removedDuplicateCount: 1,
      sourceContentFingerprint: 'content-sha',
      sourceContentVersion: 3,
    });
    expect(prepared.sections.map((section) => section.kind)).toEqual([
      'summary',
      'responsibilities',
      'qualifications',
      'compensation',
      'benefits',
    ]);
    expect(
      prepared.sections.every((section) => section.sourceLineStart > 0),
    ).toBe(true);
    expect(prepared.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('recognizes malformed headings and extracts obvious facts without a model', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw: malformedHeadingPosting,
      postingUrl: 'https://example.com/jobs/staff',
      title: 'Staff Software Engineer',
    });
    const facts = preparedPostingFactsAsOutput(prepared);

    expect(prepared.sections.map((section) => section.kind)).toEqual(
      expect.arrayContaining([
        'responsibilities',
        'qualifications',
        'location',
      ]),
    );
    expect(facts).toMatchObject({
      locations: 'Calgary, Alberta',
      seniority: 'staff',
      sourceUrl: 'https://example.com/jobs/staff',
      workMode: 'hybrid',
    });
  });

  it('extracts labeled posting dates without a model', () => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw:
          'Posted: July 2, 2026\nApplication deadline: 2026-07-31\nRemote role',
      }),
    );

    expect(facts.postedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(facts.expiresAt).toBe('2026-07-31T00:00:00.000Z');
  });

  it('uses location headings and preserves ambiguous seniority as unknown', () => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw:
          'Senior / Staff Software Engineer\nLocation: Remote in Canada\nLevel will be determined after interviews.',
        title: 'Senior / Staff Software Engineer',
      }),
    );

    expect(facts).toMatchObject({
      locationNotes: 'Remote in Canada',
      locations: 'Remote in Canada',
      seniority: 'unknown',
      workMode: 'remote',
    });

    const ambiguousPrepared = prepareOpportunityPosting({
      descriptionRaw:
        'Level will be determined after interviews. Build reliable systems.',
      title: 'Senior / Staff Software Engineer',
    });
    const merged = mergeOpportunityExtractionChunks(
      [
        {
          chunkIndex: 0,
          output: { seniority: 'staff' },
          sectionIds: ['section-summary-1'],
        },
      ],
      ambiguousPrepared.facts,
    );

    expect(merged.output.seniority).toBe('unknown');
    expect(
      ambiguousPrepared.facts.find((fact) => fact.field === 'seniority'),
    ).toMatchObject({
      evidence: {
        excerpt: 'Senior / Staff Software Engineer',
        sectionId: 'source-field:title',
        sourceLineEnd: 0,
        sourceLineStart: 0,
      },
      method: 'ambiguous-seniority-signals',
      value: 'unknown',
    });
    expect(merged.conflicts).toEqual([
      expect.objectContaining({
        discardedChunkIndex: 0,
        discardedValue: 'staff',
        field: 'seniority',
        selectedChunkIndex: 'deterministic',
        selectedValue: 'unknown',
      }),
    ]);
  });

  it('does not treat incidental body wording as title-level seniority ambiguity', () => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw:
          'Senior Engineer\nResponsibilities\nLead projects and mentor staff engineers.',
        title: 'Senior Engineer',
      }),
    );

    expect(facts.seniority).toBe('senior');
  });

  it.each([
    'You will lead hiring for senior/staff engineers.',
    'Collaborate with Senior & Staff engineers across multiple levels.',
    'Hiring senior/staff engineers and building the team.',
  ])('does not treat responsibility wording as a role range: %s', (line) => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: `Engineering Manager\nResponsibilities\n${line}`,
        title: 'Engineering Manager',
      }),
    );

    expect(facts.seniority).not.toBe('unknown');
  });

  it.each([
    'Senior Director of Engineering',
    'Senior Vice President, Product',
  ])('does not treat the composite title %s as an alternative level', (title) => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: 'Lead the organization and build reliable systems.',
        title,
      }),
    );

    expect(facts.seniority).not.toBe('unknown');
  });

  it.each([
    'Senior (L5) / Staff (L6) Software Engineer',
    'Senior, Staff, or Principal Software Engineer',
    'Senior & Staff Software Engineer',
    'Senior | Staff Software Engineer',
  ])('preserves the annotated title range %s as ambiguous', (title) => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: 'Level will be determined after interviews.',
        title,
      }),
    );

    expect(facts.seniority).toBe('unknown');
  });

  it('preserves an explicit body leveling range with body provenance', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw:
        'Senior Software Engineer\nRole details\nThis position may be hired at Senior or Staff level based on interviews.',
      title: 'Senior Software Engineer',
    });
    const fact = prepared.facts.find((entry) => entry.field === 'seniority');

    expect(fact).toMatchObject({
      evidence: {
        excerpt:
          'This position may be hired at Senior or Staff level based on interviews.',
        sectionId: 'section-summary-1',
        sourceLineEnd: 3,
        sourceLineStart: 3,
      },
      method: 'ambiguous-seniority-signals',
      value: 'unknown',
    });
  });

  it.each([
    'The successful candidate may be hired at Senior or Staff level.',
    'Applicants may be considered at Senior or Staff level.',
  ])('preserves candidate calibration wording: %s', (line) => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: `Senior Software Engineer\n${line}`,
        title: 'Senior Software Engineer',
      }),
    );

    expect(facts.seniority).toBe('unknown');
  });

  it('preserves a wrapped body leveling range and its complete provenance', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw:
        'Senior Software Engineer\nThis position may be hired at Senior\nor Staff level based on interviews.',
      title: 'Senior Software Engineer',
    });
    const fact = prepared.facts.find((entry) => entry.field === 'seniority');

    expect(fact).toMatchObject({
      evidence: {
        excerpt:
          'This position may be hired at Senior\nor Staff level based on interviews.',
        sectionId: 'section-summary-1',
        sourceLineEnd: 3,
        sourceLineStart: 2,
      },
      method: 'ambiguous-seniority-signals',
      value: 'unknown',
    });
  });

  it('retains original provenance after removing a boilerplate line', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw:
        'Senior Software Engineer\nApply now\nThis position may be hired at Senior or Staff level.',
      title: 'Senior Software Engineer',
    });
    const fact = prepared.facts.find((entry) => entry.field === 'seniority');

    expect(fact).toMatchObject({
      evidence: {
        excerpt: 'This position may be hired at Senior or Staff level.',
        sectionId: 'section-summary-1',
        sourceLineEnd: 3,
        sourceLineStart: 3,
      },
      method: 'ambiguous-seniority-signals',
      value: 'unknown',
    });
  });

  it('does not treat a plus-suffixed seniority rank as an alternative range', () => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: 'This role is calibrated at Staff+ level.',
        title: 'Staff+ Software Engineer',
      }),
    );

    expect(facts.seniority).toBe('staff');
  });

  it('preserves structured Date fields as deterministic ISO facts', () => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({
        descriptionRaw: 'Remote role',
        expiresAt: new Date('2026-08-31T23:59:59.000Z'),
        postedAt: new Date('2026-08-01T12:30:00.000Z'),
      }),
    );

    expect(facts.postedAt).toBe('2026-08-01T12:30:00.000Z');
    expect(facts.expiresAt).toBe('2026-08-31T23:59:59.000Z');
  });

  it('replaces invalid numeric entities without crashing preparation', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw:
        'Responsibilities\nHandle &#999999999999999999999999; and &#x110000; safely with &#x1F680; launches.',
    });
    const text = prepared.sections.map((section) => section.text).join('\n');

    expect(text).toContain('\uFFFD');
    expect(text).toContain('🚀');
  });

  it.each(
    compensationLocationVariants,
  )('extracts compensation and location variants from fixture text', ({
    expected,
    text,
  }) => {
    const facts = preparedPostingFactsAsOutput(
      prepareOpportunityPosting({ descriptionRaw: text }),
    );
    expect(facts).toMatchObject(expected);
  });

  it('compacts long postings below every model-aware hard input ceiling', async () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw: longPosting(),
      sourceContentFingerprint: 'long-content',
      sourceContentVersion: 9,
    });
    const chunks = await buildBoundedPreparedPostingChunks({
      buildMessages: messages,
      counter: async (text) => conservativeTokenEstimate(text, 'zai/glm-4.7'),
      inputTokenCeiling: 1_200,
      model: 'zai/glm-4.7-flashx',
      prepared,
    });

    expect(chunks.length).toBeLessThanOrEqual(
      OPPORTUNITY_EXTRACTION_MAX_CHUNKS,
    );
    expect(OPPORTUNITY_EXTRACTION_MAX_CALLS).toBe(
      OPPORTUNITY_EXTRACTION_MAX_CHUNKS,
    );
    expect(chunks.every((chunk) => chunk.inputTokenCount <= 960)).toBe(true);
    expect(chunks.every((chunk) => chunk.inputTokenCeiling === 1_200)).toBe(
      true,
    );
    expect(inputTokenCeilingForModel('snail/gemma4', 50_000)).toBe(6_000);
    expect(inputTokenTargetForHeadroom(6_000, 0.2)).toBe(4_800);
    expect(inputTokenTargetForHeadroom(6_000, Number.NaN)).toBe(4_800);
  });

  it('merges list fields and scalar conflicts deterministically with attribution', () => {
    const prepared = prepareOpportunityPosting({
      descriptionRaw: 'Location: Remote\nQualifications\nTypeScript',
      workMode: 'remote',
    });
    const merged = mergeOpportunityExtractionChunks(
      [
        {
          chunkIndex: 1,
          output: { requiredSkills: ['PostgreSQL'], seniority: 'principal' },
          sectionIds: ['section-qualifications-2'],
        },
        {
          chunkIndex: 0,
          output: {
            requiredSkills: ['TypeScript', 'PostgreSQL'],
            seniority: 'staff',
            workMode: 'hybrid',
          },
          sectionIds: ['section-summary-1'],
        },
      ],
      prepared.facts,
    );

    expect(merged.output).toMatchObject({
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      seniority: 'staff',
      workMode: 'remote',
    });
    expect(merged.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          discardedChunkIndex: 0,
          field: 'workMode',
          selectedChunkIndex: 'deterministic',
        }),
        expect.objectContaining({
          discardedChunkIndex: 1,
          field: 'seniority',
          selectedChunkIndex: 0,
        }),
      ]),
    );
    expect(merged.fieldProvenance.workMode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chunkIndex: 'deterministic' }),
        expect.objectContaining({ chunkIndex: 0 }),
      ]),
    );
  });
});
