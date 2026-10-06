import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ScreeningQuestionsEditor from './ScreeningQuestionsEditor.svelte';

const question = {
  id: 'question-1',
  text: 'Does the posting allow remote work?',
  kind: 'source' as const,
  importance: 'preference' as const,
  desiredAnswer: 'yes' as const,
  weight: 3,
  active: true,
  revision: 'a'.repeat(64),
};
describe('Screening Questions preferences', () => {
  it('shows native global storage errors without silently offering a valid empty set', () => {
    const { body } = render(ScreeningQuestionsEditor, {
      props: {
        data: {
          questions: [],
          questionSetFingerprint: 'invalid',
          errors: ['Too many stored screening questions.'],
        },
      },
    });
    expect(body).toContain('Too many stored screening questions.');
    expect(body).toContain('Screening is unavailable until this is resolved.');
  });
  it('shows saved polarity and priorities as cards without hidden editing forms', () => {
    const { body } = render(ScreeningQuestionsEditor, {
      props: {
        data: {
          questions: [
            question,
            {
              ...question,
              id: 'question-2',
              kind: 'fit',
              text: 'Does my evidence support this work?',
              importance: 'must_have',
              desiredAnswer: 'no',
              active: false,
            },
          ],
          questionSetFingerprint: 'set',
        },
      },
    });
    expect(body).toContain('Desired answer: Yes');
    expect(body).toContain('Desired answer: No');
    expect(body).toContain('Must-have');
    expect(body).toContain('Disabled');
    expect(body).not.toContain('<form');
    expect(body).not.toContain('<textarea');
  });
  it('leaves suggestions unsaved and explains unknowns separately from conflicts', () => {
    const { body } = render(ScreeningQuestionsEditor, {
      props: {
        data: {
          questions: [],
          questionSetFingerprint: 'empty',
          suggestions: [question],
        },
      },
    });
    expect(body).toContain('No questions saved.');
    expect(body).toContain('These are unsaved preferences.');
    expect(body).toContain('without establishing a mismatch');
    expect(body).toContain('does not run automatically');
    expect(body).not.toContain('<form');
  });
});
