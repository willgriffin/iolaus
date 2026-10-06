import { describe, expect, it } from 'vitest';
import { aggregateScreeningQuestionAnswers } from './opportunity-screening-questions';
import {
  getCurrentQuestionScreeningProjection,
  questionScreeningLabel,
} from './question-screening-projection';
import { questionScreeningFixture } from './question-screening-projection.test-support';

describe('current Screening Questions projection', () => {
  it('retains the full enabled weight denominator and separates partial, unknown and must-have uncertainty', async () => {
    const fixture = await questionScreeningFixture();
    const current = getCurrentQuestionScreeningProjection(fixture);
    expect(current?.aggregate).toMatchObject({
      recommendationPercent: 40,
      evidenceCoveragePercent: 50,
      totalScoringWeight: 10,
      mustHaveConflictIds: [],
      partialQuestionIds: ['experience'],
      unknownQuestionIds: ['authorization'],
      unresolvedMustHaveIds: ['experience', 'authorization'],
    });
    expect(current && questionScreeningLabel(current)).toBe(
      'Recommendation 40.0%',
    );
  });
  it('validates individual skill attribution without borrowing aggregate alignment', async () => {
    const fixture = await questionScreeningFixture();
    const match = {
      requirement: 'Postgres',
      sourceField: 'requiredSkills',
      status: 'supported',
      assessed: true,
      confidence: 0.95,
      sourceCitation: {
        id: 'field',
        text: 'Postgres',
        start: 0,
        end: 8,
        sourceFieldPath: 'sourceContentJson.requiredSkills',
      },
      candidateCitations: [
        {
          id: 'project',
          title: 'Database work',
          kind: 'project',
          text: 'Built PostgreSQL applications.',
        },
      ],
    };
    expect(
      getCurrentQuestionScreeningProjection({
        ...fixture,
        skillMatches: [match],
      })?.skillMatches,
    ).toEqual([match]);
    for (const invalid of [
      { ...match, status: 'gap' },
      { ...match, candidateCitations: [] },
      { ...match, confidence: 0.2 },
      { ...match, assessed: false },
      { ...match, sourceCitation: { ...match.sourceCitation, end: 99 } },
    ])
      expect(
        getCurrentQuestionScreeningProjection({
          ...fixture,
          skillMatches: [invalid],
        }),
      ).toBeNull();
    expect(
      getCurrentQuestionScreeningProjection({
        ...fixture,
        skillMatches: [
          {
            ...match,
            status: 'unknown',
            assessed: false,
            confidence: 0,
            candidateCitations: [],
          },
        ],
      }),
    ).not.toBeNull();
  });
  it('keeps an all-unknown recommendation unknown rather than a mismatch or zero fit', async () => {
    const fixture = await questionScreeningFixture();
    const answers = fixture.answers.map((answer) => ({
      ...answer,
      answer: 'unknown' as const,
      alignment: null,
      sourceCitations: [],
      candidateCitations: [],
    }));
    const current = getCurrentQuestionScreeningProjection({
      ...fixture,
      answers,
      aggregate: aggregateScreeningQuestionAnswers(fixture.questions, answers),
    });
    expect(current?.aggregate.recommendationPercent).toBeNull();
    expect(current?.aggregate.mustHaveConflictIds).toEqual([]);
    expect(current && questionScreeningLabel(current)).toBe(
      'Recommendation unknown',
    );
  });
  it('rejects stale markers, foreign models, altered totals and malformed citation spans', async () => {
    const fixture = await questionScreeningFixture();
    expect(
      getCurrentQuestionScreeningProjection(fixture, 'unknown'),
    ).toBeNull();
    expect(
      getCurrentQuestionScreeningProjection({
        ...fixture,
        model: 'openai/gpt-6.1-sol',
      }),
    ).toBeNull();
    expect(
      getCurrentQuestionScreeningProjection({
        ...fixture,
        aggregate: { ...fixture.aggregate, recommendationPercent: 80 },
      }),
    ).toBeNull();
    expect(
      getCurrentQuestionScreeningProjection({
        ...fixture,
        answers: [
          {
            ...fixture.answers[0],
            sourceCitations: [
              { ...fixture.answers[0]!.sourceCitations[0], end: 1 },
            ],
          },
          ...fixture.answers.slice(1),
        ],
      }),
    ).toBeNull();
  });
});
