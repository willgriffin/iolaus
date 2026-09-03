import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OpportunityWorkflowForms from './OpportunityWorkflowForms.svelte';

function formMarkup(body: string, action: string): string {
  const formAt = body.indexOf(`action="${action}"`);
  if (formAt === -1) return '';
  const open = body.lastIndexOf('<form', formAt);
  return body.slice(open, body.indexOf('</form>', formAt));
}

describe('OpportunityWorkflowForms', () => {
  it('renders the draft application form with every field the action reads', () => {
    const { body } = render(OpportunityWorkflowForms, {
      props: {
        record: {
          id: 'opp-1',
          title: 'Staff engineer',
          applicationResumeMode: 'generate_tailored',
        },
      },
    });

    const form = formMarkup(body, '?/createDraftApplication');
    expect(form).not.toBe('');
    expect(form).toMatch(
      /<input[^>]*type="hidden"[^>]*name="opportunityId"[^>]*value="opp-1"/,
    );
    for (const field of [
      'applyMethod',
      'resumeMode',
      'coverLetterMode',
      'dueAt',
      'applicationInstructions',
      'requiredAnswers',
    ]) {
      expect(form).toContain(`name="${field}"`);
    }
    // Human-only override: a plain form field, never a tool parameter.
    expect(form).toMatch(/<input[^>]*name="preflightOverrideReason"/);
    expect(form).toContain('Create draft application');
  });

  it('points at the canonical application page once a draft exists', () => {
    const { body } = render(OpportunityWorkflowForms, {
      props: {
        record: {
          id: 'opp-1',
          title: 'Staff engineer',
          applicationId: 'app-9',
          applicationStatus: 'materials_ready',
        },
      },
    });

    expect(body).toContain('href="/admin/applications/app-9"');
    expect(body).toContain('Open materials ready application');
    expect(formMarkup(body, '?/createDraftApplication')).toContain(
      'Update draft',
    );
    // Packet generation and submission stay on /admin/applications/[id].
    expect(body).not.toContain('generateApplicationPackage');
    expect(body).not.toContain('recordApplicationSubmission');
  });

  it('renders the notes (fact intake) form targeting the opportunity', () => {
    const { body } = render(OpportunityWorkflowForms, {
      props: {
        record: { id: 'opp-2', title: 'Platform lead', factIntakeCount: 2 },
      },
    });

    const form = formMarkup(body, '?/createFactIntake');
    expect(form).toMatch(/name="targetEntityType"[^>]*value="Opportunity"/);
    expect(form).toMatch(/name="targetEntityId"[^>]*value="opp-2"/);
    expect(form).toMatch(/name="sourceKind"[^>]*value="story"/);
    expect(form).toMatch(/<textarea[^>]*name="rawText"[^>]*required/);
    expect(form).toContain('name="intakeContext"');
    expect(form).toContain('Opportunity: Platform lead');
    expect(body).toContain('2 linked');
  });

  it('accepts page-relative action hrefs so list pages keep their filters', () => {
    const { body } = render(OpportunityWorkflowForms, {
      props: {
        draftApplicationAction:
          '/admin/opportunities?review=maybe&/createDraftApplication=',
        factIntakeAction:
          '/admin/opportunities?review=maybe&/createFactIntake=',
        record: { id: 'opp-1', title: 'Staff engineer' },
      },
    });

    expect(body).toContain(
      'action="/admin/opportunities?review=maybe&amp;/createDraftApplication="',
    );
    expect(body).toContain(
      'action="/admin/opportunities?review=maybe&amp;/createFactIntake="',
    );
  });
});
