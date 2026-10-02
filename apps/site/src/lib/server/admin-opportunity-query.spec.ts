import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  dbConfig: vi.fn(() => ({})),
  query: vi.fn(),
  requestDatabase: vi.fn(),
  scopedQuery: vi.fn(),
}));

const WORKSPACE_SUBJECT = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
} as const;

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ query: mocks.query })),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: mocks.requestDatabase,
}));

vi.mock('./db.js', () => ({
  getDbConfig: mocks.dbConfig,
}));

describe('admin-opportunity-query', () => {
  beforeEach(() => {
    mocks.dbConfig.mockReset();
    mocks.dbConfig.mockReturnValue({});
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.requestDatabase.mockReset();
    mocks.requestDatabase.mockReturnValue(undefined);
    mocks.scopedQuery.mockReset();
    mocks.scopedQuery.mockResolvedValue({ rows: [] });
  });

  it('keeps browser-facing raw queries on the request-scoped database', async () => {
    mocks.requestDatabase.mockReturnValue({ query: mocks.scopedQuery });
    const {
      countOpportunityRecords,
      listLatestOpportunityRelatedContext,
      listOpportunityPageIds,
    } = await import('./admin-opportunity-query');

    await countOpportunityRecords({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    await listOpportunityPageIds({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 10,
      offset: 0,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    await listLatestOpportunityRelatedContext(
      ['11111111-1111-4111-8111-111111111111'],
      WORKSPACE_SUBJECT,
    );

    expect(mocks.scopedQuery).toHaveBeenCalledTimes(3);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('drops no-longer-seen postings when a caller opts into excludeStale', async () => {
    const { countOpportunityRecords } = await import(
      './admin-opportunity-query'
    );

    await countOpportunityRecords({
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, excludeStale: true },
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [staleSql] = mocks.query.mock.calls[0] ?? [];
    expect(staleSql).toContain("<> 'stale'");

    mocks.query.mockClear();
    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const [defaultSql] = mocks.query.mock.calls[0] ?? [];
    expect(defaultSql).not.toContain("<> 'stale'");
  });

  it('uses current private eligibility projections with legacy bucket aliases', async () => {
    const { createOpportunityWhereSql } = await import(
      './admin-opportunity-query'
    );
    const query = createOpportunityWhereSql({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        eligibilityBuckets: ['eligible', 'sponsorship_possible'],
      },
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    expect(query.whereSql).toContain('latest_assessment.eligibility_bucket');
    expect(query.joins.join('\n')).toContain('opportunity_assessments');
    expect(query.values).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['eligible', 'sponsorship_possible']),
      ]),
    );
  });

  it('hides archived opportunities unless a status filter asks for them', async () => {
    const { countOpportunityRecords, listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 10,
      offset: 0,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const [defaultSql, ...defaultValues] = mocks.query.mock.calls[0] ?? [];
    expect(defaultSql).toMatch(/o\.status <> \$\d+/);
    expect(defaultValues).toContain('archived');

    mocks.query.mockClear();
    await countOpportunityRecords({
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, status: 'archived' },
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const [archivedSql, ...archivedValues] = mocks.query.mock.calls[0] ?? [];
    expect(archivedSql).toMatch(/o\.status = \$\d+/);
    expect(archivedSql).not.toMatch(/o\.status <> \$\d+/);
    expect(archivedValues).toContain('archived');
  });

  it('only sorts with an exact current assessment projection', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
      },
      limit: 25,
      offset: 0,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('FROM opportunity_assessments oa');
    expect(sql).toContain(
      'oa.source_content_fingerprint = COALESCE(o.source_content_fingerprint',
    );
    expect(sql).toContain(
      'oa.source_content_version = COALESCE(o.source_content_version',
    );
    expect(sql).toContain('oa.candidate_material_fingerprint');
    expect(sql).toContain('oa.preferences_fingerprint');
    expect(sql).not.toContain('FROM evaluation_scores es');
  });

  it('uses the requested direction for a supported server sort', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
        sortDirection: 'asc',
      },
      limit: 25,
      offset: 0,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain(
      "ORDER BY CASE WHEN latest_assessment.match_readiness = 'assessable' THEN latest_assessment.fit_score ELSE NULL END ASC NULLS LAST",
    );
  });

  it('deprioritizes current excluded assessments for score-sorted triage', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' },
      limit: 25,
      offset: 0,
      reviewFilter: 'unsorted',
      triageRejectDepriority: true,
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const [triageSql] = mocks.query.mock.calls[0] ?? [];
    expect(triageSql).toContain(
      'CASE WHEN latest_assessment.excluded THEN 1 ELSE 0 END',
    );
    expect(triageSql).toContain(
      "CASE WHEN latest_assessment.match_readiness = 'assessable' THEN latest_assessment.fit_score ELSE NULL END DESC NULLS LAST",
    );
    expect(triageSql).toContain('FROM opportunity_assessments oa');
    expect(triageSql).not.toContain('FROM evaluation_scores es');

    mocks.query.mockClear();
    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' },
      limit: 25,
      offset: 0,
      reviewFilter: 'unsorted',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const [browseSql] = mocks.query.mock.calls[0] ?? [];
    expect(browseSql).not.toContain('CASE WHEN latest_assessment.excluded');
  });

  it('uses SQLite-compatible review normalization and score join locally', async () => {
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
      },
      limit: 25,
      offset: 0,
      reviewFilter: 'maybe',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql, ...values] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('LEFT JOIN decisions latest_review');
    expect(sql).toContain("latest_review.decision = 'defer'");
    expect(sql).toContain('d.tenant_id = $3');
    expect(sql).not.toContain('o.human_review_status');
    expect(sql).toContain(
      'LEFT JOIN opportunity_assessments latest_assessment',
    );
    expect(sql).toContain('latest_assessment.id = (');
    expect(sql).not.toContain('LEFT JOIN LATERAL');
    expect(values).toContain('maybe');
  });

  it('uses SQLite assessment projection ranking for triage', async () => {
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' },
      limit: 25,
      offset: 0,
      reviewFilter: 'unsorted',
      triageRejectDepriority: true,
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain(
      'CASE WHEN latest_assessment.excluded THEN 1 ELSE 0 END',
    );
    expect(sql).toContain(
      "CASE WHEN latest_assessment.match_readiness = 'assessable' THEN latest_assessment.fit_score ELSE NULL END DESC NULLS LAST",
    );
  });

  it('loads only fingerprint-current score context for bounded SQLite triage ids', async () => {
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.query.mockResolvedValue({
      rows: [
        {
          opportunityId: 'recommend-96',
          recommendation: ' Recommend ',
          score: 96,
        },
        { opportunityId: 'unrequested', recommendation: 'reject', score: 100 },
      ],
    });
    const { listCurrentOpportunityScores } = await import(
      './admin-opportunity-query'
    );

    const scores = await listCurrentOpportunityScores(
      ['recommend-96', 'outdated-reject'],
      WORKSPACE_SUBJECT,
    );

    expect(scores).toEqual(
      new Map([['recommend-96', { recommendation: 'recommend', score: 96 }]]),
    );
    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('LEFT JOIN evaluation_scores latest');
    expect(sql).toContain('latest.id = (');
    expect(sql).toContain('WHERE CAST(o.id AS TEXT) IN ($1, $2)');
    expect(sql).toContain('es.tenant_id = $3');
    expect(sql).toContain('es.owner_user_id = $4');
    expect(sql).toContain('es.candidate_profile_id = $5');
    expect(sql).toMatch(
      /COALESCE\(es\.source_content_fingerprint, ''\) =\s+COALESCE\(o\.source_content_fingerprint, ''\)/,
    );
  });

  it('creates query indexes concurrently on a timeout-bound pinned session', async () => {
    const release = vi.fn(async () => {});
    const sessionQuery = vi.fn(async () => ({ rows: [] }));
    const acquireSession = vi.fn(async () => ({
      query: sessionQuery,
      release,
    }));
    const { ensureOpportunityListQueryIndexes } = await import(
      './admin-opportunity-query'
    );

    await ensureOpportunityListQueryIndexes({ acquireSession } as never);

    expect(sessionQuery).toHaveBeenNthCalledWith(
      1,
      "SELECT set_config('lock_timeout', $1, false)",
      ['15s'],
    );
    expect(sessionQuery).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('statement_timeout', $1, false)",
      ['15min'],
    );
    expect(sessionQuery.mock.calls.slice(2).join('\n')).toContain(
      'CREATE INDEX CONCURRENTLY',
    );
    expect(sessionQuery.mock.calls.slice(2).join('\n')).toContain(
      'FROM pg_index',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the historical score index only for bounded post-page context', async () => {
    const release = vi.fn(async () => {});
    const sessionQuery = vi.fn(async () => ({ rows: [] }));
    const acquireSession = vi.fn(async () => ({
      query: sessionQuery,
      release,
    }));
    const { ensureOpportunityListQueryIndexes } = await import(
      './admin-opportunity-query'
    );

    await ensureOpportunityListQueryIndexes({ acquireSession } as never);

    const statements = (sessionQuery.mock.calls as unknown[][]).map((call) =>
      String(call[0]),
    );
    const scoreIndex = statements.find(
      (sql) =>
        sql.includes('CREATE INDEX CONCURRENTLY') &&
        sql.includes('ON evaluation_scores'),
    );
    expect(scoreIndex).toBeDefined();
    expect(scoreIndex).toContain('opportunity_id');
    expect(scoreIndex).toContain("(COALESCE(source_content_fingerprint, ''))");
    expect(scoreIndex).toContain('updated_at DESC');
    expect(scoreIndex).toContain('INCLUDE (score)');
  });

  it('uses only an exact current assessment materialization before paging', async () => {
    const { createOpportunityWhereSql } = await import(
      './admin-opportunity-query'
    );

    const { joins, values } = createOpportunityWhereSql({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, minScore: 1 },
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    const assessmentJoin = joins.find((join) =>
      join.includes('opportunity_assessments'),
    );

    expect(assessmentJoin).toContain('oa.tenant_id');
    expect(assessmentJoin).toContain('oa.owner_user_id');
    expect(assessmentJoin).toContain('oa.candidate_profile_id');
    expect(assessmentJoin).toContain("oa.status = 'current'");
    expect(assessmentJoin).toContain('oa.contract_version');
    expect(assessmentJoin).toContain('oa.source_content_fingerprint');
    expect(assessmentJoin).toContain('oa.source_content_version');
    expect(assessmentJoin).toContain('oa.candidate_material_fingerprint');
    expect(assessmentJoin).toContain('oa.preferences_fingerprint');
    expect(assessmentJoin).not.toContain('evaluation_scores');
    expect(values).toEqual(
      expect.arrayContaining([
        'tenant-a',
        'user-a',
        'profile-a',
        'candidate-material-a',
        'preferences-a',
      ]),
    );
  });

  it('repairs an invalid concurrent index before retrying it', async () => {
    const release = vi.fn(async () => {});
    const sessionQuery = vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM pg_index') ? [{ isValid: false }] : [],
    }));
    const acquireSession = vi.fn(async () => ({
      query: sessionQuery,
      release,
    }));
    const { ensureOpportunityListQueryIndexes } = await import(
      './admin-opportunity-query'
    );

    await ensureOpportunityListQueryIndexes({ acquireSession } as never);

    expect(sessionQuery).toHaveBeenCalledWith(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_evaluation_scores_opportunity_fingerprint_updated',
    );
    expect(sessionQuery).toHaveBeenCalledWith(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_applications_opportunity_updated',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('filters with the latest subject-owned decision overlay, never global opportunity review fields', async () => {
    const { countOpportunityRecords } = await import(
      './admin-opportunity-query'
    );

    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'apply',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'unsorted',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [applySql, ...applyParams] = mocks.query.mock.calls[0] ?? [];
    const [unsortedSql, ...unsortedParams] = mocks.query.mock.calls[1] ?? [];
    expect(applySql).toContain('FROM decisions d');
    expect(applySql).toContain('latest_review.decision IS NULL');
    expect(applySql).toContain("latest_review.decision = 'accept_to_apply'");
    expect(applySql).toContain(
      'ORDER BY d.created_at DESC NULLS LAST, d.id DESC',
    );
    expect(applySql).toContain('d.tenant_id = $3');
    expect(applySql).toContain('d.owner_user_id = $4');
    expect(applySql).toContain('d.candidate_profile_id = $5');
    expect(applySql).not.toContain('o.human_review_status');
    expect(applySql).not.toContain('o.human_rating');
    expect(applyParams).toEqual([
      'apply',
      'archived',
      'tenant-a',
      'user-a',
      'profile-a',
    ]);
    expect(unsortedSql).toContain('NOT IN ($1, $2, $3)');
    expect(unsortedSql).toContain('FROM decisions d');
    expect(unsortedParams).toEqual([
      'apply',
      'maybe',
      'reject',
      'archived',
      'tenant-a',
      'user-a',
      'profile-a',
    ]);
  });

  it('binds score, application, review, and related-context joins to the complete workspace subject', async () => {
    const {
      countOpportunityRecords,
      listCurrentOpportunityScores,
      listLatestOpportunityRelatedContext,
      listOpportunityFilterOptions,
      listOpportunityPageIds,
    } = await import('./admin-opportunity-query');

    await countOpportunityRecords({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, minScore: 60 },
      reviewFilter: 'apply',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'rating' },
      limit: 10,
      offset: 0,
      reviewFilter: 'missing_application_planning',
      workspaceSubject: WORKSPACE_SUBJECT,
    });
    await listOpportunityFilterOptions('apply', WORKSPACE_SUBJECT);
    await listCurrentOpportunityScores(['opportunity-a'], WORKSPACE_SUBJECT);
    await listLatestOpportunityRelatedContext(
      ['opportunity-a'],
      WORKSPACE_SUBJECT,
    );

    for (const [sql, ...values] of mocks.query.mock.calls) {
      expect(sql).toContain('tenant_id');
      expect(sql).toContain('owner_user_id');
      expect(sql).toContain('candidate_profile_id');
      expect(values).toContain('tenant-a');
      expect(values).toContain('user-a');
      expect(values).toContain('profile-a');
    }
  });

  it('returns no related context when a forged subject has no selected profile', async () => {
    const { listLatestOpportunityRelatedContext } = await import(
      './admin-opportunity-query'
    );

    await expect(
      listLatestOpportunityRelatedContext(['opportunity-a'], {
        tenantId: 'tenant-a',
        userId: 'user-a',
      } as never),
    ).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects every exported listing boundary without a selected workspace profile', async () => {
    const {
      countOpportunityRecords,
      listOpportunityMatchingIds,
      listOpportunityPageIds,
      listOpportunityRevisionsByIds,
    } = await import('./admin-opportunity-query');
    const forgedSubject = { tenantId: 'tenant-a', userId: 'user-a' } as never;
    const query = {
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
      workspaceSubject: forgedSubject,
    } as never as Record<string, unknown>;

    await expect(countOpportunityRecords(query as never)).resolves.toBe(0);
    await expect(
      listOpportunityMatchingIds(query as never, { limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      listOpportunityPageIds({
        ...(query as object),
        limit: 10,
        offset: 0,
      } as never),
    ).resolves.toEqual([]);
    await expect(
      listOpportunityRevisionsByIds(['opportunity-a'], forgedSubject),
    ).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('keeps compensation, skill, fit, and score filters in the database query', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      assessmentCandidateMaterialFingerprint: 'candidate-material-a',
      assessmentPreferencesFingerprint: 'preferences-a',
      candidateSkills: ['kubernetes'],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        fit: 'gaps',
        includeMissingComp: true,
        maxScore: 95,
        minScore: 70,
        salaryMax: 180_000,
        salaryMin: 120_000,
        skills: ['Kubernetes'],
      },
      limit: 100,
      offset: 0,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql, ...params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('regexp_split_to_array');
    expect(sql).toContain('NOT (EXISTS');
    expect(sql).toContain('o.salary_min IS NULL AND o.salary_max IS NULL');
    expect(sql).toContain('latest_assessment.fit_score >=');
    expect(sql).toContain('latest_assessment.fit_score <=');
    expect(params).toContainEqual(['kubernetes']);
    expect(params).toContainEqual(['kubernetes']);
    expect(params).toContain(120_000);
    expect(params).toContain(180_000);
    expect(params).toContain(70);
    expect(params).toContain(95);
    expect(params.at(-2)).toBe(100);
    expect(params.at(-1)).toBe(0);
  });

  it('searches bounded opportunity and company fields with a parameterized term', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 10,
      offset: 0,
      reviewFilter: 'all',
      search: 'platform engineer',
      workspaceSubject: WORKSPACE_SUBJECT,
    });

    const [sql, ...params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('o.title ILIKE $1');
    expect(sql).toContain('search_company.name ILIKE $1');
    expect(sql).not.toContain('platform engineer');
    expect(params).toEqual(['%platform engineer%', 'archived', 10, 0]);
  });

  it('loads only the latest application and current-fingerprint score per opportunity', async () => {
    const { listLatestOpportunityRelatedContext } = await import(
      './admin-opportunity-query'
    );
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];

    await listLatestOpportunityRelatedContext(ids, WORKSPACE_SUBJECT);

    const [sql, ...params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('FROM applications a');
    expect(sql).toContain('FROM evaluation_scores es');
    expect(sql).toMatch(
      /COALESCE\(es\.source_content_fingerprint, ''\) =\s+COALESCE\(o\.source_content_fingerprint, ''\)/,
    );
    expect(sql).toContain('FROM decisions d');
    expect(sql.match(/LIMIT 1/g)).toHaveLength(3);
    expect(sql).toContain('WHERE o.id = ANY($1)');
    expect(sql).not.toContain('o.id::text');
    expect(sql).not.toContain('$1::text[]');
    expect(sql).toContain('LIMIT $11');
    expect(params).toEqual([
      ids,
      'tenant-a',
      'user-a',
      'profile-a',
      'tenant-a',
      'user-a',
      'profile-a',
      'tenant-a',
      'user-a',
      'profile-a',
      2,
    ]);
  });

  it('returns only the review-overlay-safe related decision fields', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          humanRating: 11,
          humanReviewNotes: 42,
          humanReviewStatus: 'not-a-status',
          opportunityId: 'opportunity-a',
          reviewedAt: 42,
          reviewedByProfileId: 12,
          reviewedByUserId: null,
        },
      ],
    });
    const { listLatestOpportunityRelatedContext } = await import(
      './admin-opportunity-query'
    );

    await expect(
      listLatestOpportunityRelatedContext(['opportunity-a'], WORKSPACE_SUBJECT),
    ).resolves.toEqual([
      {
        humanRating: null,
        humanReviewNotes: '',
        humanReviewStatus: undefined,
        opportunityId: 'opportunity-a',
        reviewedAt: null,
        reviewedByProfileId: '',
        reviewedByUserId: '',
      },
    ]);
  });

  describe('createOpportunityQueryFingerprint', () => {
    const baseQuery = {
      candidateSkills: ['typescript', 'svelte'],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'unsorted',
    };

    it('is stable across repeated calls on an equivalent query', async () => {
      const { createOpportunityQueryFingerprint } = await import(
        './admin-opportunity-query'
      );

      expect(createOpportunityQueryFingerprint(baseQuery)).toBe(
        createOpportunityQueryFingerprint({
          candidateSkills: ['typescript', 'svelte'],
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS },
          reviewFilter: 'unsorted',
        }),
      );
    });

    it('resolves the same rows for every spelling it hashes alike', async () => {
      const { createOpportunityQueryFingerprint, createOpportunityWhereSql } =
        await import('./admin-opportunity-query');

      const padded = {
        candidateSkills: [' typescript ', 'svelte', 'typescript'],
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, fit: 'gaps' as const },
        reviewFilter: 'unsorted',
      };
      const plain = {
        candidateSkills: ['svelte', 'typescript'],
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, fit: 'gaps' as const },
        reviewFilter: 'unsorted',
      };

      // Equal fingerprints have to mean equal row sets, or a confirmation
      // minted under one spelling could be spent against the other's rows.
      expect(createOpportunityQueryFingerprint(padded)).toBe(
        createOpportunityQueryFingerprint(plain),
      );
      expect(createOpportunityWhereSql(padded).values).toEqual(
        createOpportunityWhereSql(plain).values,
      );
    });

    it('holds that property for every term list the where clause reads', async () => {
      const { createOpportunityQueryFingerprint, createOpportunityWhereSql } =
        await import('./admin-opportunity-query');

      const padded = {
        candidateSkills: [' typescript '],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          employmentTypes: [' full_time ', 'full_time'],
          // Whitespace-only entries must behave as the empty list they hash
          // as, rather than adding a predicate the fingerprint cannot see.
          skills: [' '],
          workModes: [' remote '],
        },
        reviewFilter: ' unsorted ',
      };
      const plain = {
        candidateSkills: ['typescript'],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          employmentTypes: ['full_time'],
          skills: [],
          workModes: ['remote'],
        },
        reviewFilter: 'unsorted',
      };

      expect(createOpportunityQueryFingerprint(padded)).toBe(
        createOpportunityQueryFingerprint(plain),
      );
      const paddedSql = createOpportunityWhereSql(padded);
      const plainSql = createOpportunityWhereSql(plain);
      expect(paddedSql.values).toEqual(plainSql.values);
      expect(paddedSql.whereSql).toBe(plainSql.whereSql);
    });

    it('normalizes array order, duplicates, and search casing', async () => {
      const { createOpportunityQueryFingerprint } = await import(
        './admin-opportunity-query'
      );

      expect(
        createOpportunityQueryFingerprint({
          candidateSkills: ['svelte', 'typescript', 'svelte'],
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            skills: ['b', 'a'],
          },
          reviewFilter: 'unsorted',
          search: '  Staff Engineer  ',
        }),
      ).toBe(
        createOpportunityQueryFingerprint({
          candidateSkills: ['typescript', 'svelte'],
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            skills: ['a', 'b'],
          },
          reviewFilter: 'unsorted',
          search: 'staff engineer',
        }),
      );
    });

    it('changes when any filter, the review filter, or the sort changes', async () => {
      const { createOpportunityQueryFingerprint } = await import(
        './admin-opportunity-query'
      );
      const base = createOpportunityQueryFingerprint(baseQuery);

      const variants = [
        { ...baseQuery, reviewFilter: 'apply' },
        { ...baseQuery, search: 'platform' },
        {
          ...baseQuery,
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, status: 'found' },
        },
        {
          ...baseQuery,
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, minScore: 5 },
        },
        {
          ...baseQuery,
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'newest' as const },
        },
        {
          ...baseQuery,
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            sortDirection: 'asc' as const,
          },
        },
        { ...baseQuery, candidateSkills: ['typescript'] },
      ];

      for (const variant of variants) {
        expect(createOpportunityQueryFingerprint(variant)).not.toBe(base);
      }
    });
  });

  describe('listOpportunityMatchingIds', () => {
    it('orders by id, bounds the result, and returns each row revision', async () => {
      const updatedAt = new Date('2026-09-02T08:11:28.939Z');
      mocks.query.mockResolvedValue({
        rows: [
          { id: 'opp-1', updatedAt },
          { id: 'opp-2', updatedAt: '2026-09-02T08:11:29.000Z' },
          { id: '', updatedAt },
        ],
      });
      const { listOpportunityMatchingIds } = await import(
        './admin-opportunity-query'
      );

      const rows = await listOpportunityMatchingIds(
        {
          candidateSkills: [],
          filters: DEFAULT_OPPORTUNITY_FILTERS,
          reviewFilter: 'all',
          workspaceSubject: WORKSPACE_SUBJECT,
        },
        { limit: 501 },
      );

      const [sql, ...values] = mocks.query.mock.calls[0] ?? [];
      expect(sql).toContain('SELECT o.id, o.updated_at AS "updatedAt"');
      expect(sql).toContain('ORDER BY o.id ASC');
      expect(sql).toMatch(/LIMIT \$\d+/);
      expect(values.at(-1)).toBe(501);
      // A blank id is dropped rather than returned as a selectable row.
      expect(rows).toEqual([
        { id: 'opp-1', updatedAt: '2026-09-02T08:11:28.939Z' },
        { id: 'opp-2', updatedAt: '2026-09-02T08:11:29.000Z' },
      ]);
    });
  });
});
