import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ApplicationReviewPage from './+page.svelte';

function renderApplicationReview(requiresOverride: boolean) {
  return render(ApplicationReviewPage, {
    props: {
      data: {
        application: {
          applyMethod: 'company_site',
          id: 'demo-application',
          status: 'awaiting_user',
        },
        answersEditor: {
          ats: '',
          hasSchema: false,
          questions: [],
          reusableAnswerCount: 0,
        },
        autoSubmit: {
          ats: '',
          hasSchema: false,
          missingRequiredAnswers: [],
          requiredQuestions: [],
        },
        comments: [],
        company: { name: 'Acme' },
        finalApprovalMaterialsCurrent: false,
        materials: [],
        opportunity: { title: 'Senior software engineer' },
        preflight: { requiresOverride },
        submissionOptions: { methods: [], roles: [] },
        submissionTaskId: '',
      },
    },
  });
}

describe('application review packet generation', () => {
  it('keeps the normal fictional-demo review header free of override controls', () => {
    const { body } = renderApplicationReview(false);

    expect(body).toMatch(/<header class="review-header(?: [^"]*)?">/);
    expect(body).toContain('Generate packet');
    expect(body).not.toContain('Posting needs your confirmation');
    expect(body).not.toContain('name="preflightOverrideReason"');
  });

  it('places the required owner override in a dedicated posting review section', () => {
    const { body } = renderApplicationReview(true);

    expect(body).toContain('Posting needs your confirmation');
    expect(body).toMatch(
      /<section class="preflight-review(?: [^"]*)?"[^>]*aria-label="Posting check review"/,
    );
    expect(body).toMatch(
      /<textarea[^>]*name="preflightOverrideReason"[^>]*required/,
    );
    expect(body).not.toMatch(
      /<header class="review-header(?: [^"]*)?">[\s\S]*name="preflightOverrideReason"[\s\S]*?<\/header>/,
    );
  });
});
