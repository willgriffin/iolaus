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
        materials: ['packet', 'resume', 'cover_letter', 'answers'].map(
          (materialType) => ({
            materialType,
            label:
              {
                packet: 'Packet',
                resume: 'Resume',
                cover_letter: 'Cover letter',
                answers: 'Answers',
              }[materialType] ?? materialType,
            body: '',
            href: '',
            materialRecordId: materialType,
            materialRecordType: 'ResumeAsset',
            materialVersion: '1',
            path: '',
            pdfHref: '',
            pdfPath: '',
            reviewStatus: 'not_reviewed' as const,
            title: '',
          }),
        ),
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

it('defaults to Opportunity and hides internal packet and material-only actions', () => {
  const { body } = renderApplicationReview(false);
  const tabs =
    body.match(/<nav[^>]*class="material-tabs[^>]*>([\s\S]*?)<\/nav>/)?.[1] ??
    '';
  expect(tabs).toMatch(/aria-current="page"[^>]*>Opportunity/);
  expect(tabs).toMatch(
    /Opportunity[\s\S]*Resume[\s\S]*Cover letter[\s\S]*Q&amp;A/,
  );
  expect(tabs).not.toContain('Packet');
  expect(body).toContain('Opportunity overview');
  expect(body).not.toContain('Packet comments');
  expect(body).not.toContain('Mark material reviewed');
  expect(body).not.toContain('Save comments');
  expect(body).toContain('name="finalSubmissionIntent"');
  expect(body).toContain('value="final_submission"');
});
