import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { completeReviewFixture } from '$lib/opportunity-resume-fit-review-projection.test-support';
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
const completeFit = {
  kind: 'evidence_summary',
  supportedCriterionCount: 1,
  uncertainCriterionCount: 0,
  sourceUnknownCriterionCount: 0,
  sourceClassificationUnknownCount: 1,
  contextUnitCount: 1,
  consideredCriterionCount: 1,
  supportLowerBound: 1,
  status: 'supported_with_uncertainties',
};
const completeProjection = {
  ...projection,
  model: 'openai/gpt-6-luna',
  mode: 'complete_material',
  resultContractVersion: 'opportunity-resume-fit-review/v4-complete-material',
  evidenceFit: completeFit,
  completion: {
    status: 'reviewed_with_unknowns',
    consideredComplete: true,
    catalogClauseCount: 3,
    reviewedMaterialClauseCount: 2,
    possibleRequirementCount: 1,
    unprocessedClauseIds: [],
  },
  coverage: {
    ...projection.coverage,
    fullFit: completeFit,
    sourceComplete: true,
    consideredComplete: true,
    requirementsCertainty: 'uncertain',
    metadataConsideration: [],
    unresolvedClauseIds: ['c2'],
    reviewedMaterialClauseIds: ['c1', 'c2'],
    sourceClauseConsideration: [
      { clauseId: 'heading', status: 'certified_nonrequirement' },
      { clauseId: 'c1', status: 'confirmed_requirement' },
      { clauseId: 'c2', status: 'possible_requirement_unknown' },
    ],
  },
  requirements: [
    {
      ...projection.requirements[0],
      originalRequirementIds: ['original-r1'],
      sourceClassification: 'confirmed_requirement',
      sourceDisposition: 'criterion',
      candidateCitations: projection.requirements[0].candidateCitations.map(
        (cite) => ({
          ...cite,
          citationMode: 'whole_fact',
          start: 0,
          end: cite.quote.length,
        }),
      ),
      postingCitations: projection.requirements[0].postingCitations.map(
        (cite) => ({ ...cite, citationMode: 'whole_clause' }),
      ),
    },
    {
      ...projection.requirements[1],
      originalRequirementIds: [],
      sourceClassification: 'possible_requirement_unknown',
      sourceDisposition: 'context',
      postingCitations: [
        {
          clauseId: 'c2',
          start: 15,
          end: 28,
          quote: 'Lead managers',
          citationMode: 'whole_clause',
        },
      ],
    },
  ],
};
describe('OpportunityResumeFitReview', () => {
  it('labels continuous relevance as supplied-evidence advisory and keeps original Sol suggestions accessible with guarded uncertainty', () => {
    const fixture = completeReviewFixture({ uncertain: true });
    const review = {
      ...fixture,
      model: 'openai/gpt-6.1-sol',
      verification: {
        sourceStatus: 'current',
        version:
          'opportunity-review-strength-verification/v2-partial-relevance',
        model: 'jev-1.13.0',
        strengthClaimCount: 1,
        verifiedStrengthCount: 0,
        seniorityClaimCount: 1,
        verifiedSeniorityCount: 0,
        partialClaimCount: 1,
        verifiedPartialCount: 0,
        partialSupportedRequirementIds: [],
      },
      advisoryRelevance: {
        kind: 'supplied_evidence_relevance',
        denominator: 1,
        weightedMean: 0.42,
        criterionProbabilityPairs: [
          {
            requirementId: 'material:c1',
            probability: 0.42,
            evidenceStatus: 'cited',
          },
        ],
      },
      requirements: [
        {
          ...fixture.requirements[0],
          candidateCitations:
            completeReviewFixture().requirements[0]?.candidateCitations,
          originalSolSuggestion: {
            status: 'strength',
            seniority: 'supported',
            note: 'Original model suggested relevant API work.',
          },
        },
      ],
    };
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: review },
    });
    expect(body).toContain('Advisory relevance</p>');
    expect(body).toContain('Supplied-evidence relevance mean: 0.420 (0–1)');
    expect(body).toMatch(
      /Guarded criteria counts and source uncertainty<\/summary>(?:(?!<\/details>)[\s\S])*0 high-confidence partial confirmations/,
    );
    expect(body).not.toContain('criteria with partial evidence of');
    expect(body).toContain('not candidate ability or overall fit');
    expect(body).toContain('Candidate support remains uncertain.');
    expect(body).toContain('Original Sol model suggestion: strength');
    expect(body).toContain('Original model suggested relevant API work.');
    expect(body).toContain('Led APIs.');
    expect(body).toContain('0 of 1 strength claims established');
    expect(body).not.toContain(
      'Partial evidence found; full criterion unverified.',
    );
    expect(body).not.toContain('42%');
  });

  it('renders native partial evidence as the human label and discloses that the full criterion is unverified', () => {
    const fixture = completeReviewFixture({ uncertain: true });
    const partial = {
      ...fixture,
      model: 'openai/gpt-6.1-sol',
      verification: {
        sourceStatus: 'current',
        version:
          'opportunity-review-strength-verification/v2-partial-relevance',
        model: 'jev-1.13.0',
        strengthClaimCount: 1,
        verifiedStrengthCount: 0,
        seniorityClaimCount: 1,
        verifiedSeniorityCount: 0,
        partialClaimCount: 1,
        verifiedPartialCount: 1,
        partialSupportedRequirementIds: ['material:c1'],
      },
      requirements: [
        {
          ...fixture.requirements[0],
          candidateCitations:
            completeReviewFixture().requirements[0]?.candidateCitations,
        },
      ],
    };
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: partial },
    });
    expect(body).toContain('Partial evidence</p>');
    expect(body).toContain(
      '1 high-confidence partial confirmations across 1 considered criteria',
    );
    expect(body).toContain(
      'Partial evidence found; full criterion unverified.',
    );
    expect(body).toContain('0 of 1 strength claims established');
    expect(body).toContain('0 of 1 tenure/seniority claims established');
    expect(body).toContain('1 partial evidence checks (jev-1.13.0)');
    expect(body).toContain('Led APIs.');
    expect(body).toContain('Model: Sol');
    expect(body).not.toContain('skill gap');
    expect(body).not.toContain('All reviewed criteria supported');
  });

  it('labels actual Sol plus scoped JEV claim verification without asserting full-fit or eligibility certification', () => {
    const verified = {
      ...completeProjection,
      model: 'openai/gpt-6.1-sol',
      verification: {
        sourceStatus: 'current',
        version: 'opportunity-review-strength-verification/v1-independent-jev',
        model: 'jev-1.13.0',
        strengthClaimCount: 1,
        verifiedStrengthCount: 1,
        seniorityClaimCount: 1,
        verifiedSeniorityCount: 1,
      },
    };
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: verified },
    });
    expect(body).toContain('Model: Sol (openai/gpt-6.1-sol)');
    expect(body).toContain(
      'JEV claim verification · 2 asserted claims (jev-1.13.0)',
    );
    expect(body).toContain('1 of 1 strength claims established');
    expect(body).toContain('1 of 1 tenure/seniority claims established');
    expect(body).toContain(
      'Verification covers these cited claims. Eligibility is shown separately.',
    );
    expect(body).toContain('Supported with uncertainties');
    expect(body).not.toContain('certified');
    expect(body).not.toContain('fitScore');
  });

  it('distinguishes complete consideration from known fit and excludes context from criteria counts', () => {
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: completeProjection },
    });
    expect(body).toContain('Supported with uncertainties');
    expect(body).toContain(
      'All 3 captured material units considered; 2 material units reviewed.',
    );
    expect(body).toContain('Full candidate catalog supplied: 150 sources.');
    expect(body).toContain('1 source classifications remain uncertain.');
    expect(body).toContain('Context clause; excluded from criteria counts.');
    expect(body).toContain('whole candidate fact');
    expect(body).toContain('whole source clause');
    expect(body).toContain(
      'Complete material review. Eligibility is shown separately.',
    );
    expect(body).not.toContain('Advisory review of');
    expect(body).not.toMatch(
      /fitScore|\/100|Strong match|Eligibility:|\bstars\b/,
    );
  });
  it('distinguishes a whole immutable ATS field citation from body offsets and legal eligibility', () => {
    const field = 'source-field:locationNotes';
    const value = {
      ...completeProjection,
      coverage: {
        ...completeProjection.coverage,
        unresolvedClauseIds: [field],
        reviewedMaterialClauseIds: ['c1', field],
        sourceClauseConsideration:
          completeProjection.coverage.sourceClauseConsideration.filter(
            (row) => row.clauseId !== 'c2',
          ),
        metadataConsideration: [
          {
            fieldId: field,
            path: 'sourceContentJson.locationNotes',
            hash: 'field-hash',
            bodyClauseIds: [],
            status: 'possible_requirement_unknown',
          },
        ],
      },
      requirements: [
        completeProjection.requirements[0],
        {
          ...completeProjection.requirements[1],
          postingCitations: [
            {
              clauseId: field,
              start: 0,
              end: 13,
              quote: 'Remote Canada',
              citationMode: 'whole_field',
              sourceFieldPath: 'sourceContentJson.locationNotes',
            },
          ],
        },
      ],
    };
    const { body } = render(OpportunityResumeFitReview, {
      props: { projection: value },
    });
    expect(body).toContain('Captured posting field · whole field');
    expect(body).toContain(
      'Field sourceContentJson.locationNotes, characters 0–13',
    );
    expect(body).toContain('Remote Canada');
    expect(body).toContain(
      'sourceContentJson.locationNotes: Considered as a separate material unit; source classification remains uncertain.',
    );
    expect(body).toContain(
      'Complete material review. Eligibility is shown separately.',
    );
    expect(body).not.toContain('Eligible for your work location');
    const represented = {
      ...value,
      completion: { ...value.completion, catalogClauseCount: 4 },
      coverage: {
        ...value.coverage,
        metadataConsideration: [
          ...value.coverage.metadataConsideration,
          {
            fieldId: 'source-field:responsibilities',
            path: 'sourceContentJson.responsibilities',
            hash: 'covered-hash',
            bodyClauseIds: ['c1'],
            status: 'represented_in_body',
          },
        ],
      },
    };
    const representedBody = render(OpportunityResumeFitReview, {
      props: { projection: represented },
    }).body;
    expect(representedBody).toContain(
      'All 4 captured material units considered; 2 material units reviewed.',
    );
    expect(representedBody).toContain(
      'Entire literal value is represented in captured body clauses c1.',
    );
  });
  it.each([
    { completion: undefined },
    { resultContractVersion: 'opportunity-resume-fit-review/v3-exact-quotes' },
    {
      completion: {
        ...completeProjection.completion,
        consideredComplete: false,
      },
    },
    {
      completion: {
        ...completeProjection.completion,
        unprocessedClauseIds: ['c2'],
      },
    },
    {
      coverage: {
        ...completeProjection.coverage,
        reviewedMaterialClauseIds: ['c1'],
      },
    },
    {
      requirements: [
        { ...completeProjection.requirements[0] },
        {
          ...completeProjection.requirements[1],
          postingCitations: completeProjection.requirements[0].postingCitations,
        },
      ],
    },
  ])('does not relabel partial or inconsistent material as a complete review', (change) => {
    expect(
      render(OpportunityResumeFitReview, {
        props: { projection: { ...completeProjection, ...change } },
      }).body,
    ).not.toContain('Complete material review');
  });
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
