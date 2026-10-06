import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AdminRecord } from '$lib/admin/dock';
import { completeReviewFixture } from '$lib/opportunity-resume-fit-review-projection.test-support';
import { questionScreeningFixture } from '$lib/question-screening-projection.test-support';
import OpportunityTriageCard from './OpportunityTriageCard.svelte';

function renderCard(record: AdminRecord, props: Record<string, unknown> = {}) {
  return render(OpportunityTriageCard, {
    props: {
      onAction: () => undefined,
      record,
      ...props,
    },
  });
}

describe('OpportunityTriageCard', () => {
  it('uses current user-question recommendation as primary without a legacy numeric score', async () => {
    const { body } = renderCard({
      id: 'question-result',
      title: 'API engineer',
      questionScreeningEnabled: true,
      questionScreeningStatus: 'current',
      questionScreeningProjection: await questionScreeningFixture(),
      latestScore: 99,
    });
    expect(body).toContain('Recommendation 40.0%');
    expect(body).toContain('Run screening');
    expect(body).toContain('Partial');
    expect(body).not.toContain('99/100');
  });
  it('shows only individual semantic receipts as supported and leaves unassessed skills neutral', async () => {
    const projection = await questionScreeningFixture();
    const { body } = renderCard(
      {
        id: 'skills',
        title: 'API engineer',
        requiredSkills: 'Postgres, Python',
        questionScreeningEnabled: true,
        questionScreeningStatus: 'current',
        questionScreeningProjection: {
          ...projection,
          skillMatches: [
            {
              requirement: 'Postgres',
              meaning: 'named_capability',
              sourceField: 'requiredSkills',
              status: 'supported',
              assessed: true,
              confidence: 0.95,
              sourceCitation: {
                id: 'field',
                text: 'Postgres',
                start: 0,
                end: 8,
              },
              candidateCitations: [
                {
                  id: 'p',
                  title: 'Database work',
                  kind: 'project',
                  text: 'Built PostgreSQL services.',
                },
              ],
            },
          ],
        },
      },
      { candidateSkills: ['python'] },
    );
    expect(body).toContain('Postgres · Direct experience');
    expect(body).toContain('Python · Not assessed');
    expect(body).toContain('Built PostgreSQL services.');
    expect(body).toContain('Individual skill evidence');
    expect(body).not.toContain('Python · Supported');
  });
  it('presents current complete evidence as primary while keeping legal eligibility unknown', () => {
    const { body } = renderCard({
      id: 'complete-review',
      title: 'API engineer',
      resumeFitReviewProjection: completeReviewFixture(),
      latestScore: 99,
    });
    expect(body).toContain('All reviewed criteria supported');
    expect(body).toContain('1 supported of 1 considered criteria');
    expect(body).toContain('Eligibility: Unknown');
    expect(body).not.toContain('No current assessment is available');
    expect(body).not.toContain('Overall fit not yet established');
    expect(body).not.toContain('99/100');
  });
  it('separates coarse relevance from unknown fit and retains human review state', () => {
    const quote = 'We are hiring software engineers.';
    const record = {
      id: 'screened-role',
      title: 'Platform role',
      humanReviewStatus: 'apply',
      reviewOverlay: {
        humanReviewStatus: 'apply',
        humanReviewNotes: 'Owner decision',
      },
      latestScore: 99,
      sourceContentFingerprint: 'source',
      sourceContentVersion: 1,
      sourceContentJson: JSON.stringify({ descriptionRaw: quote }),
      screeningProjection: {
        version: 'opportunity-screening-projection/v1',
        mode: 'coarse_screen',
        sourceStatus: 'current',
        status: 'potentially_relevant',
        excludeFromDefaultTriage: false,
        requestId: 'owned',
        sourceContentFingerprint: 'source',
        sourceContentVersion: 1,
        sourceFingerprint: 'a'.repeat(64),
        profileFingerprint: 'b'.repeat(64),
        inputFingerprint: 'c'.repeat(64),
        evidence: [
          {
            dimension: 'role_relevant',
            probability: 0.95,
            confidence: 0.95,
            witness: {
              id: 's0',
              path: 'sourceContentJson.descriptionRaw',
              text: quote,
            },
          },
        ],
        conditionalPaths: [],
        uncertainties: [],
        holdReasons: [],
      },
    };
    const { body } = renderCard(record);
    expect(body).toContain('Potentially relevant');
    expect(body).toContain('does not establish overall fit');
    expect(body).toContain(quote);
    expect(body).not.toContain('99/100');
    expect(record.humanReviewStatus).toBe('apply');
    expect(record.reviewOverlay).toEqual({
      humanReviewStatus: 'apply',
      humanReviewNotes: 'Owner decision',
    });
    const unavailable = renderCard({ ...record, screeningProjection: null });
    expect(unavailable.body).not.toContain('Coarse screening:');
  });
  it('renders the posting and the card utilities', () => {
    const { body } = renderCard({
      companyName: 'Northwind',
      descriptionSummary: 'Own the platform.',
      humanRating: 6,
      id: 'opp-1',
      latestScore: 87,
      assessmentProjection: {
        sourceStatus: 'current',
        eligibilityBucket: 'unknown',
        matchReadiness: 'assessable',
        coverage: {
          candidateTruncated: false,
          postingTruncated: false,
          requirementsTruncated: false,
          requirementCount: 4,
        },
        ranking: { eligibilityPriority: 2, fitScore: 87 },
        reason: 'Eligibility needs clarification',
      },
      locations: 'Remote (US)',
      postingUrl: 'https://example.test/jobs/1',
      requiredSkills: 'Rust, Postgres',
      title: 'Staff platform engineer',
    });

    expect(body).toContain('Staff platform engineer');
    expect(body).toContain('Northwind');
    expect(body).toContain('Remote (US)');
    expect(body).toContain('87');
    expect(body).toContain('https://example.test/jobs/1');
    expect(body).toContain('Rust');
    expect(body).toContain('Verify posting');
    expect(body).toContain('Undo');
  });

  it('offers no apply path: the verdicts live in the deck, not on the card', () => {
    const { body } = renderCard({ id: 'opp-1', title: 'Staff engineer' });

    // Triage decides what deserves a deeper look. An application is started
    // from the shortlist or the record page, never from a card.
    expect(body).not.toContain('>Apply</button>');
    expect(body).not.toContain('acceptOpportunity');
    expect(body).not.toContain('preflightOverrideReason');
  });

  it.each([
    {
      matchReadiness: 'needs_extraction',
      requirementCount: 0,
      postingTruncated: false,
      label: 'Needs extraction',
      message: 'No structured role requirements were extracted.',
    },
    {
      matchReadiness: 'needs_evidence',
      requirementCount: 4,
      postingTruncated: true,
      label: 'Needs evidence',
      message: 'Posting material was truncated.',
    },
  ])('withholds sparse match scores in triage and keeps eligibility ($label)', ({
    matchReadiness,
    requirementCount,
    postingTruncated,
    label,
    message,
  }) => {
    const { body } = renderCard({
      id: 'opp-1',
      title: 'Staff engineer',
      latestScore: 99,
      latestScoreSummary: 'Legacy poor fit assessment',
      assessmentProjection: {
        sourceStatus: 'current',
        eligibilityBucket: 'unknown',
        matchReadiness,
        coverage: {
          candidateTruncated: false,
          postingTruncated,
          requirementsTruncated: false,
          requirementCount,
        },
        ranking: { eligibilityPriority: 2, fitScore: 15 },
        reason: 'Eligibility needs clarification',
      },
    });
    expect(body).toContain(label);
    expect(body).toContain(message);
    expect(body).toContain('Eligibility: Unknown');
    expect(body).toContain('Eligibility needs clarification');
    expect(body).not.toContain('15/100');
    expect(body).not.toContain('99/100');
    expect(body).not.toContain('Legacy poor fit assessment');
  });

  it('hides the posting check and the rating: the verdict buttons carry both', () => {
    const { body } = renderCard({
      humanRating: 6,
      id: 'opp-1',
      title: 'Staff platform engineer',
    });

    expect(body).not.toContain('Posting check');
    expect(body).not.toContain('Your rating');
    expect(body).not.toContain('Rate 1 of 10');
    expect(body).not.toContain('6/10');
  });

  it('puts the job description before the summary, skills, and qualifications', () => {
    const { body } = renderCard({
      descriptionRaw: 'We build boring, reliable infrastructure.',
      descriptionSummary: 'Own the platform.',
      id: 'opp-1',
      qualifications: '- 8 years of Rust',
      requiredSkills: 'Rust, Postgres',
      title: 'Staff platform engineer',
    });

    const description = body.indexOf(
      'We build boring, reliable infrastructure.',
    );
    expect(description).toBeGreaterThan(-1);
    expect(description).toBeLessThan(body.indexOf('Own the platform.'));
    expect(description).toBeLessThan(body.indexOf('Rust'));
    expect(description).toBeLessThan(body.indexOf('8 years of Rust'));
  });

  it('stays renderable when the crawl captured nothing but a title', () => {
    const { body } = renderCard({ id: 'opp-2', title: 'Backend engineer' });

    expect(body).toContain('Backend engineer');
    expect(body).toContain('Unknown company');
    expect(body).toContain('Location not stated');
    expect(body).toContain('Match assessment unavailable');
    expect(body).toContain('No summary captured yet.');
    // No posting URL means no dangling posting link.
    expect(body).not.toContain('View the posting');
  });

  it('falls back to an untitled label and still offers a full-record link', () => {
    const { body } = renderCard({ id: 'opp-3' });

    expect(body).toContain('Untitled opportunity');
    expect(body).toContain('/admin/opportunities/opp-3');
  });

  it('drops the apply caveat now that no decision here creates one', () => {
    const { body } = renderCard({ id: 'opp-4', title: 'Lead' });
    const text = body.replace(/\s+/g, ' ');

    expect(text).toContain('Undo restores the review fields of the last');
    expect(text).not.toContain('cannot remove an application');
  });

  it('documents the remapped keyboard shortcuts on the card', () => {
    const { body } = renderCard({ id: 'opp-5', title: 'Lead' });

    expect(body).toContain('← / h / x');
    expect(body).toContain('→ / l / d');
    expect(body).toContain('space / s');
    expect(body).toContain('Dig deeper');
    expect(body).toContain('Nope');
    expect(body).toContain('Later');
    // The retired apply key must not survive in the legend.
    expect(body).not.toContain('↓ / j');
  });

  it('disables every action while a decision is in flight', () => {
    const { body } = renderCard({ id: 'opp-6', title: 'Lead' }, { busy: true });

    const buttons = body.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.includes('disabled'))).toBe(true);
  });

  it('leaves queue progress to the dialog that owns the queue', () => {
    // The card is only ever about the posting in hand; "n of total" belongs to
    // the triage dialog's header, beside the close button.
    const { body } = renderCard({ id: 'opp-7', title: 'Lead' });

    expect(body).not.toContain('Queue empty');
    expect(body).not.toContain('class="progress');
  });
});

const partialEvidence = {
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
        },
      ],
    },
  ],
};

it('shows current partial evidence alongside an unavailable full match without promoting a legacy score', () => {
  const { body } = renderCard({
    id: 'opp-1',
    title: 'Engineer',
    latestScore: 99,
    partialAssessmentProjection: partialEvidence,
  });
  expect(body).toContain('Partial assessment');
  expect(body).toContain('Overall fit not yet established');
  expect(body).not.toContain('Match assessment unavailable');
  expect(body).not.toContain('No current assessment is available.');
  expect(body).not.toContain('Run Assess to assess this posting');
  expect(body).toContain('1 supported criterion of 1 assessed');
  expect(body).toContain('2 unresolved source clauses');
  expect(body).toContain('No overall fit conclusion.');
  expect(body).toContain('You must maintain tested API integrations.');
  expect(body).toContain('Maintained tested API integrations.');
  expect(body).not.toContain('99/100');
  expect(body).not.toContain('Strong match');
});

it.each([
  { ...partialEvidence, sourceStatus: 'stale' },
  { ...partialEvidence, criterionCount: 0 },
])('preserves unavailable assessment messaging for invalid partial proof (%j)', (partialAssessmentProjection) => {
  const { body } = renderCard({
    id: 'partial-stale',
    title: 'Engineer',
    partialAssessmentProjection,
  });
  expect(body).toContain('Match assessment unavailable');
  expect(body).not.toContain('Partial assessment');
  expect(body).not.toContain('Overall fit not yet established');
});

it('retains current full-assessment messaging when partial evidence is also present', () => {
  const { body } = renderCard({
    id: 'full-current',
    title: 'Engineer',
    partialAssessmentProjection: partialEvidence,
    assessmentProjection: {
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      matchReadiness: 'assessable',
      ranking: { fitScore: 72, eligibilityPriority: 0 },
      coverage: {
        candidateTruncated: false,
        postingTruncated: false,
        requirementsTruncated: false,
        requirementCount: 1,
      },
      reason: 'Current full assessment',
    },
  });
  expect(body).toContain('72/100');
  expect(body).not.toContain('Overall fit not yet established');
  expect(body).not.toContain('Partial assessment');
});

const sourceConditionalEligibility = {
  sourceStatus: 'current',
  sourceContentFingerprint: 'conditional-source',
  sourceContentVersion: 3,
  eligibilityBucket: 'location_restriction',
  reason: 'This role requires working in the United States.',
  conditionalPaths: [
    {
      kind: 'sponsorship',
      status: 'offered',
      facts: [
        {
          key: 'sponsorship_offered',
          citations: [
            {
              quote: 'We offer visa sponsorship.',
              start: 20,
              end: 46,
              hash: 'attested-hash',
            },
          ],
        },
      ],
    },
  ],
  unresolvedConstraintFactKeys: [],
};

it('shows the current posting restriction and sponsorship statement separately without granting authorization', () => {
  const { body } = renderCard({
    id: 'conditional',
    title: 'US role',
    sourceContentFingerprint: 'conditional-source',
    sourceContentVersion: 3,
    sourceEligibilityProjection: sourceConditionalEligibility,
  });
  expect(body).toContain('Posting work-location eligibility:');
  expect(body).toContain('Location or authorization restriction');
  expect(body).toContain('Sponsorship stated for this role');
  expect(body).toContain('We offer visa sponsorship.');
  expect(body).not.toContain('Eligible for your work location');
  expect(body).not.toContain('Canada eligible');
});

it('hides cached conditional paths when the captured posting has changed on reload', () => {
  const { body } = renderCard({
    id: 'conditional-stale',
    title: 'US role',
    sourceContentFingerprint: 'refreshed-source',
    sourceContentVersion: 4,
    sourceEligibilityProjection: sourceConditionalEligibility,
  });
  expect(body).not.toContain('Posting work-location eligibility:');
  expect(body).not.toContain('Sponsorship stated for this role');
  expect(body).not.toContain('We offer visa sponsorship.');
});
