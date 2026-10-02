import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { createAdminListPagination } from '$lib/admin/pagination';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import OpportunityCardList from './OpportunityCardList.svelte';

vi.mock('$app/state', () => ({
  page: {
    url: new URL(
      'http://localhost/admin/opportunities?review=unsorted&skill=Rust&workMode=remote&page=3',
    ),
  },
}));

const reviewStatuses = [
  { className: 'interested', label: 'Interested', value: 'interested' },
  { className: 'pass', label: 'Pass', value: 'pass' },
] as const;

function renderList(
  props: Partial<
    Parameters<typeof render<typeof OpportunityCardList>>[1]['props']
  > = {},
) {
  return render(OpportunityCardList, {
    props: {
      activeReviewFilter: 'unsorted',
      candidateSkills: [],
      filterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
      pagination: createAdminListPagination(2, 1, 50),
      records: [
        { id: 'opp-1', title: 'Staff engineer', humanReviewStatus: '' },
        { id: 'opp-2', title: 'Platform lead', humanReviewStatus: '' },
      ],
      reviewFilters: [{ label: 'Unsorted', value: 'unsorted' }],
      reviewStatuses,
      ...props,
    },
  });
}

describe('OpportunityCardList assessment readiness', () => {
  it.each([
    {
      matchReadiness: 'assessable',
      requirementCount: 4,
      candidateTruncated: false,
      label: '72/100',
      message: '',
    },
    {
      matchReadiness: 'needs_extraction',
      requirementCount: 0,
      candidateTruncated: false,
      label: 'Needs extraction',
      message: 'No structured role requirements were extracted.',
    },
    {
      matchReadiness: 'needs_evidence',
      requirementCount: 4,
      candidateTruncated: true,
      label: 'Needs evidence',
      message: 'Candidate evidence was truncated.',
    },
  ])('shows $label from the safe assessment without using a legacy score', ({
    matchReadiness,
    requirementCount,
    candidateTruncated,
    label,
    message,
  }) => {
    const { body } = renderList({
      records: [
        {
          id: 'opp-1',
          title: 'Staff engineer',
          latestScore: 99,
          assessmentProjection: {
            sourceStatus: 'current',
            eligibilityBucket: 'unknown',
            matchReadiness,
            coverage: {
              requirementCount,
              candidateTruncated,
              postingTruncated: false,
              requirementsTruncated: false,
            },
            ranking: { eligibilityPriority: 2, fitScore: 72 },
            reason: 'Eligibility needs clarification',
          },
        },
      ],
    });
    expect(body).toContain(label);
    if (message) expect(body).toContain(message);
    expect(body).toContain('Unknown');
    expect(body).not.toContain('99/100');
    if (matchReadiness !== 'assessable') expect(body).not.toContain('72/100');
  });
});

describe('OpportunityCardList triage', () => {
  it('opens the deck as a modal over the list rather than navigating away', () => {
    const { body } = renderList();

    // The list is the context and owns the filter, so Triage is a button on
    // this page, not a link to a route of its own.
    expect(body).not.toContain('/admin/opportunities/triage');
    expect(body).toMatch(
      /<button[^>]*class="triage-link[^"]*"[^>]*>[\s\S]*?Triage/,
    );
    expect(body).toContain('aria-label="Triage opportunities"');
  });

  it('renders the deck footer verdicts inside the dialog, not on the page', () => {
    const { body } = renderList();

    const dialogAt = body.indexOf('aria-label="Triage opportunities"');
    expect(dialogAt).toBeGreaterThan(-1);
    for (const label of ['Nope', 'Later', 'Dig deeper']) {
      expect(body.indexOf(label)).toBeGreaterThan(dialogAt);
    }
    // The deck's own bar is gone: nothing outside the dialog is viewport-fixed.
    expect(body).not.toContain('class="action-bar"');
  });
});

describe('OpportunityCardList selection', () => {
  it('renders a checkbox per row plus a header select-all when wired for bulk selection', () => {
    // DataTable seeds its selection controller client-side, so SSR cannot
    // assert `checked`; it can assert the selection column is present.
    const { body } = renderList({
      onSelectedIdsChange: () => undefined,
      selectedIds: new Set(['opp-2']),
    });

    const checkboxes = body.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes).toHaveLength(3);
    expect(body).toContain('aria-label="Select all rows on this page"');
    expect(body).toContain('aria-label="Select Staff engineer"');
    expect(body).toContain('aria-label="Select Platform lead"');
  });

  it('marks rows interactive for dock selection and flags the dock-selected row', () => {
    const { body } = renderList({
      dockSelectedId: 'opp-1',
      onSelectRecord: () => undefined,
    });

    const rowOpen = (id: string) =>
      body
        .slice(0, body.indexOf(`data-row-id="string:${id}"`))
        .split('<tr')
        .at(-1) ?? '';
    expect(rowOpen('opp-1')).toContain('data-table__row--interactive');
    expect(rowOpen('opp-1')).toContain('dock-selected');
    expect(rowOpen('opp-2')).toContain('data-table__row--interactive');
    expect(rowOpen('opp-2')).not.toContain('dock-selected');
  });

  it('renders the toolbar snippet above the rows', () => {
    const { body } = renderList({
      toolbar: createRawSnippet(() => ({
        render: () => '<form class="bulk-review-form">Bulk review</form>',
      })),
    });

    const toolbarAt = body.indexOf('bulk-review-form');
    expect(toolbarAt).toBeGreaterThan(-1);
    expect(toolbarAt).toBeLessThan(body.indexOf('data-row-id="string:opp-1"'));
  });
});

describe('OpportunityCardList bulk selection summary', () => {
  it('renders an "N selected · Clear" summary in the toolbar row when rows are checked', () => {
    const { body } = renderList({
      onSelectedIdsChange: () => undefined,
      selectedIds: new Set(['opp-1', 'opp-2']),
    });

    expect(body).toContain('2 selected');
    const summaryAt = body.indexOf('selection-summary');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(body.indexOf('data-row-id="string:opp-1"'));
    expect(body).toMatch(
      /<button[^>]*class="selection-clear[^"]*"[^>]*>\s*Clear/,
    );
  });

  it('omits the summary when nothing is checked', () => {
    const { body } = renderList({ onSelectedIdsChange: () => undefined });

    expect(body).not.toContain('selection-summary');
    expect(body).not.toContain('selected</strong>');
  });

  it('keeps focus separate from selection and mutes the focus bar while rows are checked', () => {
    const rowOpen = (body: string, id: string) =>
      body
        .slice(0, body.indexOf(`data-row-id="string:${id}"`))
        .split('<tr')
        .at(-1) ?? '';

    const unmuted = renderList({
      dockSelectedId: 'opp-1',
      onSelectRecord: () => undefined,
      onSelectedIdsChange: () => undefined,
      selectedIds: new Set(),
    }).body;
    expect(rowOpen(unmuted, 'opp-1')).toContain('dock-selected');
    expect(rowOpen(unmuted, 'opp-1')).not.toContain('dock-selected--muted');

    const muted = renderList({
      dockSelectedId: 'opp-1',
      onSelectRecord: () => undefined,
      onSelectedIdsChange: () => undefined,
      selectedIds: new Set(['opp-2']),
    }).body;
    expect(rowOpen(muted, 'opp-1')).toContain('dock-selected--muted');
    expect(rowOpen(muted, 'opp-2')).not.toContain('dock-selected');
  });
});

describe('OpportunityCardList one-opportunity review rows', () => {
  it('uses accessible upstream row activation without an expansion column', () => {
    const { body } = renderList();
    expect(body).not.toContain('data-table__expand-button');
    expect(body).not.toContain('Expand Staff engineer');
    expect(body).not.toContain('opportunity-expanded');
    expect(body).toContain('data-table__row--interactive');
    expect(body).toMatch(/<tr[^>]*tabindex="0"/);
    expect(body).toMatch(
      /<span class="title-link(?:\s+[^"\s]+)*">[\s\S]*?Staff engineer/,
    );
  });

  it('keeps external posting navigation and checkbox selection outside row review', () => {
    const { body } = renderList({
      records: [
        {
          id: 'opp-1',
          title: 'Staff engineer',
          postingUrl: 'https://employer.example/jobs/1',
        },
      ],
      onSelectedIdsChange: () => undefined,
    });
    expect(body).toContain('href="https://employer.example/jobs/1"');
    expect(body).toContain('aria-label="View posting"');
    expect(body).toContain('aria-label="Select Staff engineer"');
    expect(body).not.toContain('data-table__expand-button');
  });

  it('does not duplicate application and fact forms in the row view', () => {
    const { body } = renderList();

    expect(body).not.toContain('createDraftApplication');
    expect(body).not.toContain('createFactIntake');
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
  const { body } = renderList({
    records: [
      {
        id: 'opp-1',
        title: 'Engineer',
        latestScore: 99,
        partialAssessmentProjection: partialEvidence,
      },
    ],
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
  const { body } = renderList({
    records: [
      { id: 'partial-stale', title: 'Engineer', partialAssessmentProjection },
    ],
  });
  expect(body).toContain('Match assessment unavailable');
  expect(body).not.toContain('Partial assessment');
  expect(body).not.toContain('Overall fit not yet established');
});

it('retains current full-assessment messaging when partial evidence is also present', () => {
  const { body } = renderList({
    records: [
      {
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
      },
    ],
  });
  expect(body).toContain('72/100');
  expect(body).not.toContain('Overall fit not yet established');
  expect(body).not.toContain('Partial assessment');
});

it('offers a separate Cited support sort and column while showing assessed and unresolved counts', () => {
  const { body } = renderList({
    records: [
      {
        id: 'cited',
        title: 'Engineer',
        partialAssessmentProjection: partialEvidence,
      },
      {
        id: 'unknown',
        title: 'Unknown role',
        assessmentJson: JSON.stringify(partialEvidence),
      },
    ],
  });
  expect(body).toContain('value="cited_support"');
  expect(body).toContain('Cited support');
  expect(body).toContain('1 supported criterion of 1 assessed');
  expect(body).toContain('2 unresolved source clauses');
  expect(body).toContain('No current cited support assessment');
  expect(body).toContain('No overall fit conclusion.');
  expect(body).not.toContain('100%');
});
