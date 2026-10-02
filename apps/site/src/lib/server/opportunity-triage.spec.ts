import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  filterStateFromSearchParams,
} from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  assessmentProjections: vi.fn(async (_options: unknown) => new Map()),
  assessmentQueryContext: vi.fn(async () => ({
    assessmentCandidateMaterialFingerprint: 'candidate-material-test',
    assessmentPreferencesFingerprint: 'preferences-test',
  })),
  attachOpportunityContext: vi.fn(async (records: unknown[]) => records),
  count: vi.fn(async () => 0),
  citedSupport: vi.fn(async () => new Map()),
  sourceEligibility: vi.fn(async () => new Map()),
  dbConfig: vi.fn(() => ({ type: 'postgres' })),
  currentScores: vi.fn(async (_ids: string[]) => new Map()),
  listAdminRecords: vi.fn(async () => [] as Record<string, unknown>[]),
  opportunities: vi.fn(async () => [] as Record<string, unknown>[]),
  pageIds: vi.fn(async () => [] as string[]),
  requireAdminResource: vi.fn(() => ({ slug: 'opportunities' })),
  reviewOverlays: vi.fn(async () => new Map()),
}));

vi.mock('./admin-opportunity-query', () => ({
  countOpportunityRecords: mocks.count,
  listOpportunityPageIds: mocks.pageIds,
  loadCurrentCitedOpportunitySupport: mocks.citedSupport,
  loadCurrentSourceOpportunityEligibility: mocks.sourceEligibility,
  normalizeOpportunityRecommendation: (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '',
}));

vi.mock('./opportunity-assessment-store', () => ({
  loadCurrentOpportunityAssessmentProjections: mocks.assessmentProjections,
  loadOpportunityAssessmentQueryContext: mocks.assessmentQueryContext,
}));

vi.mock('./opportunity-review-overlay', () => ({
  loadCurrentOpportunityReviewOverlays: mocks.reviewOverlays,
}));

vi.mock('./admin-data', () => ({
  listAdminRecords: mocks.listAdminRecords,
  requireAdminResource: mocks.requireAdminResource,
}));

vi.mock('./admin-resource-route', () => ({
  attachOpportunityContext: mocks.attachOpportunityContext,
}));

vi.mock('./db', () => ({
  getDbConfig: mocks.dbConfig,
}));

vi.mock('./smrt', () => ({
  getCollection: async () => ({ list: mocks.opportunities }),
}));

async function triage() {
  return await import('./opportunity-triage');
}

const TEST_WORKSPACE_SUBJECT = {
  profileId: 'profile-test',
  tenantId: 'tenant-test',
  userId: 'user-test',
} as const;

function projection(score: unknown, recommendation: unknown) {
  return {
    ranking: {
      excluded:
        String(recommendation)
          .trim()
          .replaceAll(/[\u00a0\ufeff]/gu, '') === 'reject',
      fitScore: typeof score === 'number' ? score : null,
    },
  };
}

function installProjectionFromLegacyScoreFixture() {
  mocks.assessmentProjections.mockImplementation(async (options: unknown) => {
    const opportunities = (
      options as { opportunities: Array<{ id?: unknown }> }
    ).opportunities;
    const ids = opportunities
      .map((opportunity) =>
        typeof opportunity.id === 'string' ? opportunity.id : '',
      )
      .filter(Boolean);
    const scores = await mocks.currentScores(ids);
    return new Map(
      [...scores].map(([id, score]) => [
        id,
        projection(
          (score as { score?: unknown }).score,
          (score as { recommendation?: unknown }).recommendation,
        ),
      ]),
    );
  });
}

describe('opportunity triage preset', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.count.mockResolvedValue(0);
    mocks.citedSupport.mockResolvedValue(new Map());
    mocks.sourceEligibility.mockResolvedValue(new Map());
    mocks.pageIds.mockResolvedValue([]);
    mocks.listAdminRecords.mockResolvedValue([]);
    mocks.dbConfig.mockReturnValue({ type: 'postgres' });
    mocks.currentScores.mockResolvedValue(new Map());
    mocks.opportunities.mockResolvedValue([]);
    mocks.assessmentProjections.mockResolvedValue(new Map());
    mocks.reviewOverlays.mockResolvedValue(new Map());
    installProjectionFromLegacyScoreFixture();
  });

  for (const sortDirection of ['asc', 'desc'] as const) {
    it(`ranks current cited support ${sortDirection} before SQLite triage slices a page`, async () => {
      mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
      const partial = (supported: number) => ({
        version: 'opportunity-assessment-partial-projection/v1',
        mode: 'partial',
        sourceStatus: 'current',
        criterionCount: 7,
        supportedCriterionCount: supported,
        unresolvedSourceClauseCount: 15,
        requirements: Array.from({ length: 7 }, (_, index) => ({
          id: `r${index}`,
          text: `Requirement ${index}`,
          support: index < supported ? 'supported' : 'uncertain',
          postingCitations: [],
          candidateCitations: [],
        })),
      });
      mocks.opportunities.mockResolvedValue(
        ['missing', 'stale', 'seven', 'zero'].map((id) => ({
          id,
          status: 'found',
          sourceContentFingerprint: `fp-${id}`,
          sourceContentVersion: id === 'stale' ? 2 : 1,
          updatedAt: '2026-10-02',
          partialAssessmentProjection: partial(7),
          supportedCriterionCount: 99,
        })),
      );
      mocks.citedSupport.mockResolvedValue(
        new Map(
          ['stale', 'seven', 'zero'].map((id) => [
            id,
            {
              sourceContentFingerprint: `fp-${id}`,
              sourceContentVersion: 1,
              projection: partial(id === 'zero' ? 0 : 7),
            },
          ]),
        ),
      );
      const { loadTriageQueue } = await triage();
      const request = {
        context: 'list' as const,
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          sort: 'cited_support' as const,
          sortDirection,
        },
        hydrateContext: false,
        workspaceSubject: TEST_WORKSPACE_SUBJECT,
      };
      const first = await loadTriageQueue({ ...request, limit: 2, offset: 0 });
      const rest = await loadTriageQueue({ ...request, limit: 2, offset: 2 });
      expect(first.candidates.map((row) => row.id)).toEqual(
        sortDirection === 'asc' ? ['zero', 'seven'] : ['seven', 'zero'],
      );
      expect(rest.candidates.map((row) => row.id)).toEqual([
        'missing',
        'stale',
      ]);
      expect(
        rest.candidates.every(
          (row) => row.partialAssessmentProjection === null,
        ),
      ).toBe(true);
      expect(first.total).toBe(4);
      expect(mocks.citedSupport).toHaveBeenCalledWith(TEST_WORKSPACE_SUBJECT);
    });
  }

  it('uses sparse source/profile eligibility before SQLite filter and page selection, rejecting changed source identities and forged scalars', async () => {
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue(
      ['current', 'stale', 'forged'].map((id) => ({
        id,
        status: 'found',
        sourceContentFingerprint: `fp-${id}`,
        sourceContentVersion: id === 'stale' ? 2 : 1,
        sourceEligibilityProjection: {
          eligibilityBucket: 'eligible',
          sourceStatus: 'current',
        },
      })),
    );
    mocks.sourceEligibility.mockResolvedValue(
      new Map(
        ['current', 'stale'].map((id) => [
          id,
          {
            sourceContentFingerprint: `fp-${id}`,
            sourceContentVersion: 1,
            projection: {
              eligibilityBucket: 'eligible',
              sourceStatus: 'current',
              reason: 'Actual source/profile replay',
              unresolvedConstraintFactKeys: [],
            },
          },
        ]),
      ),
    );
    const { loadTriageQueue } = await triage();
    const result = await loadTriageQueue({
      context: 'list',
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        eligibilityBuckets: ['eligible'],
        sort: 'eligibility',
      },
      hydrateContext: false,
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      limit: 1,
    });
    expect(result.total).toBe(1);
    expect(result.candidates.map((row) => row.id)).toEqual(['current']);
    expect(mocks.sourceEligibility).toHaveBeenCalledWith(
      TEST_WORKSPACE_SUBJECT,
    );
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

  it('keeps the agent-supported recency override', async () => {
    const { applyTriagePreset, triageFiltersFromSearchParams } = await triage();

    expect(applyTriagePreset(DEFAULT_OPPORTUNITY_FILTERS, 'newest').sort).toBe(
      'newest',
    );
    expect(applyTriagePreset(DEFAULT_OPPORTUNITY_FILTERS, 'rating').sort).toBe(
      'score',
    );
  });

  it('keeps every list filter and sort dimension verbatim for browser triage', async () => {
    const { triageFiltersFromSearchParams } = await triage();

    const filters = triageFiltersFromSearchParams(
      new URLSearchParams(
        'skill=Rust&workMode=remote&seniority=staff&minScore=70&status=found&sort=salary&sortDirection=asc&excludeExpired=true&excludeStale=true',
      ),
    );

    expect(filters.skills).toEqual(['Rust']);
    expect(filters.workModes).toEqual(['remote']);
    expect(filters.seniority).toBe('staff');
    expect(filters.minScore).toBe(70);
    expect(filters.status).toBe('found');
    expect(filters.sort).toBe('salary');
    expect(filters.sortDirection).toBe('asc');
    expect(filters.excludeExpired).toBe(true);
    expect(filters.excludeStale).toBe(true);
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
    mocks.dbConfig.mockReturnValue({ type: 'postgres' });
    mocks.currentScores.mockResolvedValue(new Map());
    mocks.opportunities.mockResolvedValue([]);
    mocks.assessmentProjections.mockResolvedValue(new Map());
    mocks.reviewOverlays.mockResolvedValue(new Map());
    installProjectionFromLegacyScoreFixture();
    mocks.attachOpportunityContext.mockImplementation(
      async (records: unknown[]) => records,
    );
    mocks.dbConfig.mockReturnValue({ type: 'postgres' });
    mocks.opportunities.mockResolvedValue([]);
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
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
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

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(mocks.attachOpportunityContext).toHaveBeenCalledWith(
      [{ id: 'opp-1' }],
      { includeActivity: false, workspaceSubject: TEST_WORKSPACE_SUBJECT },
    );
  });

  it('passes the verified workspace subject into the card hydration', async () => {
    const { loadTriageQueue } = await triage();
    const subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    mocks.count.mockResolvedValue(1);
    mocks.pageIds.mockResolvedValue(['opp-1']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-1' }]);

    await loadTriageQueue({
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      workspaceSubject: subject,
    });

    expect(mocks.attachOpportunityContext).toHaveBeenCalledWith(
      [{ id: 'opp-1' }],
      { includeActivity: false, workspaceSubject: subject },
    );
  });

  it('reads a three-card window by default', async () => {
    const { TRIAGE_QUEUE_SIZE, loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(50);
    mocks.pageIds.mockResolvedValue([]);

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(TRIAGE_QUEUE_SIZE).toBe(3);
    expect(mocks.pageIds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, offset: 0 }),
    );
  });

  it('never queries rows for an empty queue', async () => {
    const { loadTriageQueue, TRIAGE_QUEUE_SIZE } = await triage();
    mocks.count.mockResolvedValue(0);

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
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
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      offset: 900,
    });

    expect(queue.offset).toBe(2);
  });

  it('passes a trimmed search term through and drops an empty one', async () => {
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(0);

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      search: '  platform  ',
    });
    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'platform' }),
    );

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      search: ' ',
    });
    expect(mocks.count).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: undefined }),
    );
  });

  it.each(
    (['best', 'newest', 'score', 'salary', 'rating'] as const).flatMap((sort) =>
      (['asc', 'desc'] as const).map((sortDirection) => ({
        sort,
        sortDirection,
      })),
    ),
  )('keeps list $sort/$sortDirection query ordering without agent reject de-priority', async ({
    sort,
    sortDirection,
  }) => {
    const { loadTriageQueue } = await triage();
    mocks.count.mockResolvedValue(0);

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      context: 'list',
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort, sortDirection },
    });

    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ sort, sortDirection }),
        reviewFilter: 'unsorted',
        triageRejectDepriority: false,
      }),
    );
  });

  it('applies inherited list filters to the SQLite queue before sorting', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      {
        id: 'matches-list-context',
        status: 'found',
        title: 'Platform Rust Engineer',
        descriptionSummary: 'Platform services',
        requiredSkills: 'Rust, TypeScript',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
      {
        id: 'wrong-skill',
        status: 'found',
        title: 'Platform Rust Engineer',
        requiredSkills: 'Java',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
      {
        id: 'wrong-search',
        status: 'found',
        title: 'Infrastructure Engineer',
        requiredSkills: 'Rust',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
      {
        id: 'wrong-status',
        status: 'recommended',
        title: 'Platform Rust Engineer',
        requiredSkills: 'Rust',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
      {
        id: 'expired',
        status: 'found',
        title: 'Platform Rust Engineer',
        requiredSkills: 'Rust',
        expiresAt: '2000-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
      {
        id: 'stale',
        status: 'found',
        title: 'Platform Rust Engineer',
        requiredSkills: 'Rust',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'stale',
      },
      {
        id: 'decided',
        humanReviewStatus: 'apply',
        status: 'found',
        title: 'Platform Rust Engineer',
        requiredSkills: 'Rust',
        expiresAt: '2099-01-01T00:00:00.000Z',
        freshness: 'fresh',
      },
    ]);

    mocks.reviewOverlays.mockResolvedValue(
      new Map([['decided', { humanReviewStatus: 'apply' }]]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      context: 'list',
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        excludeExpired: true,
        excludeStale: true,
        skills: ['Rust'],
        status: 'found',
      },
      limit: 10,
      search: 'platform',
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'matches-list-context',
    ]);
  });

  it.each([
    {
      sort: 'best' as const,
      sortDirection: 'asc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unknown-90',
        'reject-20',
        'unscored',
      ],
    },
    {
      sort: 'best' as const,
      sortDirection: 'desc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unknown-90',
        'reject-20',
        'unscored',
      ],
    },
    {
      sort: 'newest' as const,
      sortDirection: 'asc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unscored',
        'unknown-90',
        'reject-20',
      ],
    },
    {
      sort: 'newest' as const,
      sortDirection: 'desc' as const,
      expected: [
        'reject-20',
        'unknown-90',
        'unscored',
        'recommend-96',
        'reject-100',
      ],
    },
    {
      sort: 'score' as const,
      sortDirection: 'asc' as const,
      expected: [
        'reject-20',
        'unknown-90',
        'recommend-96',
        'reject-100',
        'unscored',
      ],
    },
    {
      sort: 'score' as const,
      sortDirection: 'desc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unknown-90',
        'reject-20',
        'unscored',
      ],
    },
    {
      sort: 'salary' as const,
      sortDirection: 'asc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unknown-90',
        'unscored',
        'reject-20',
      ],
    },
    {
      sort: 'salary' as const,
      sortDirection: 'desc' as const,
      expected: [
        'reject-20',
        'unscored',
        'unknown-90',
        'recommend-96',
        'reject-100',
      ],
    },
    {
      sort: 'rating' as const,
      sortDirection: 'asc' as const,
      expected: [
        'reject-100',
        'recommend-96',
        'unknown-90',
        'unscored',
        'reject-20',
      ],
    },
    {
      sort: 'rating' as const,
      sortDirection: 'desc' as const,
      expected: [
        'reject-20',
        'unscored',
        'unknown-90',
        'recommend-96',
        'reject-100',
      ],
    },
  ])('uses the SQLite list $sort/$sortDirection ordering', async ({
    sort,
    sortDirection,
    expected,
  }) => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      {
        id: 'unscored',
        humanRating: 4,
        postedAt: '2026-01-03T00:00:00.000Z',
        salaryMin: 400,
        status: 'recommended',
      },
      {
        id: 'reject-20',
        humanRating: 5,
        postedAt: '2026-01-05T00:00:00.000Z',
        salaryMin: 500,
        status: 'recommended',
      },
      {
        id: 'recommend-96',
        humanRating: 2,
        postedAt: '2026-01-02T00:00:00.000Z',
        salaryMin: 200,
        status: 'recommended',
      },
      {
        id: 'reject-100',
        humanRating: 1,
        postedAt: '2026-01-01T00:00:00.000Z',
        salaryMin: 100,
        status: 'recommended',
      },
      {
        id: 'unknown-90',
        humanRating: 3,
        postedAt: '2026-01-04T00:00:00.000Z',
        salaryMin: 300,
        status: 'recommended',
      },
    ]);
    mocks.currentScores.mockResolvedValue(
      new Map([
        ['reject-100', { recommendation: 'reject', score: 100 }],
        ['recommend-96', { recommendation: 'recommend', score: 96 }],
        ['unknown-90', { recommendation: 'unknown', score: 90 }],
        ['reject-20', { recommendation: 'reject', score: 20 }],
      ]),
    );
    mocks.reviewOverlays.mockResolvedValue(
      new Map([
        ['unscored', { humanRating: 4, humanReviewStatus: 'needs_input' }],
        ['reject-20', { humanRating: 5, humanReviewStatus: 'needs_input' }],
        ['recommend-96', { humanRating: 2, humanReviewStatus: 'needs_input' }],
        ['reject-100', { humanRating: 1, humanReviewStatus: 'needs_input' }],
        ['unknown-90', { humanRating: 3, humanReviewStatus: 'needs_input' }],
      ]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      context: 'list',
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort, sortDirection },
      limit: 5,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual(expected);
  });

  it.each([
    { sort: 'score' as const, sortDirection: 'asc' as const },
    { sort: 'score' as const, sortDirection: 'desc' as const },
    { sort: 'salary' as const, sortDirection: 'asc' as const },
    { sort: 'salary' as const, sortDirection: 'desc' as const },
  ])('keeps missing $sort values last and breaks tied values by update time then id ($sortDirection)', async ({
    sort,
    sortDirection,
  }) => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      {
        id: 'z-tie',
        salaryMin: 100,
        status: 'recommended',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'missing',
        status: 'recommended',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'a-tie',
        salaryMin: 100,
        status: 'recommended',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mocks.reviewOverlays.mockResolvedValue(
      new Map([
        ['already-decided', { humanReviewStatus: 'apply' }],
        ['triageable', { humanReviewStatus: 'needs_input' }],
      ]),
    );
    mocks.currentScores.mockResolvedValue(
      new Map([
        ['a-tie', { recommendation: 'recommend', score: 50 }],
        ['z-tie', { recommendation: 'recommend', score: 50 }],
      ]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      context: 'list',
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort, sortDirection },
      limit: 3,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'a-tie',
      'z-tie',
      'missing',
    ]);
  });
});

describe('nextTriageCandidate', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.attachOpportunityContext.mockImplementation(
      async (records: unknown[]) => records,
    );
    mocks.count.mockResolvedValue(0);
    mocks.currentScores.mockResolvedValue(new Map());
    mocks.assessmentProjections.mockResolvedValue(new Map());
    mocks.reviewOverlays.mockResolvedValue(new Map());
    installProjectionFromLegacyScoreFixture();
    mocks.dbConfig.mockReturnValue({ type: 'postgres' });
    mocks.opportunities.mockResolvedValue([]);
    mocks.pageIds.mockResolvedValue([]);
  });

  it('reports one-based position and remaining count for an offset', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.count.mockResolvedValue(10);
    mocks.pageIds.mockResolvedValue(['opp-4']);
    mocks.listAdminRecords.mockResolvedValue([{ id: 'opp-4', title: 'Four' }]);

    const result = await nextTriageCandidate({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
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
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
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

    await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

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
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
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
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
    });

    expect(result).toEqual({
      candidate: null,
      position: 0,
      remaining: 0,
      total: 0,
    });
  });

  it('uses the bounded local queue on SQLite instead of Postgres-only query helpers', async () => {
    const { nextTriageCandidate } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      {
        id: 'already-decided',
        humanReviewStatus: 'apply',
        status: 'recommended',
        title: 'Fictional Staff Engineer',
      },
      {
        freshness: 'fresh',
        humanReviewStatus: 'needs_input',
        id: 'triageable',
        status: 'recommended',
        title: 'Fictional Staff Engineer',
      },
    ]);
    mocks.reviewOverlays.mockResolvedValue(
      new Map([
        ['already-decided', { humanReviewStatus: 'apply' }],
        ['triageable', { humanReviewStatus: 'needs_input' }],
      ]),
    );

    const result = await nextTriageCandidate({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      search: 'staff engineer',
    });

    expect(result.candidate?.id).toBe('triageable');
    expect(result.total).toBe(1);
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.pageIds).not.toHaveBeenCalled();
  });

  it('puts current explicit rejects after recommended and unscored SQLite cards', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    // Reverse source order to prove queue order comes from the hydrated current
    // score context, before filtering, ranking, and pagination.
    mocks.opportunities.mockResolvedValue([
      { id: 'reject-100', status: 'recommended', title: 'Reject 100' },
      { id: 'unscored', status: 'recommended', title: 'Unscored' },
      { id: 'recommend-96', status: 'recommended', title: 'Recommend 96' },
    ]);
    mocks.currentScores.mockResolvedValue(
      new Map([
        ['reject-100', { recommendation: '\treject\n', score: 100 }],
        ['recommend-96', { recommendation: 'recommend', score: 96 }],
      ]),
    );

    const firstPage = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 2,
    });
    const lastCard = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 1,
      offset: 2,
    });

    expect(firstPage.candidates.map((record) => record.id)).toEqual([
      'recommend-96',
      'unscored',
    ]);
    expect(lastCard.candidates.map((record) => record.id)).toEqual([
      'reject-100',
    ]);
    expect(mocks.currentScores).toHaveBeenCalledWith([
      'reject-100',
      'unscored',
      'recommend-96',
    ]);
  });

  it('keeps numeric score order for SQLite list-context triage', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      { id: 'recommend-96', status: 'recommended' },
      { id: 'reject-100', status: 'recommended' },
    ]);
    mocks.currentScores.mockResolvedValue(
      new Map([
        ['reject-100', { recommendation: 'reject', score: 100 }],
        ['recommend-96', { recommendation: 'recommend', score: 96 }],
      ]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      context: 'list',
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' },
      limit: 2,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'reject-100',
      'recommend-96',
    ]);
  });

  it('does not treat an outdated score as a current SQLite reject', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      { id: 'current-reject', status: 'recommended', title: 'Current reject' },
      {
        id: 'outdated-reject',
        status: 'recommended',
        title: 'Outdated reject',
      },
    ]);
    // The query helper excludes a score whose source-content fingerprint no
    // longer matches, so it is absent rather than becoming a stale reject.
    mocks.currentScores.mockResolvedValue(
      new Map([['current-reject', { recommendation: 'reject', score: 1 }]]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 2,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'outdated-reject',
      'current-reject',
    ]);
  });

  it('recognizes NBSP and BOM-wrapped SQLite machine rejects', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      { id: 'reject-20', status: 'recommended' },
      { id: 'recommend-96', status: 'recommended' },
    ]);
    mocks.currentScores.mockResolvedValue(
      new Map([
        [
          'reject-20',
          { recommendation: '\u00a0\ufeffreject\u00a0', score: 20 },
        ],
        ['recommend-96', { recommendation: 'recommend', score: 96 }],
      ]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 2,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'recommend-96',
      'reject-20',
    ]);
  });

  it('leaves SQLite newest triage ordering unchanged', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.opportunities.mockResolvedValue([
      {
        id: 'newer-reject',
        postedAt: '2026-01-02T00:00:00.000Z',
        status: 'recommended',
      },
      {
        id: 'older-recommend',
        postedAt: '2026-01-01T00:00:00.000Z',
        status: 'recommended',
      },
    ]);
    mocks.currentScores.mockResolvedValue(
      new Map([
        ['newer-reject', { recommendation: 'reject', score: 100 }],
        ['older-recommend', { recommendation: 'recommend', score: 1 }],
      ]),
    );

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'newest' },
      limit: 2,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'newer-reject',
      'older-recommend',
    ]);
  });

  it('breaks equal unscored SQLite cards by update time and id', async () => {
    const { loadTriageQueue } = await triage();
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    // Reversed source order must not leak into a tied, unscored score page.
    mocks.opportunities.mockResolvedValue([
      {
        id: 'z-unscored',
        status: 'recommended',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'a-unscored',
        status: 'recommended',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mocks.currentScores.mockResolvedValue(new Map());

    const queue = await loadTriageQueue({
      workspaceSubject: TEST_WORKSPACE_SUBJECT,
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 2,
    });

    expect(queue.candidates.map((record) => record.id)).toEqual([
      'a-unscored',
      'z-unscored',
    ]);
  });
});
