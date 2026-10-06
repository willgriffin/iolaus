import { describe, expect, it } from 'vitest';
import {
  aggregateScreeningQuestionAnswers,
  createScreeningQuestion,
  type ScreeningQuestion,
  type ScreeningQuestionAnswer,
  type ScreeningQuestionInput,
  screeningQuestionRevision,
  screeningQuestionSetFingerprint,
  screeningQuestionSuggestions,
} from './opportunity-screening-questions.js';

const input: ScreeningQuestionInput = {
  text: 'Does the posting offer remote work?',
  kind: 'source',
  importance: 'preference',
  desiredAnswer: 'yes',
  weight: 1,
  active: true,
};
const source = { id: 'posting-1', text: 'Remote work', start: 0, end: 11 };
const candidate = {
  id: 'fact-1',
  title: 'Project',
  kind: 'project',
  text: 'Built a service.',
};
function answer(
  question: ScreeningQuestion,
  fields: Partial<ScreeningQuestionAnswer> = {},
): ScreeningQuestionAnswer {
  return {
    questionId: question.id,
    questionRevision: question.revision,
    answer: 'yes',
    alignment: 4,
    confidence: 0.9,
    sourceCitations: [source],
    candidateCitations: question.kind === 'fit' ? [candidate] : [],
    ...fields,
  };
}

/** Pure browser/Node contract; principal, persistence and SQL are owned by native service specs. */
describe('screening questions and recommendation arithmetic', () => {
  it('binds exact canonical content and rejects stale or duplicate revisions', async () => {
    const question = await createScreeningQuestion({ id: 'a', ...input });
    expect(question.revision).toBe(await screeningQuestionRevision(input));
    expect(await screeningQuestionSetFingerprint([question])).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    await expect(
      screeningQuestionSetFingerprint([{ ...question, weight: 2 }]),
    ).rejects.toThrow('stale');
    await expect(
      screeningQuestionSetFingerprint([question, question]),
    ).rejects.toThrow('Duplicate');
  });
  it('keeps unknown weights in the denominator, excluding informational and inactive questions', async () => {
    const known = await createScreeningQuestion({
      id: 'a',
      ...input,
      weight: 2,
    });
    const unknown = await createScreeningQuestion({
      id: 'b',
      ...input,
      weight: 6,
    });
    const info = await createScreeningQuestion({
      id: 'c',
      ...input,
      importance: 'informational',
      weight: 10,
    });
    const inactive = await createScreeningQuestion({
      id: 'd',
      ...input,
      active: false,
    });
    const result = aggregateScreeningQuestionAnswers(
      [known, unknown, info, inactive],
      [
        answer(known),
        answer(unknown, {
          answer: 'unknown',
          alignment: null,
          sourceCitations: [],
        }),
        answer(info),
      ],
    );
    expect(result).toMatchObject({
      recommendationPercent: 25,
      evidenceCoveragePercent: 25,
      totalScoringWeight: 8,
      ratedScoringWeight: 2,
      unknownQuestionIds: ['b'],
    });
  });
  it('all unknown scores are null rather than a fabricated zero mismatch', async () => {
    const question = await createScreeningQuestion({
      id: 'a',
      ...input,
      importance: 'must_have',
    });
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [
          answer(question, {
            answer: 'unknown',
            alignment: null,
            sourceCitations: [],
          }),
        ],
      ),
    ).toMatchObject({
      recommendationPercent: null,
      evidenceCoveragePercent: 0,
      mustHaveConflictIds: [],
      unresolvedMustHaveIds: ['a'],
    });
  });
  it('desired no uses inverted endpoints and confidence never scales the score', async () => {
    const question = await createScreeningQuestion({
      id: 'a',
      ...input,
      desiredAnswer: 'no',
    });
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { answer: 'no', alignment: 4, confidence: 0.2 })],
      ).recommendationPercent,
    ).toBe(100);
    expect(() =>
      aggregateScreeningQuestionAnswers([question], [answer(question)]),
    ).toThrow('polarity');
  });
  it('attributable partial fit contributes ordinal points, but a partial must-have stays unresolved', async () => {
    const question = await createScreeningQuestion({
      id: 'a',
      ...input,
      kind: 'fit',
      importance: 'must_have',
      weight: 4,
    });
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { answer: 'partial', alignment: 2 })],
      ),
    ).toMatchObject({
      recommendationPercent: 50,
      evidenceCoveragePercent: 100,
      mustHaveConflictIds: [],
      partialQuestionIds: ['a'],
      unresolvedMustHaveIds: ['a'],
    });
    expect(() =>
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { candidateCitations: [] })],
      ),
    ).toThrow('attributed');
    const sourceQuestion = await createScreeningQuestion({ id: 'b', ...input });
    expect(() =>
      aggregateScreeningQuestionAnswers(
        [sourceQuestion],
        [answer(sourceQuestion, { answer: 'partial', alignment: 2 })],
      ),
    ).toThrow('Invalid');
  });
  it('a clear opposite with grounded source and confidence .85 is a conflict; unknown is not', async () => {
    const question = await createScreeningQuestion({
      id: 'a',
      ...input,
      importance: 'must_have',
    });
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { answer: 'no', alignment: 0, confidence: 0.85 })],
      ).mustHaveConflictIds,
    ).toEqual(['a']);
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { answer: 'no', alignment: 0, confidence: 0.84 })],
      ).mustHaveConflictIds,
    ).toEqual([]);
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { answer: 'no', alignment: 0, confidence: 0.84 })],
      ).unresolvedMustHaveIds,
    ).toEqual(['a']);
    expect(
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { confidence: 0.3 })],
      ).unresolvedMustHaveIds,
    ).toEqual(['a']);
    expect(() =>
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { sourceCitations: [] })],
      ),
    ).toThrow('attributed');
  });
  it('rejects malformed weight/active/revision and missing answer coverage', async () => {
    await expect(
      createScreeningQuestion({ id: 'a', ...input, weight: 11 }),
    ).rejects.toThrow('Invalid');
    const question = await createScreeningQuestion({ id: 'a', ...input });
    expect(() => aggregateScreeningQuestionAnswers([question], [])).toThrow(
      'exactly',
    );
    expect(() =>
      aggregateScreeningQuestionAnswers(
        [question],
        [answer(question, { questionRevision: 'foreign' })],
      ),
    ).toThrow('stale');
    const many = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        createScreeningQuestion({ id: `q${index}`, ...input }),
      ),
    );
    await expect(screeningQuestionSetFingerprint(many)).rejects.toThrow(
      'Too many',
    );
  });
  it('suggests only unsaved preferences from explicit typed profile preferences', () => {
    expect(
      screeningQuestionSuggestions({
        title: 'Engineer',
        preferencesJson: null,
      }),
    ).toEqual([]);
    const suggestions = screeningQuestionSuggestions({
      preferencesJson: JSON.stringify({
        targetRoles: ['Platform Engineer'],
        workModes: ['remote'],
      }),
      targetWorkCountryJson: JSON.stringify({
        code: 'NZ',
        label: 'New Zealand',
      }),
    });
    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((item) => item.importance === 'preference')).toBe(
      true,
    );
    expect(suggestions.map((item) => item.text).join(' ')).toContain(
      'New Zealand',
    );
    expect(suggestions.map((item) => item.text).join(' ')).not.toContain(
      'Canada',
    );
  });
});
