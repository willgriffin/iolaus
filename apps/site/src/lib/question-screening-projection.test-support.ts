import {
  aggregateScreeningQuestionAnswers,
  createScreeningQuestion,
  type ScreeningQuestionAnswer,
} from './opportunity-screening-questions';
export async function questionScreeningFixture() {
  const questions = await Promise.all([
    createScreeningQuestion({
      id: 'remote',
      text: 'Is remote work offered?',
      kind: 'source',
      importance: 'preference',
      desiredAnswer: 'yes',
      weight: 3,
      active: true,
    }),
    createScreeningQuestion({
      id: 'experience',
      text: 'Does documented experience support this work?',
      kind: 'fit',
      importance: 'must_have',
      desiredAnswer: 'yes',
      weight: 2,
      active: true,
    }),
    createScreeningQuestion({
      id: 'authorization',
      text: 'Is work authorization stated?',
      kind: 'source',
      importance: 'must_have',
      desiredAnswer: 'yes',
      weight: 5,
      active: true,
    }),
  ]);
  const posting = {
    id: 'body:1',
    text: 'Remote work is offered.',
    start: 0,
    end: 23,
  };
  const answers: ScreeningQuestionAnswer[] = [
    {
      questionId: 'remote',
      questionRevision: questions[0]!.revision,
      answer: 'yes',
      alignment: 4,
      confidence: 0.98,
      sourceCitations: [posting],
      candidateCitations: [],
    },
    {
      questionId: 'experience',
      questionRevision: questions[1]!.revision,
      answer: 'partial',
      alignment: 2,
      confidence: 0.91,
      sourceCitations: [posting],
      candidateCitations: [
        {
          id: 'fact:1',
          title: 'API ownership',
          kind: 'project',
          text: 'Maintained production APIs.',
        },
      ],
      uncertainty:
        'Scope is relevant; the required tenure remains unestablished.',
    },
    {
      questionId: 'authorization',
      questionRevision: questions[2]!.revision,
      answer: 'unknown',
      alignment: null,
      confidence: 0.2,
      sourceCitations: [],
      candidateCitations: [],
      uncertainty:
        'The posting does not establish this authorization condition.',
    },
  ];
  return {
    version: 'opportunity-question-screening-projection/v1' as const,
    sourceStatus: 'current' as const,
    model: 'jev-1.13.0' as const,
    questions,
    answers,
    aggregate: aggregateScreeningQuestionAnswers(questions, answers),
  };
}
