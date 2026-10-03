import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import type { WorkspaceOpportunityQuery } from './admin-opportunity-query';

const mocks = vi.hoisted(() => ({
  dbConfig: vi.fn(() => ({})),
  query: vi.fn(),
  requestDatabase: vi.fn(),
  scopedQuery: vi.fn(),
  privatePartials: vi.fn(),
  source: vi.fn(),
  partialProjections: vi.fn(),
  sourceEligibility: vi.fn(),
  screeningProjections: vi.fn(),
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

vi.mock('./private-workspace.js', () => ({
  listPrivateRecords: mocks.privatePartials,
}));
vi.mock('./opportunity-assessment-partial.js', () => ({
  OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION: 'opportunity-assessment-partial/v1',
}));
vi.mock('./opportunity-assessment-partial-projection.js', () => ({
  loadCurrentPartialOpportunityAssessmentProjections: mocks.partialProjections,
}));
vi.mock('./opportunity-requirement-coverage-provider.js', () => ({
  REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION:
    'requirement-evidence-audit/v3-source-eligibility',
}));
vi.mock('./opportunity-source-eligibility-projection.js', () => ({
  loadCurrentSourceEligibilityProjections: mocks.sourceEligibility,
}));
vi.mock('./opportunity-screening-projection.js', () => ({
  OPPORTUNITY_SCREENING_PROJECTION_PAGE_LIMIT: 100,
  OPPORTUNITY_SCREENING_RECEIPT_FEATURE: 'opportunity-screening',
  OPPORTUNITY_SCREENING_RECEIPT_PROFILE: 'typesafe-opportunity-screening',
  loadCurrentOpportunityScreeningProjections: mocks.screeningProjections,
}));
vi.mock('./smrt.js', () => ({
  getCollection: async () => ({ get: mocks.source }),
}));

describe('admin-opportunity-query', () => {
  beforeEach(() => {
    mocks.privatePartials.mockReset();
    mocks.privatePartials.mockResolvedValue([]);
    mocks.source.mockReset();
    mocks.partialProjections.mockReset();
    mocks.partialProjections.mockResolvedValue(new Map());
    mocks.sourceEligibility.mockReset();
    mocks.sourceEligibility.mockResolvedValue(new Map());
    mocks.screeningProjections.mockReset();
    mocks.screeningProjections.mockResolvedValue(new Map());
    mocks.dbConfig.mockReset();
    mocks.dbConfig.mockReturnValue({});
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.requestDatabase.mockReset();
    mocks.requestDatabase.mockReturnValue(undefined);
    mocks.scopedQuery.mockReset();
    mocks.scopedQuery.mockResolvedValue({ rows: [] });
  });

  it('replays screening selectors in pages of 100 with one uncached owned profile read', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `screen-${index}`);
    mocks.query.mockResolvedValue({ rows: ids.map((id) => ({ id })) });
    const profile = { id: WORKSPACE_SUBJECT.profileId, active: true };
    mocks.source.mockResolvedValue({ toJSON: () => profile });
    mocks.screeningProjections.mockImplementation(
      async (
        {
          opportunities,
          subject,
        }: { opportunities: Array<{ id: string }>; subject: unknown },
        { getProfile }: { getProfile: (id: string) => Promise<unknown> },
      ) => {
        expect(subject).toEqual(WORKSPACE_SUBJECT);
        expect(await getProfile(WORKSPACE_SUBJECT.profileId)).toEqual(profile);
        return new Map(
          opportunities.flatMap(({ id }) =>
            id === 'screen-0'
              ? [
                  [
                    id,
                    {
                      sourceContentFingerprint: 'current',
                      sourceContentVersion: 1,
                      status: 'clear_mismatch',
                      excludeFromDefaultTriage: true,
                      holdReasons: [],
                    },
                  ],
                ]
              : [],
          ),
        );
      },
    );
    const { loadCurrentScreenedOpportunityExclusions } = await import(
      './admin-opportunity-query'
    );

    expect(
      [
        ...(await loadCurrentScreenedOpportunityExclusions(WORKSPACE_SUBJECT)),
      ].map(([id]) => id),
    ).toEqual(['screen-0']);
    expect(
      mocks.screeningProjections.mock.calls.map(
        ([input]) => input.opportunities.length,
      ),
    ).toEqual([100, 100, 5]);
    expect(mocks.source).toHaveBeenCalledOnce();
    expect(mocks.source).toHaveBeenCalledWith(
      { id: WORKSPACE_SUBJECT.profileId },
      { cache: false },
    );
    const [sql, ...values] = mocks.query.mock.calls[0];
    expect(sql).toContain("q.accounting_basis = 'actual'");
    expect(sql).toContain("r.status = 'completed' AND q.status = 'succeeded'");
    expect(sql).toContain('r.tenant_id');
    expect(sql).toContain('q.candidate_profile_id');
    expect(sql).not.toContain('output_json');
    expect(values).toEqual([
      'opportunity-screening',
      'typesafe-opportunity-screening',
      'tenant-a',
      'user-a',
      'profile-a',
      'tenant-a',
      'user-a',
      'profile-a',
    ]);
  });

  it('never uses a nominated receipt status without successful current projection replay', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ id: 'orphan', status: 'clear_mismatch' }],
    });
    const { loadCurrentScreenedOpportunityExclusions } = await import(
      './admin-opportunity-query'
    );
    expect(
      await loadCurrentScreenedOpportunityExclusions(WORKSPACE_SUBJECT),
    ).toEqual(new Map());
    expect(mocks.screeningProjections).toHaveBeenCalledOnce();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it('filters screening before SQLite count, pages and all-matching selection while retaining stale, unknown and human decisions', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    const ids = ['excluded', 'stale', 'version', 'unknown', 'human'];
    const selector = vi.fn(async (sql: string, ...values: unknown[]) =>
      sql.includes('SELECT DISTINCT r.opportunity_id AS id')
        ? { rows: ids.map((id) => ({ id })) }
        : await db.query(sql, ...values),
    );
    mocks.requestDatabase.mockReturnValue({ query: selector });
    mocks.screeningProjections.mockImplementation(
      async ({
        opportunities,
        subject,
      }: {
        opportunities: Array<{ id: string }>;
        subject: typeof WORKSPACE_SUBJECT;
      }) =>
        subject.profileId !== 'profile-a'
          ? new Map()
          : new Map(
              opportunities
                .filter(({ id }) => id !== 'unknown')
                .map(({ id }) => [
                  id,
                  {
                    sourceContentFingerprint: `fp-${id}`,
                    sourceContentVersion: 1,
                    status: 'clear_mismatch',
                    excludeFromDefaultTriage: true,
                    holdReasons: [],
                  },
                ]),
            ),
    );
    try {
      await db.query(
        'CREATE TABLE opportunities (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, posted_at TEXT, first_seen_at TEXT, source_content_fingerprint TEXT, source_content_version INTEGER)',
      );
      await db.query(
        'CREATE TABLE decisions (id TEXT PRIMARY KEY, opportunity_id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, decision TEXT, created_at TEXT)',
      );
      for (const id of ids)
        await db.query(
          'INSERT INTO opportunities VALUES (?, ?, ?, ?, ?, ?, ?)',
          id,
          'found',
          '2026-10-02',
          '2026-10-01',
          '2026-10-01',
          id === 'stale' ? 'new-source' : `fp-${id}`,
          id === 'version' ? 2 : 1,
        );
      await db.query(
        "INSERT INTO decisions VALUES ('decision', 'human', ?, ?, ?, 'accept_to_apply', '2026-10-02')",
        WORKSPACE_SUBJECT.tenantId,
        WORKSPACE_SUBJECT.userId,
        WORKSPACE_SUBJECT.profileId,
      );
      const {
        countOpportunityRecords,
        listOpportunityPageIds,
        listOpportunityMatchingIds,
      } = await import('./admin-opportunity-query');
      const query = {
        candidateSkills: [],
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'newest' as const },
        reviewFilter: 'unsorted',
        workspaceSubject: WORKSPACE_SUBJECT,
      };
      expect(await countOpportunityRecords(query)).toBe(3);
      expect(
        await listOpportunityPageIds({ ...query, limit: 1, offset: 0 }),
      ).toEqual(['stale']);
      expect(
        await listOpportunityPageIds({ ...query, limit: 1, offset: 1 }),
      ).toEqual(['unknown']);
      expect(
        (await listOpportunityMatchingIds(query, { limit: 10 })).map(
          ({ id }) => id,
        ),
      ).toEqual(['stale', 'unknown', 'version']);
      expect(
        await listOpportunityPageIds({
          ...query,
          reviewFilter: 'screened_out',
          limit: 10,
          offset: 0,
        }),
      ).toEqual(['excluded', 'human']);
      expect(
        await countOpportunityRecords({ ...query, reviewFilter: 'all' }),
      ).toBe(5);
      expect(
        await listOpportunityPageIds({
          ...query,
          reviewFilter: 'apply',
          limit: 10,
          offset: 0,
        }),
      ).toEqual(['human']);
      expect(
        await countOpportunityRecords({
          ...query,
          workspaceSubject: {
            ...WORKSPACE_SUBJECT,
            profileId: 'changed-profile',
          },
        }),
      ).toBe(5);
      const sql = selector.mock.calls.find(([statement]) =>
        statement.includes('json_each'),
      )?.[0];
      expect(sql).toContain(
        "o.source_content_version = json_extract(screen.value, '$.version')",
      );
      expect(sql).toContain('NOT EXISTS');
    } finally {
      await db.close?.();
    }
  });

  it('uses one typed PostgreSQL tuple payload and keeps explicit screened-out queries out of human review predicates', async () => {
    const { createOpportunityWhereSql } = await import(
      './admin-opportunity-query'
    );
    const exclusions = new Map([
      [
        'current',
        {
          sourceContentFingerprint: 'fp',
          sourceContentVersion: 2,
          projection: {},
        },
      ],
    ]) as never;
    const query = {
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'screened_out',
      workspaceSubject: WORKSPACE_SUBJECT,
    };
    const built = createOpportunityWhereSql(
      query,
      'postgres',
      new Map(),
      exclusions,
    );
    expect(built.whereSql).toContain('jsonb_to_recordset');
    expect(built.whereSql).toContain(
      'screen(id text, fingerprint text, version bigint)',
    );
    expect(built.whereSql).toContain(
      'o.source_content_fingerprint = screen.fingerprint',
    );
    expect(built.joins).toEqual([]);
    expect(built.values).toHaveLength(2);
    expect(createOpportunityWhereSql(query).whereSql).toContain('FALSE');
  });

  it('scopes facet options to the same current screened-out source tuples', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT DISTINCT r.opportunity_id AS id')
        ? [{ id: 'excluded' }]
        : [{ statuses: ['found'] }],
    }));
    mocks.screeningProjections.mockResolvedValue(
      new Map([
        [
          'excluded',
          {
            sourceContentFingerprint: 'current-source',
            sourceContentVersion: 3,
            status: 'clear_mismatch',
            excludeFromDefaultTriage: true,
            holdReasons: [],
          },
        ],
      ]),
    );
    const { listOpportunityFilterOptions } = await import(
      './admin-opportunity-query'
    );
    expect(
      (await listOpportunityFilterOptions('screened_out', WORKSPACE_SUBJECT))
        .statuses,
    ).toEqual(['found']);
    const [sql, ...values] = mocks.query.mock.calls.at(-1) ?? [];
    expect(sql).toContain('WITH scoped AS');
    expect(sql).toContain('WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset');
    expect(sql).toContain('o.source_content_version = screen.version');
    expect(values).toEqual([
      JSON.stringify([
        { id: 'excluded', fingerprint: 'current-source', version: 3 },
      ]),
    ]);

    mocks.query.mockClear();
    mocks.screeningProjections.mockResolvedValue(new Map());
    await listOpportunityFilterOptions('screened_out', WORKSPACE_SUBJECT);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('WHERE FALSE');
  });

  for (const sortDirection of ['asc', 'desc'] as const) {
    it(`orders validated support ${sortDirection} before SQLite page slicing, pinning source identity and putting absent proof last`, async () => {
      const db = await getDatabase({
        type: 'sqlite',
        url: ':memory:',
        cache: false,
      });
      mocks.requestDatabase.mockReturnValue(db);
      mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
      mocks.privatePartials.mockResolvedValue(
        ['seven', 'zero', 'stale', 'forged'].map((opportunityId) => ({
          opportunityId,
        })),
      );
      mocks.source.mockImplementation(async ({ id }: { id: string }) => ({
        toJSON: () => ({
          id,
          sourceContentFingerprint: `fp-${id}`,
          sourceContentVersion: 1,
        }),
      }));
      mocks.partialProjections.mockImplementation(
        async ({ opportunities }: { opportunities: Array<{ id: string }> }) => {
          const id = opportunities[0].id;
          return id === 'forged'
            ? new Map()
            : new Map([
                [id, { supportedCriterionCount: id === 'zero' ? 0 : 7 }],
              ]);
        },
      );
      try {
        await db.query(
          'CREATE TABLE opportunities (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, source_content_fingerprint TEXT, source_content_version INTEGER)',
        );
        for (const id of ['seven', 'zero', 'stale', 'forged', 'missing']) {
          await db.query(
            'INSERT INTO opportunities VALUES (?, ?, ?, ?, ?)',
            id,
            'found',
            '2026-10-02',
            `fp-${id}`,
            id === 'stale' ? 2 : 1,
          );
        }
        const { listOpportunityPageIds } = await import(
          './admin-opportunity-query'
        );
        const query = {
          candidateSkills: [],
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            sort: 'cited_support' as const,
            sortDirection,
          },
          reviewFilter: 'all',
          workspaceSubject: WORKSPACE_SUBJECT,
        };
        const first = await listOpportunityPageIds({
          ...query,
          limit: 2,
          offset: 0,
        });
        const rest = await listOpportunityPageIds({
          ...query,
          limit: 3,
          offset: 2,
        });
        expect(first).toEqual(
          sortDirection === 'asc' ? ['zero', 'seven'] : ['seven', 'zero'],
        );
        expect(rest).toEqual(['forged', 'missing', 'stale']);
        expect(mocks.privatePartials).toHaveBeenCalledWith(
          'OpportunityAssessment',
          WORKSPACE_SUBJECT,
          {
            where: {
              status: 'partial',
              contractVersion: 'opportunity-assessment-partial/v1',
            },
          },
        );
        expect(mocks.source).not.toHaveBeenCalledWith(
          { id: 'missing' },
          expect.anything(),
        );
        expect(mocks.source).toHaveBeenCalledWith(
          { id: 'seven' },
          { cache: false },
        );
      } finally {
        await db.close?.();
      }
    });
  }

  it('replays only deduplicated saved partial selectors with at most four simultaneous native proof reads', async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `opp-${index}`);
    mocks.privatePartials.mockResolvedValue(
      [...ids, ids[0], ''].map((opportunityId) => ({ opportunityId })),
    );
    mocks.source.mockImplementation(async ({ id }: { id: string }) => ({
      toJSON: () => ({
        id,
        sourceContentFingerprint: `fp-${id}`,
        sourceContentVersion: 1,
      }),
    }));
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.partialProjections.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return new Map(); // Foreign/stale/unreplayable receipts contribute no count.
    });
    const { loadCurrentCitedOpportunitySupport } = await import(
      './admin-opportunity-query'
    );
    const pending = loadCurrentCitedOpportunitySupport(WORKSPACE_SUBJECT);
    await vi.waitFor(() => expect(active).toBe(4));
    release();
    expect(await pending).toEqual(new Map());
    expect(maximum).toBe(4);
    expect(mocks.source).toHaveBeenCalledTimes(ids.length);
    expect(mocks.partialProjections).toHaveBeenCalledTimes(ids.length);
  });

  it('does not hydrate partial source records for ordinary list ordering', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );
    await listOpportunityPageIds({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
      workspaceSubject: WORKSPACE_SUBJECT,
      limit: 10,
      offset: 0,
    });
    expect(mocks.privatePartials).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it('executes SQLite source eligibility filtering before COUNT/PAGE slicing and falls back to current full proof after source drift', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    mocks.dbConfig.mockReturnValue({ type: 'sqlite' });
    mocks.requestDatabase.mockReturnValue({
      query: async (sql: string, ...values: unknown[]) =>
        sql.includes('SELECT DISTINCT r.opportunity_id')
          ? {
              rows: ['actual', 'changed-version', 'changed-fp', 'forged'].map(
                (id) => ({ id }),
              ),
            }
          : db.query(sql, ...values),
    });
    mocks.source.mockImplementation(async ({ id }: { id: string }) => ({
      toJSON: () => ({
        id,
        sourceContentFingerprint: `fp-${id}`,
        sourceContentVersion: 1,
      }),
    }));
    mocks.sourceEligibility.mockImplementation(
      async ({ opportunities }: { opportunities: Array<{ id: string }> }) => {
        const id = opportunities[0].id;
        return id === 'forged'
          ? new Map()
          : new Map([
              [
                id,
                {
                  eligibilityBucket: 'eligible',
                  sourceStatus: 'current',
                  reason: 'Actual replay',
                  unresolvedConstraintFactKeys: [],
                },
              ],
            ]);
      },
    );
    try {
      await db.query(
        'CREATE TABLE opportunities (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, source_content_fingerprint TEXT, source_content_version INTEGER)',
      );
      await db.query(
        'CREATE TABLE opportunity_assessments (id TEXT PRIMARY KEY, opportunity_id TEXT, status TEXT, contract_version TEXT, source_content_fingerprint TEXT, source_content_version INTEGER, candidate_material_fingerprint TEXT, preferences_fingerprint TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, eligibility_bucket TEXT, eligibility_priority INTEGER, updated_at TEXT)',
      );
      for (const id of [
        'actual',
        'changed-version',
        'changed-fp',
        'forged',
        'full',
      ]) {
        const fp = id === 'changed-fp' ? 'new-fp' : `fp-${id}`;
        const version = id === 'changed-version' ? 2 : 1;
        await db.query(
          'INSERT INTO opportunities VALUES (?, ?, ?, ?, ?)',
          id,
          'found',
          '2026-10-02',
          fp,
          version,
        );
        if (['changed-version', 'changed-fp', 'full'].includes(id))
          await db.query(
            'INSERT INTO opportunity_assessments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            `assessment-${id}`,
            id,
            'current',
            'opportunity-assessment/v6',
            fp,
            version,
            'candidate-a',
            'preferences-a',
            WORKSPACE_SUBJECT.tenantId,
            WORKSPACE_SUBJECT.userId,
            WORKSPACE_SUBJECT.profileId,
            id === 'full' ? 'eligible' : 'sponsorship_possible',
            id === 'full' ? 0 : 1,
            '2026-10-02',
          );
      }
      const {
        countOpportunityRecords,
        listOpportunityPageIds,
        listOpportunityMatchingIds,
      } = await import('./admin-opportunity-query');
      const query: WorkspaceOpportunityQuery = {
        candidateSkills: [],
        assessmentCandidateMaterialFingerprint: 'candidate-a',
        assessmentPreferencesFingerprint: 'preferences-a',
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          eligibilityBuckets: ['eligible'],
          sort: 'eligibility' as const,
        },
        reviewFilter: 'all',
        workspaceSubject: WORKSPACE_SUBJECT,
      };
      expect(await countOpportunityRecords(query)).toBe(2);
      expect(
        await listOpportunityPageIds({ ...query, limit: 1, offset: 0 }),
      ).toEqual(['actual']);
      expect(
        await listOpportunityPageIds({ ...query, limit: 1, offset: 1 }),
      ).toEqual(['full']);
      expect(
        (await listOpportunityMatchingIds(query, { limit: 501 })).map(
          (row) => row.id,
        ),
      ).toEqual(['actual', 'full']);
      expect(
        await countOpportunityRecords({
          ...query,
          filters: {
            ...query.filters,
            eligibilityBuckets: ['sponsorship_possible'],
          },
        }),
      ).toBe(2);
    } finally {
      await db.close?.();
    }
  });

  it('nominates only public actual v3 receipts, never trusts their scalars, and bounds native eligibility replay to four', async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `source-${index}`);
    mocks.query.mockResolvedValue({
      rows: [...ids, ids[0]].map((id) => ({
        id,
        eligibilityBucket: 'eligible',
      })),
    });
    mocks.source.mockImplementation(async ({ id }: { id: string }) => ({
      toJSON: () => ({
        id,
        sourceContentFingerprint: `fp-${id}`,
        sourceContentVersion: 1,
      }),
    }));
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.sourceEligibility.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return new Map();
    });
    const { loadCurrentSourceOpportunityEligibility } = await import(
      './admin-opportunity-query'
    );
    const pending = loadCurrentSourceOpportunityEligibility(WORKSPACE_SUBJECT);
    await vi.waitFor(() => expect(active).toBe(4));
    release();
    expect(await pending).toEqual(new Map());
    expect(maximum).toBe(4);
    expect(mocks.source).toHaveBeenCalledTimes(ids.length);
    expect(mocks.source).toHaveBeenCalledWith({ id: ids[0] }, { cache: false });
    expect(mocks.sourceEligibility).toHaveBeenCalledWith({
      opportunities: [expect.objectContaining({ id: ids[0] })],
      subject: WORKSPACE_SUBJECT,
    });
    const [sql, ...values] = mocks.query.mock.calls[0];
    expect(sql).toContain("q.accounting_basis = 'actual'");
    expect(sql).toContain('q.actual_total_tokens > 0');
    expect(sql).toContain("COALESCE(q.candidate_profile_id, '') = ''");
    expect(values).toEqual([
      'opportunity-source-requirement-evidence',
      'requirement-evidence-audit/v3-source-eligibility',
      'typesafe-opportunity-source-evidence',
    ]);
  });

  for (const sortDirection of ['asc', 'desc'] as const) {
    it(`uses the same source/profile bucket CASE for COUNT and PAGE filters and ${sortDirection} eligibility order before slicing`, async () => {
      mocks.query.mockImplementation(async (sql: string) => ({
        rows: sql.includes('SELECT DISTINCT r.opportunity_id')
          ? [{ id: 'actual-source' }]
          : sql.includes('COUNT(*)')
            ? [{ count: 1 }]
            : [{ id: 'actual-source' }],
      }));
      mocks.source.mockResolvedValue({
        toJSON: () => ({
          id: 'actual-source',
          sourceContentFingerprint: 'actual-fp',
          sourceContentVersion: 3,
          postingEligibilityJson:
            '{"eligibilityBucket":"location_restriction"}',
        }),
      });
      mocks.sourceEligibility.mockResolvedValue(
        new Map([
          [
            'actual-source',
            {
              eligibilityBucket: 'eligible',
              sourceStatus: 'current',
              reason: 'Native replay',
              unresolvedConstraintFactKeys: [],
            },
          ],
        ]),
      );
      const {
        countOpportunityRecords,
        listOpportunityPageIds,
        listOpportunityMatchingIds,
      } = await import('./admin-opportunity-query');
      const query: WorkspaceOpportunityQuery = {
        candidateSkills: [],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          eligibilityBuckets: ['eligible'],
          sort: 'eligibility' as const,
          sortDirection,
        },
        reviewFilter: 'all',
        workspaceSubject: WORKSPACE_SUBJECT,
      };
      expect(await countOpportunityRecords(query)).toBe(1);
      expect(
        await listOpportunityPageIds({ ...query, limit: 1, offset: 0 }),
      ).toEqual(['actual-source']);
      await listOpportunityMatchingIds(query, { limit: 501 });
      const main = mocks.query.mock.calls.filter(([sql]) =>
        sql.includes('FROM opportunities o'),
      );
      expect(main).toHaveLength(3);
      for (const [sql, ...values] of main) {
        expect(sql).toContain('AND o.source_content_fingerprint =');
        expect(sql).toContain('AND o.source_content_version =');
        expect(sql).toContain(
          "ELSE COALESCE(latest_assessment.eligibility_bucket, 'unknown') END",
        );
        expect(values).toEqual(
          expect.arrayContaining(['actual-source', 'actual-fp', 3, 'eligible']),
        );
        expect(sql).not.toContain('posting_eligibility_json');
      }
      const [pageSql, ...pageValues] = main[1];
      expect(pageSql).toContain(
        'ELSE latest_assessment.eligibility_priority END',
      );
      expect(pageSql).toContain(
        `${sortDirection.toUpperCase()} NULLS LAST, o.updated_at DESC, o.id ASC`,
      );
      expect(pageValues).toEqual(expect.arrayContaining([0]));
      expect(pageSql).not.toContain('fit_score ELSE NULL END');
    });
  }

  for (const dialect of ['sqlite', 'postgres'] as const) {
    it.runIf(
      dialect === 'sqlite' ||
        Boolean(process.env.OPPORTUNITY_QUERY_TEST_POSTGRES_URL),
    )(
      `runs search, Overview dates and skill/fit filters with native ${dialect} count/page and private review before pagination`,
      async () => {
        const postgresUrl =
          process.env.OPPORTUNITY_QUERY_TEST_POSTGRES_URL ?? '';
        if (
          dialect === 'postgres' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(
            new URL(postgresUrl).hostname,
          )
        )
          throw new Error(
            'Query regression requires a local PostgreSQL test database.',
          );
        const db = await getDatabase(
          dialect === 'sqlite'
            ? { type: 'sqlite', url: ':memory:', cache: false }
            : { type: 'postgres', url: postgresUrl, cache: false },
        );
        const session =
          dialect === 'postgres' ? await db.acquireSession?.() : null;
        if (dialect === 'postgres' && !session) {
          await db.close?.();
          throw new Error('PostgreSQL regression requires a pinned session.');
        }
        const executor = session ?? db;
        mocks.requestDatabase.mockReturnValue(executor);
        mocks.dbConfig.mockReturnValue({ type: dialect });
        const { countOpportunityRecords, listOpportunityPageIds } =
          await import('./admin-opportunity-query');
        try {
          // Connection-local fixtures never mutate the migrated or canonical tables.
          await executor.query(
            `CREATE TEMP TABLE opportunities (id TEXT PRIMARY KEY, company_id TEXT, title TEXT, description_summary TEXT, required_skills TEXT, preferred_skills TEXT, locations TEXT, posting_url TEXT, status TEXT, posted_at TIMESTAMPTZ, first_seen_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, freshness TEXT)`,
          );
          await executor.query(
            `CREATE TEMP TABLE companies (id TEXT PRIMARY KEY, name TEXT)`,
          );
          await executor.query(
            `CREATE TEMP TABLE decisions (id TEXT PRIMARY KEY, opportunity_id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, decision TEXT, created_at TEXT, human_rating INTEGER, reason TEXT, decider_profile_id TEXT, decider_user_id TEXT)`,
          );
          await executor.query(
            'INSERT INTO companies VALUES (?, ?)',
            'company-1',
            'VANTA Security',
          );
          for (const [id, title, companyId] of [
            ['role-a', 'Platform 100%_! Engineer', 'company-1'],
            ['role-b', 'Platform 1000X Engineer', 'other-company'],
            ['role-foreign', 'Platform 100%_! Engineer', 'company-1'],
          ] as const) {
            await executor.query(
              "INSERT INTO opportunities VALUES (?, ?, ?, '', '', '', '', '', 'found', '2026-10-01', '2026-10-01', '2026-10-01', NULL, 'unknown')",
              id,
              companyId,
              title,
            );
            await executor.query(
              "INSERT INTO decisions VALUES (?, ?, ?, ?, ?, 'defer', '2026-10-01', NULL, '', '', '')",
              `decision-${id}`,
              id,
              WORKSPACE_SUBJECT.tenantId,
              id === 'role-foreign' ? 'foreign-user' : WORKSPACE_SUBJECT.userId,
              WORKSPACE_SUBJECT.profileId,
            );
          }
          const query = {
            candidateSkills: [],
            filters: {
              ...DEFAULT_OPPORTUNITY_FILTERS,
              sort: 'newest' as const,
            },
            reviewFilter: 'maybe',
            workspaceSubject: WORKSPACE_SUBJECT,
          };
          expect(
            await countOpportunityRecords({ ...query, search: 'pLaTfOrM' }),
          ).toBe(2);
          expect(
            await listOpportunityPageIds({
              ...query,
              search: 'pLaTfOrM',
              limit: 1,
              offset: 0,
            }),
          ).toEqual(['role-a']);
          expect(
            await listOpportunityPageIds({
              ...query,
              search: 'pLaTfOrM',
              limit: 1,
              offset: 1,
            }),
          ).toEqual(['role-b']);
          expect(
            await countOpportunityRecords({ ...query, search: '100%_!' }),
          ).toBe(1);
          expect(
            await listOpportunityPageIds({
              ...query,
              search: '100%_!',
              limit: 10,
              offset: 0,
            }),
          ).toEqual(['role-a']);
          expect(
            await countOpportunityRecords({ ...query, search: 'vanta' }),
          ).toBe(1);
          expect(
            await listOpportunityPageIds({
              ...query,
              search: 'vanta',
              limit: 10,
              offset: 0,
            }),
          ).toEqual(['role-a']);
          expect(
            await countOpportunityRecords({ ...query, search: "%' OR 1=1 --" }),
          ).toBe(0);
          expect(
            await listOpportunityPageIds({
              ...query,
              search: "%' OR 1=1 --",
              limit: 10,
              offset: 0,
            }),
          ).toEqual([]);
          const clock = vi
            .spyOn(Date, 'now')
            .mockReturnValue(Date.parse('2026-10-02T00:00:00Z'));
          try {
            await executor.query(
              "UPDATE opportunities SET expires_at = '2026-10-01T20:00:00-05:00', freshness = ' Fresh ' WHERE id = 'role-a'",
            );
            await executor.query(
              "UPDATE opportunities SET posted_at = NULL WHERE id = 'role-b'",
            );
            for (const [id, postedAt, expiresAt, freshness] of [
              [
                'role-expired',
                '2026-10-01T00:00:00Z',
                '2026-10-01T23:59:59Z',
                'fresh',
              ],
              [
                'role-stale',
                '2026-10-01T00:00:00Z',
                '2026-10-03T00:00:00Z',
                ' StAlE ',
              ],
              ['role-old', null, null, 'unknown'],
            ] as const) {
              await executor.query(
                "INSERT INTO opportunities VALUES (?, '', 'Filter fixture', '', '', '', '', '', 'found', ?, '2026-09-01', '2026-10-01', ?, ?)",
                id,
                postedAt,
                expiresAt,
                freshness,
              );
              await executor.query(
                "INSERT INTO decisions VALUES (?, ?, ?, ?, ?, 'defer', '2026-10-01', NULL, '', '', '')",
                `decision-${id}`,
                id,
                WORKSPACE_SUBJECT.tenantId,
                WORKSPACE_SUBJECT.userId,
                WORKSPACE_SUBJECT.profileId,
              );
            }
            const overview = {
              ...query,
              filters: {
                ...query.filters,
                excludeExpired: true,
                excludeStale: true,
                postedWithinDays: 2,
              },
            };
            expect(await countOpportunityRecords(query)).toBe(5);
            expect(await countOpportunityRecords(overview)).toBe(2);
            expect(
              await listOpportunityPageIds({
                ...overview,
                limit: 1,
                offset: 0,
              }),
            ).toEqual(['role-a']);
            expect(
              await listOpportunityPageIds({
                ...overview,
                limit: 1,
                offset: 1,
              }),
            ).toEqual(['role-b']);
            expect(
              await listOpportunityPageIds({
                ...overview,
                filters: { ...overview.filters, freshOnly: true },
                limit: 10,
                offset: 0,
              }),
            ).toEqual(['role-a']);
          } finally {
            clock.mockRestore();
          }
          await executor.query(
            'UPDATE opportunities SET required_skills = ?, preferred_skills = ? WHERE id IN (?, ?)',
            ' TypeScript,\nCloud--native,, ',
            'Kubernetes\r Docker',
            'role-a',
            'role-foreign',
          );
          await executor.query(
            'UPDATE opportunities SET required_skills = ? WHERE id = ?',
            'Rust\rSecurity',
            'role-b',
          );
          const skillsQuery = { ...query, search: 'platform' };
          const matchingIds = async (
            filters: Partial<typeof query.filters>,
            candidateSkills: string[] = [],
          ) => {
            const skillQuery = {
              ...skillsQuery,
              candidateSkills,
              filters: { ...query.filters, ...filters },
            };
            const ids = await listOpportunityPageIds({
              ...skillQuery,
              limit: 10,
              offset: 0,
            });
            expect(await countOpportunityRecords(skillQuery)).toBe(ids.length);
            return ids;
          };
          expect(await matchingIds({ skills: [' docker '] })).toEqual([
            'role-a',
          ]);
          expect(await matchingIds({ skills: ['security'] })).toEqual([
            'role-b',
          ]);
          expect(await matchingIds({ skills: ['cloud native'] })).toEqual([]);
          expect(await matchingIds({ skills: ["docker') OR 1=1 --"] })).toEqual(
            [],
          );
          expect(
            await matchingIds({ fit: 'have' }, ['typescript', 'cloud native']),
          ).toEqual(['role-a']);
          expect(
            await matchingIds({ fit: 'have' }, ['typescript', 'cloud']),
          ).toEqual(['role-a']);
          expect(
            await matchingIds({ fit: 'gaps' }, ['typescript', 'cloud native']),
          ).toEqual(['role-b']);
          expect(
            await matchingIds({ fit: 'have' }, ['typescript', 'cloudnative']),
          ).toEqual([]);
          expect(await matchingIds({ fit: 'have' })).toEqual([]);
          expect(await matchingIds({ fit: 'gaps' })).toEqual([
            'role-a',
            'role-b',
          ]);
          expect(
            await countOpportunityRecords({
              ...query,
              search: 'Filter fixture',
              filters: { ...query.filters, fit: 'have' },
            }),
          ).toBe(3);
          expect(
            await countOpportunityRecords({
              ...query,
              search: 'Filter fixture',
              filters: { ...query.filters, fit: 'gaps' },
            }),
          ).toBe(0);
          expect(
            await listOpportunityPageIds({
              ...skillsQuery,
              candidateSkills: ['typescript', 'cloud native'],
              filters: { ...query.filters, fit: 'gaps' },
              limit: 1,
              offset: 0,
            }),
          ).toEqual(['role-b']);
        } finally {
          if (session) {
            await executor.query('DROP TABLE IF EXISTS pg_temp.decisions');
            await executor.query('DROP TABLE IF EXISTS pg_temp.companies');
            await executor.query('DROP TABLE IF EXISTS pg_temp.opportunities');
            await session.release();
          }
          await db.close?.();
        }
      },
    );
  }

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
    const [triageSql] = mocks.query.mock.calls.at(-1) ?? [];
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
    const [browseSql] = mocks.query.mock.calls.at(-1) ?? [];
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

    const [sql] = mocks.query.mock.calls.at(-1) ?? [];
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
    const [unsortedSql, ...unsortedParams] =
      mocks.query.mock.calls.at(-1) ?? [];
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
    expect(sql).toContain("lower(o.title) LIKE lower($1) ESCAPE '!'");
    expect(sql).toContain(
      "lower(search_company.name) LIKE lower($1) ESCAPE '!'",
    );
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
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, excludeStale: true },
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
