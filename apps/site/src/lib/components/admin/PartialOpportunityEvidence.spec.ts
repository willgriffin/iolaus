import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PartialOpportunityEvidence from './PartialOpportunityEvidence.svelte';

const projection = {
  version: 'opportunity-assessment-partial-projection/v1',
  mode: 'partial',
  sourceStatus: 'current',
  criterionCount: 1,
  supportedCriterionCount: 1,
  unresolvedSourceClauseCount: 2,
  requirements: [
    {
      id: 'criterion',
      text: 'Maintain tested API integrations.',
      support: 'supported',
      postingCitations: [
        {
          excerpt: 'You must maintain tested API integrations.',
          clauseId: 'clause-1',
          start: 10,
          end: 51,
        },
      ],
      candidateCitations: [
        {
          sourceId: 'employment:1',
          title: 'Platform engineer',
          excerpt: 'Maintained tested API integrations.',
          recordId: 'job-1',
          sectionId: 'duties',
        },
      ],
    },
  ],
};
describe('PartialOpportunityEvidence', () => {
  it('renders literal citations and unresolved source count without making an overall fit claim', () => {
    const { body } = render(PartialOpportunityEvidence, {
      props: { projection },
    });
    expect(body).toContain('1 supported criterion of 1 assessed');
    expect(body).toContain('2 unresolved source clauses');
    expect(body).toContain('No overall fit conclusion.');
    expect(body).toContain('You must maintain tested API integrations.');
    expect(body).toContain('characters 10–51');
    expect(body).toContain('Maintained tested API integrations.');
    expect(body).toContain('Record job-1');
    expect(body).toContain('Section duties');
    expect(body).not.toMatch(
      /fitScore|\/100|fit percentage|Strong match|Eligibility: Eligible|\bstars\b/,
    );
  });
  it('keeps uncertain support distinct from a candidate gap and escapes captured text', () => {
    const value = {
      ...projection,
      supportedCriterionCount: 0,
      requirements: [
        {
          ...projection.requirements[0],
          support: 'uncertain',
          text: '<script>alert(1)</script>',
          candidateCitations: [],
        },
      ],
    };
    const { body } = render(PartialOpportunityEvidence, {
      props: { projection: value },
    });
    expect(body).toContain('Candidate support remains uncertain.');
    expect(body).not.toContain('Candidate evidence supports this criterion.');
    expect(body).not.toContain('<script>alert');
    expect(body).not.toContain('Confirmed gap');
  });
  it.each([
    undefined,
    { ...projection, sourceStatus: 'stale' },
    { ...projection, mode: 'full' },
    { ...projection, criterionCount: 0 },
  ])('does not display unavailable or invalid current partial data', (value) => {
    const { body } = render(PartialOpportunityEvidence, {
      props: { projection: value },
    });
    expect(body).not.toContain('Partial evidence');
    expect(body).not.toContain('Maintain tested');
  });
  it('keeps list citations behind an accessible compact details control', () => {
    const { body } = render(PartialOpportunityEvidence, {
      props: { projection, compact: true },
    });
    expect(body).toMatch(
      /<summary[^>]*>Criteria and exact citations<\/summary>/,
    );
    expect(body).not.toMatch(/<details[^>]*\bopen\b/);
  });
});
