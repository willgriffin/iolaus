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

describe('OpportunityCardList row expansion', () => {
  it('keeps the upstream expander button and its aria wiring', () => {
    // Expansion state is seeded client-side by DataTable, so SSR renders every
    // row collapsed; the chevron is CSS-only on the upstream button.
    const { body } = renderList();

    const buttons =
      body.match(/<button[^>]*data-table__expand-button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('aria-expanded="false"');
      expect(button).toMatch(/aria-controls="[^"]+"/);
    }
    expect(body).toContain('aria-label="Expand Staff engineer"');
    expect(body).toContain('aria-label="Expand Platform lead"');
  });

  it('does not render the relocated workflow forms for collapsed rows', () => {
    const { body } = renderList();

    expect(body).not.toContain('createDraftApplication');
    expect(body).not.toContain('createFactIntake');
  });
});
