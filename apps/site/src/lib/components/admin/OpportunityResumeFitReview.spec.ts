import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OpportunityResumeFitReview from './OpportunityResumeFitReview.svelte';

const projection = {
  version: 'opportunity-resume-fit-review-projection/v1',
  mode: 'advisory',
  sourceStatus: 'current',
  model: 'openai/gpt-6.1-sol',
  coverage: {
    candidateSourceCount: 150,
    reviewedRequirementIds: ['r1', 'r2'],
    unresolvedClauseIds: ['c3'],
    sourceComplete: false,
    fullFit: 'unknown',
  },
  requirements: [
    {
      id: 'r1',
      text: 'Build APIs',
      status: 'strength',
      seniority: 'supported',
      note: 'Led delivery of the cited API.',
      postingCitations: [
        { clauseId: 'c1', start: 3, end: 13, quote: 'Build APIs' },
      ],
      candidateCitations: [
        {
          sourceId: 'job1',
          title: 'Platform engineer',
          kind: 'employment',
          start: 2,
          end: 11,
          quote: 'Led APIs.',
        },
      ],
    },
    {
      id: 'r2',
      text: 'Lead managers',
      status: 'uncertain',
      seniority: 'uncertain',
      note: 'People management depth is unclear.',
      postingCitations: [],
      candidateCitations: [],
    },
  ],
};
describe('OpportunityResumeFitReview', () => {
  it('labels the attested Luna and Sol models without changing the advisory qualifier', () => {
    for (const [model, label] of [
      ['openai/gpt-6-luna', 'Luna'],
      ['openai/gpt-6.1-sol', 'Sol'],
    ]) {
      const { body } = render(OpportunityResumeFitReview, {
        props: { projection: { ...projection, model } },
      });
      expect(body).toContain(`Model: ${label} (${model})`);
      expect(body).toContain('Overall fit remains unknown.');
    }
    expect(
      render(OpportunityResumeFitReview, {
        props: { projection: { ...projection, model: 'claimed-model' } },
      }).body,
    ).not.toContain('Resume review');
  });
  it('renders advisory strengths, uncertain seniority, exact quotes and coverage without a fit or eligibility conclusion', () => {
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection },
    });
    expect(body).toContain('Resume review · 1 strength · 1 uncertain');
    expect(body).toContain('using 150 candidate sources');
    expect(body).toContain('Overall fit remains unknown.');
    expect(body).toContain('1 unresolved source clause');
    expect(body).toContain('Seniority evidence is supported.');
    expect(body).toContain('Seniority remains uncertain.');
    expect(body).toContain('Led APIs.');
    expect(body).toContain('characters 2–11');
    expect(body).not.toMatch(
      /fitScore|\/100|Strong match|Eligibility:|\bstars\b|Confirmed gap/,
    );
  });
  it('escapes private quotes and keeps uncertain support separate from a confirmed gap', () => {
    const quote = '<script>alert(1)</script>';
    const value = structuredClone(projection);
    value.requirements[0].candidateCitations[0] = {
      ...value.requirements[0].candidateCitations[0],
      quote,
      start: 0,
      end: quote.length,
    };
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: value },
    });
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script>');
    expect(body).toContain('Candidate support remains uncertain.');
  });
  it('uses a collapsed accessible citation control in compact lists', () => {
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection, compact: true },
    });
    expect(body).toMatch(
      /<summary[^>]*>Strengths, uncertainty and seniority citations<\/summary>/,
    );
    expect(body).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it.each([
    null,
    { ...projection, sourceStatus: 'stale' },
    { ...projection, mode: 'full' },
    { ...projection, coverage: { ...projection.coverage, fullFit: 'known' } },
    {
      ...projection,
      coverage: { ...projection.coverage, sourceComplete: true },
    },
    {
      ...projection,
      coverage: { ...projection.coverage, reviewedRequirementIds: ['other'] },
    },
    {
      ...projection,
      requirements: [{ ...projection.requirements[0], candidateCitations: [] }],
    },
  ])('omits stale, unavailable or inconsistent payloads without extra empty-state clutter', (value) => {
    expect(
      render(OpportunityResumeFitReview, { props: { projection: value } }).body,
    ).not.toContain('Resume review');
  });
  it('labels complete source coverage independently from overall fit', () => {
    const { body } = render(OpportunityResumeFitReview, {
      props: {
        projection: {
          ...projection,
          coverage: {
            ...projection.coverage,
            unresolvedClauseIds: [],
            sourceComplete: true,
          },
        },
      },
    });
    expect(body).toContain(
      'Captured source coverage is complete for this review.',
    );
    expect(body).toContain('Overall fit remains unknown.');
  });
});
