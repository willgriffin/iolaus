import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  filterStateFromSearchParams,
} from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  attachOpportunityContext: vi.fn(async (records: unknown[]) => records),
  count: vi.fn(async () => 0),
  listAdminRecords: vi.fn(async () => [] as Record<string, unknown>[]),
  pageIds: vi.fn(async () => [] as string[]),
  requireAdminResource: vi.fn(() => ({ slug: 'opportunities' })),
}));

vi.mock('./admin-opportunity-query', () => ({
  countOpportunityRecords: mocks.count,
  listOpportunityPageIds: mocks.pageIds,
}));

vi.mock('./admin-data', () => ({
  listAdminRecords: mocks.listAdminRecords,
  requireAdminResource: mocks.requireAdminResource,
}));

vi.mock('./admin-resource-route', () => ({
  attachOpportunityContext: mocks.attachOpportunityContext,
}));

async function triage() {
  return await import('./opportunity-triage');
}

describe('opportunity triage preset', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.count.mockResolvedValue(0);
    mocks.pageIds.mockResolvedValue([]);
    mocks.listAdminRecords.mockResolvedValue([]);
  });

  it('forces the undecided, unarchived, unexpired, unstale, score-ordered queue', async () => {
    const { applyTriagePreset, TRIAGE_REVIEW_FILTER } = await triage();

    const filters = applyTriagePreset({
      ...DEFAULT_OPPORTUNITY_FILTERS,
      excludeExpired: false,
      excludeStale: false,
      // The list offers five sorts and the deck offers two; anything else the
      // operator carried in falls back to the deck's default.
      sort: 'salary',
      sortDirection: 'asc',
      // An inherited archived status must not survive into triage: the browse
      // query only drops archived rows when no explicit status is named.
      status: 'archived',
    });

    expect(TRIAGE_REVIEW_FILTER).toBe('unsorted');
    expect(filters.status).toBe('all');
    expect(filters.excludeExpired).toBe(true);
    expect(filters.excludeStale).toBe(true);
    expect(filters.sort).toBe('score');
    expect(filters.sortDirection).toBe('desc');
  });

  it('honours the deck two orderings, whoever chose one', async () => {
    const { applyTriagePreset, triageFiltersFromSearchParams } = await triage();

    // The deck's chooser, an agent's `sort` argument, and the deep link all
    // arrive here, and all three see the same two orderings.
    expect(applyTriagePreset(DEFAULT_OPPORTUNITY_FILTERS, 'newest').sort).toBe(
      'newest',
    );
    expect(applyTriagePreset(DEFAULT_OPPORTUNITY_FILTERS, 'rating').sort).toBe(
      'score',
    );
    expect(
      triageFiltersFromSearchParams(new URLSearchParams('sort=newest')).sort,
    ).toBe('newest');
    // Descending stays the deck's own: newest first, best match first.
    expect(
      triageFiltersFromSearchParams(new URLSearchParams('sort=newest'))
        .sortDirection,
    ).toBe('desc');
  });

  it('inherits every other filter dimension carried in from the list', async () => {
    const { triageFiltersFromSearchParams } = await triage();

    const filters = triageFiltersFromSearchParams(
      new URLSearchParams(
        'skill=Rust&workMode=remote&seniority=staff&minScore=70&status=found&sort=salary',
      ),
    );

    expect(filters.skills).toEqual(['Rust']);
    expect(filters.workModes).toEqual(['remote']);
    expect(filters.seniority).toBe('staff');
    expect(filters.minScore).toBe(70);
    expect(filters.status).toBe('all');
    expect(filters.sort).toBe('score');
  });

  it('round-trips excludeStale through the shared filter search params', () => {
    expect(
      filterStateFromSearchParams(new URLSearchParams('excludeStale=true'))
        .excludeStale,
    ).toBe(true);
    expect(DEFAULT_OPPORTUNITY_FILTERS.excludeStale).toBe(false);
  });
});

describe('loadTriageQueue', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.count.mockResolvedValue(0);
    mocks.pageIds.mockResolvedValue([]);
    mocks.listAdminRecords.mockResolvedValue([]);
    mocks.attachOpportunityContext.mockImplementation(
      async (records: unknown[]) => records,
    );
  });

  it('prefetches a bounded window and preserves the query order', async () => {
    const { loadTriageQueue, TRIAGE_QUEUE_SIZE } = await triage();
    mocks.count.mockResolvedValue(42);
    mocks.pageIds.mockResolvedValue(['b', 'a', 'c']);
    // Deliberately returned out of order: the id page owns the ordering.
    mocks.listAdminRecords.mockResolvedValue([
      { id: 'a', title: 'A' },
      { id: 'c', title: 'C' },
      { id: 'b', title: 'B' },
    ]);

    const queue = await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(mocks.pageIds).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: TRIAGE_QUEUE_SIZE,
        offset: 0,
        reviewFilter: 'unsorted',
      }),
    );
    expect(queue.total).toBe(42);
    expect(queue.candidates.map((record) => record.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('hydrates the card context without the activity trail', async () => {
    // Issue #452: the deck renders company and score and reads no part of the
    // `AgentRun`/`FactIntake` trail, which is the bulk of the payload the
    // operator waits on for the first card.
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(1);
    mocks.pageIds.mockResolvedValue(['opp-1']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-1' }]);

    await loadTriageQueue({ filters: DEFAULT_OPPORTUNITY_FILTERS });

    expect(mocks.attachOpportunityContext).toHaveBeenCalledWith(
      [{ id: 'opp-1' }],
      { includeActivity: false },
    );
  });

  it('reads a three-card window by default', async () => {
    const { TRIAGE_QUEUE_SIZE, loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(50);
    mocks.pageIds.mockResolvedValue([]);

    await loadTriageQueue({ filters: DEFAULT_OPPORTUNITY_FILTERS });

    expect(TRIAGE_QUEUE_SIZE).toBe(3);
    expect(mocks.pageIds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, offset: 0 }),
    );
  });

  it('never queries rows for an empty queue', async () => {
    const { loadTriageQueue, TRIAGE_QUEUE_SIZE } = await triage();
    mocks.count.mockResolvedValue(0);

    const queue = await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      offset: 25,
    });

    expect(queue).toEqual({
      candidates: [],
      limit: TRIAGE_QUEUE_SIZE,
      offset: 0,
      total: 0,
    });
    expect(mocks.pageIds).not.toHaveBeenCalled();
  });

  it('clamps an offset past the end of the queue onto the last card', async () => {
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(3);
    mocks.pageIds.mockResolvedValue([]);

    const queue = await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      offset: 900,
    });

    expect(queue.offset).toBe(2);
  });

  it('passes a trimmed search term through and drops an empty one', async () => {
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(0);

    await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      search: '  platform  ',
    });
    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'platform' }),
    );

    await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      search: ' ',
    });
    expect(mocks.count).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: undefined }),
    );
  });
});

describe('nextTriageCandidate', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.attachOpportunityContext.mockImplementation(
      async (records: unknown[]) => records,
    );
  });

  it('reports one-based position and remaining count for an offset', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.count.mockResolvedValue(10);
    mocks.pageIds.mockResolvedValue(['opp-4']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-4', title: 'Four' }]);

    const result = await nextTriageCandidate({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      offset: 3,
    });

    expect(mocks.pageIds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, offset: 3 }),
    );
    expect(result.candidate?.id).toBe('opp-4');
    expect(result.position).toBe(4);
    expect(result.remaining).toBe(7);
    expect(result.total).toBe(10);
  });

  it('never runs the admin context hydration on the agent path', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.count.mockResolvedValue(4);
    mocks.pageIds.mockResolvedValue(['opp-1']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-1', title: 'One' }]);

    // The hydration pass lists AgentRun and FactIntake, which the triage tool's
    // asserted operation set does not cover, and the tool discards every field
    // it would add.
    const result = await nextTriageCandidate({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(mocks.attachOpportunityContext).not.toHaveBeenCalled();
    expect(result.candidate?.id).toBe('opp-1');
  });

  it('hydrates the browser queue it does serve', async () => {
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(4);
    mocks.pageIds.mockResolvedValue(['opp-1']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-1', title: 'One' }]);

    await loadTriageQueue({ filters: DEFAULT_OPPORTUNITY_FILTERS });

    expect(mocks.attachOpportunityContext).toHaveBeenCalled();
  });

  it('terminates instead of re-serving the last candidate past the end', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.count.mockResolvedValue(3);
    mocks.pageIds.mockResolvedValue(['opp-3']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-3', title: 'Three' }]);

    // Raising the offset is the agent's only way to pass, and a null candidate
    // is its only stop signal, so a clamped offset would loop it forever.
    const result = await nextTriageCandidate({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      offset: 3,
    });

    expect(result).toEqual({
      candidate: null,
      position: 0,
      remaining: 0,
      total: 3,
    });
  });

  it('returns no candidate when the queue is exhausted', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.count.mockResolvedValue(0);
    mocks.pageIds.mockResolvedValue([]);

    const result = await nextTriageCandidate({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(result).toEqual({
      candidate: null,
      position: 0,
      remaining: 0,
      total: 0,
    });
  });
});
