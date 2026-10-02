import { APP_STATE_KEY, createInitialState } from '@happyvertical/smrt-svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { getAdminResource } from '$lib/admin/resources';
import AdminRecordViewPage from './AdminRecordViewPage.svelte';

// smrt-svelte form primitives read the app state from context; SSR specs only
// need the initial state snapshot.
const smrtContext = new Map<unknown, unknown>([
  [APP_STATE_KEY, { state: createInitialState() }],
]);

function requireResource(slug: string) {
  const resource = getAdminResource(slug);
  if (!resource) throw new Error(`Expected ${slug} admin resource fixture`);
  return resource;
}

function formMarkup(body: string, action: string): string {
  const formAt = body.indexOf(`action="?/${action}"`);
  if (formAt === -1) return '';
  const open = body.lastIndexOf('<form', formAt);
  return body.slice(open, body.indexOf('</form>', formAt));
}

function renderOpportunity(record: Record<string, unknown>) {
  const tags = requireResource('opportunity-tags');
  const roles = requireResource('opportunity-roles');
  const places = requireResource('opportunity-places');
  return render(AdminRecordViewPage, {
    props: {
      data: {
        company: null,
        opportunityRelations: [
          {
            comboOptions: {},
            kind: 'tags',
            label: 'Tags',
            records: [
              {
                id: 'tag-link-1',
                opportunityId: 'opp-1',
                tagId: 'tag-1',
                tagRole: 'required_skill',
              },
            ],
            referenceOptions: {},
            resource: tags,
          },
          {
            comboOptions: {},
            kind: 'roles',
            label: 'Roles',
            records: [],
            referenceOptions: {},
            resource: roles,
          },
          {
            comboOptions: {},
            kind: 'places',
            label: 'Places',
            records: [],
            referenceOptions: {},
            resource: places,
          },
        ],
        referenceOptions: {},
        record,
        resource: requireResource('opportunities'),
      },
    },
    context: smrtContext,
  });
}

describe('AdminRecordViewPage opportunity workflow panels', () => {
  it('shows the current safe candidate assessment separately from earlier intelligence', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      latestScore: 99,
      assessmentProjection: {
        eligibilityBucket: 'sponsorship_possible',
        matchReadiness: 'assessable',
        coverage: {
          candidateTruncated: false,
          postingTruncated: false,
          requirementsTruncated: false,
          requirementCount: 4,
        },
        ranking: { eligibilityPriority: 1, fitScore: 72 },
        reason: 'Sponsorship possible; relevant technical experience.',
        sourceStatus: 'current',
      },
      assessmentJson: 'RAW_ASSESSMENT_SECRET',
      candidatePassages: 'PRIVATE_CANDIDATE_SECRET',
    });

    expect(body).toContain('aria-label="Your opportunity assessment"');
    expect(body).toContain('>Current</strong>');
    expect(body).toContain('Eligibility: Sponsorship possible');
    expect(body).toContain('Match score: 72/100');
    expect(body).toContain(
      'Sponsorship possible; relevant technical experience.',
    );
    expect(body).toContain(
      'Current for this posting and your selected candidate profile.',
    );
    expect(body).toContain('Earlier intelligence recommendation');
    expect(body).not.toContain('Match score: 99/100');
    expect(body).not.toContain('RAW_ASSESSMENT_SECRET');
    expect(body).not.toContain('PRIVATE_CANDIDATE_SECRET');
    const form = formMarkup(body, 'processOpportunity');
    expect(form).toContain('name="opportunityId"');
    expect(form).toContain('value="opp-1"');
    expect(form).not.toContain('name="profileId"');
  });

  it.each([
    {
      matchReadiness: 'needs_extraction',
      requirementCount: 0,
      candidateTruncated: true,
      postingTruncated: true,
      requirementsTruncated: false,
      messages: [
        'No structured role requirements were extracted.',
        'Candidate evidence was truncated.',
        'Posting material was truncated.',
      ],
    },
    {
      matchReadiness: 'needs_evidence',
      requirementCount: 4,
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: true,
      messages: ['Role requirements were truncated.'],
    },
  ])('keeps eligibility visible and withholds match scores for incomplete coverage ($matchReadiness)', ({
    matchReadiness,
    messages,
    ...coverage
  }) => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      latestScore: 99,
      assessmentProjection: {
        eligibilityBucket: 'unknown',
        matchReadiness,
        coverage,
        ranking: { eligibilityPriority: 2, fitScore: 15 },
        reason: 'Eligibility needs clarification',
        sourceStatus: 'current',
      },
    });
    expect(body).toContain('>Current</strong>');
    expect(body).toContain('Eligibility: Unknown');
    expect(body).toContain('Eligibility needs clarification');
    expect(body).toContain(
      matchReadiness === 'needs_extraction'
        ? 'Needs extraction'
        : 'Needs evidence',
    );
    for (const message of messages) expect(body).toContain(message);
    expect(body).not.toContain('Match score:');
    expect(body).not.toContain('99/100');
  });

  it.each([
    undefined,
    { sourceStatus: 'stale', eligibilityBucket: 'eligible' },
    { sourceStatus: 'current', eligibilityBucket: 'provider_new_value' },
    {
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      ranking: { fitScore: '72' },
    },
  ])('shows unknown rather than a legacy score without a valid current assessment (%j)', (assessmentProjection) => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      latestScore: 99,
      assessmentProjection,
    });
    expect(body).toContain('>Unknown</strong>');
    expect(body).toContain('Eligibility: Unknown');
    expect(body).toContain('No current assessment is available.');
    expect(body).not.toContain('Match score:');
  });

  it('renders uncertain evidence separately from confirmed gaps', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      evidenceMatrix: [
        { requirement: 'TypeScript', status: 'supported' },
        { requirement: 'PostgreSQL', status: 'uncertain' },
        { requirement: 'Kubernetes', status: 'gap' },
      ],
    });

    expect(body).toContain('TypeScript</strong>');
    expect(body).toContain('PostgreSQL</strong>');
    expect(body).toContain('Kubernetes</strong>');
    expect(body).toContain('>Supported</span>');
    expect(body).toContain('>Uncertain</span>');
    expect(body).toContain('>Gap</span>');
    expect(body).toContain('1 evidence gaps');
  });

  it('hosts the draft application form with its required fields', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      title: 'Staff engineer',
      applicationResumeMode: 'generate_tailored',
    });

    const form = formMarkup(body, 'createDraftApplication');
    expect(form).not.toBe('');
    expect(form).toContain('name="opportunityId"');
    expect(form).toContain('value="opp-1"');
    for (const field of [
      'applyMethod',
      'resumeMode',
      'coverLetterMode',
      'dueAt',
      'applicationInstructions',
      'requiredAnswers',
      'preflightOverrideReason',
    ]) {
      expect(form).toContain(`name="${field}"`);
    }
    expect(form).toContain('Create draft application');
  });

  it('links to the canonical application page once a draft exists', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      title: 'Staff engineer',
      applicationId: 'app-9',
      applicationStatus: 'draft',
    });

    expect(body).toContain('href="/admin/applications/app-9"');
    expect(formMarkup(body, 'createDraftApplication')).toContain(
      'Update draft',
    );
    // The application lifecycle forms stay on /admin/applications/[id].
    expect(body).not.toContain('generateApplicationPackage');
    expect(body).not.toContain('recordApplicationSubmission');
  });

  it('hosts the notes (fact intake) form and lists linked intakes', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      title: 'Staff engineer',
      factIntakes: [
        {
          id: 'intake-1',
          intakeContext: 'Opportunity: Staff engineer',
          rawText: 'Led the migration.',
          status: 'reviewed',
        },
      ],
    });

    const form = formMarkup(body, 'createFactIntake');
    expect(form).toContain('name="targetEntityType"');
    expect(form).toContain('value="Opportunity"');
    expect(form).toContain('name="targetEntityId"');
    expect(form).toContain('value="opp-1"');
    expect(form).toContain('name="sourceKind"');
    expect(form).toContain('name="rawText"');
    expect(form).toContain('name="intakeContext"');
    expect(body).toContain('Led the migration.');
  });

  it('exposes tag, role, and place membership editing on the detail page', () => {
    const { body } = renderOpportunity({
      id: 'opp-1',
      title: 'Staff engineer',
    });

    for (const kind of ['tags', 'roles', 'places']) {
      expect(body).toContain(`data-relation="${kind}"`);
    }
    const createForms =
      body.match(/action="\?\/createOpportunityRelation"/g) ?? [];
    expect(createForms).toHaveLength(3);
    expect(body).toContain('name="relation"');
    expect(body).toContain('value="tags"');
    expect(body).toContain('name="tagRole"');
    expect(body).toContain('name="roleId"');
    expect(body).toContain('name="placeRole"');
    // The opportunity id is fixed server-side; the form never exposes it.
    expect(body).not.toContain('name="opportunityId" value="opp-1" required');

    const deleteForm = formMarkup(body, 'deleteOpportunityRelation');
    expect(deleteForm).toContain('name="id"');
    expect(deleteForm).toContain('value="tag-link-1"');
    expect(deleteForm).toContain('value="tags"');
    expect(body).toContain('href="/admin/opportunity-tags"');
  });
});

describe('AdminRecordViewPage recommendation decision', () => {
  function renderTask(record: Record<string, unknown>) {
    return render(AdminRecordViewPage, {
      props: {
        data: {
          referenceOptions: {},
          record,
          resource: requireResource('tasks'),
        },
      },
      context: smrtContext,
    });
  }

  it('hosts the processRecommendationTask form for review_recommendation tasks', () => {
    const { body } = renderTask({
      id: 'task-1',
      title: 'Decide on Staff engineer',
      taskType: 'review_recommendation',
      blockerReason: 'Posting check was inconclusive.',
    });

    const form = formMarkup(body, 'processRecommendationTask');
    expect(form).not.toBe('');
    expect(form).toMatch(
      /<input[^>]*type="hidden"[^>]*name="taskId"[^>]*value="task-1"/,
    );
    expect(form).toMatch(/<select[^>]*name="decision"[^>]*required/);
    expect(form).toContain('value="accept_to_apply"');
    expect(form).toContain('name="deciderProfileId"');
    expect(form).toMatch(
      /<textarea[^>]*name="reason"[^>]*>Posting check was inconclusive\./,
    );
    // Human-only override: a plain form field, never a tool parameter.
    expect(form).toMatch(/<input[^>]*name="preflightOverrideReason"/);
  });

  it('does not offer a recommendation decision on other task types', () => {
    const { body } = renderTask({
      id: 'task-2',
      title: 'Submit application',
      taskType: 'submit_application',
    });

    expect(body).not.toContain('processRecommendationTask');
    expect(body).not.toContain('preflightOverrideReason');
  });
});
