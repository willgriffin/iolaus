import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  requestDatabase: vi.fn(),
  scopedQuery: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ query: mocks.query })),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: mocks.requestDatabase,
}));

vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => ({})),
}));

describe('admin-opportunity-query', () => {
  beforeEach(() => {
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
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
    });
    await listOpportunityPageIds({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      limit: 10,
      offset: 0,
      reviewFilter: 'all',
    });
    await listLatestOpportunityRelatedContext([
      '11111111-1111-4111-8111-111111111111',
    ]);

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
    });

    const [staleSql] = mocks.query.mock.calls[0] ?? [];
    expect(staleSql).toContain("<> 'stale'");

    mocks.query.mockClear();
    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'all',
    });
    const [defaultSql] = mocks.query.mock.calls[0] ?? [];
    expect(defaultSql).not.toContain("<> 'stale'");
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
    });
    const [defaultSql, ...defaultValues] = mocks.query.mock.calls[0] ?? [];
    expect(defaultSql).toMatch(/o\.status <> \$\d+/);
    expect(defaultValues).toContain('archived');

    mocks.query.mockClear();
    await countOpportunityRecords({
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, status: 'archived' },
      reviewFilter: 'all',
    });
    const [archivedSql, ...archivedValues] = mocks.query.mock.calls[0] ?? [];
    expect(archivedSql).toMatch(/o\.status = \$\d+/);
    expect(archivedSql).not.toMatch(/o\.status <> \$\d+/);
    expect(archivedValues).toContain('archived');
  });

  it('only sorts with scores matching the opportunity content fingerprint', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
      },
      limit: 25,
      offset: 0,
      reviewFilter: 'all',
    });

    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toMatch(
      /COALESCE\(es\.source_content_fingerprint, ''\) =\s+COALESCE\(o\.source_content_fingerprint, ''\)/,
    );
    expect(sql).not.toContain(
      "COALESCE(es.source_content_fingerprint, '') = ''\n          OR",
    );
  });

  it('uses the requested direction for a supported server sort', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
      candidateSkills: [],
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
        sortDirection: 'asc',
      },
      limit: 25,
      offset: 0,
      reviewFilter: 'all',
    });

    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('ORDER BY latest.score ASC NULLS LAST');
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

  it('covers the score lateral the triage preset sorts by', async () => {
    // Issue #452 asked whether the deck's `latest.score DESC` ordering has an
    // index behind it. It does: the lateral matches on `(opportunity_id,
    // COALESCE(source_content_fingerprint, ''))` and takes the newest row, and
    // this index is exactly that key plus `updated_at DESC`, with `score`
    // included so the lookup never visits the heap. No further index is
    // needed, and this asserts the definition cannot drift away from the join.
    const release = vi.fn(async () => {});
    const sessionQuery = vi.fn(async () => ({ rows: [] }));
    const acquireSession = vi.fn(async () => ({
      query: sessionQuery,
      release,
    }));
    const { createOpportunityWhereSql, ensureOpportunityListQueryIndexes } =
      await import('./admin-opportunity-query');

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

    // And the join it has to serve is still shaped that way.
    const { joins } = createOpportunityWhereSql({
      candidateSkills: [],
      filters: { ...DEFAULT_OPPORTUNITY_FILTERS, minScore: 1 },
      reviewFilter: 'unsorted',
    });
    const scoreJoin = joins.find((join) => join.includes('evaluation_scores'));
    expect(scoreJoin).toContain('es.opportunity_id = o.id');
    expect(scoreJoin).toContain(
      "COALESCE(es.source_content_fingerprint, '') =",
    );
    expect(scoreJoin).toContain('ORDER BY es.updated_at DESC');
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

  it('normalizes stored review decisions before filtering', async () => {
    const { countOpportunityRecords } = await import(
      './admin-opportunity-query'
    );

    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'apply',
    });
    await countOpportunityRecords({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      reviewFilter: 'unsorted',
    });

    const [applySql, ...applyParams] = mocks.query.mock.calls[0] ?? [];
    const [unsortedSql, ...unsortedParams] = mocks.query.mock.calls[1] ?? [];
    expect(applySql).toContain('lower(btrim(o.human_review_status)) = $1');
    // The trailing 'archived' is the default archived-status exclusion.
    expect(applyParams).toEqual(['apply', 'archived']);
    expect(unsortedSql).toContain(
      "COALESCE(lower(btrim(o.human_review_status)), '') NOT IN ($1, $2, $3)",
    );
    expect(unsortedParams).toEqual(['apply', 'maybe', 'reject', 'archived']);
  });

  it('keeps compensation, skill, fit, and score filters in the database query', async () => {
    const { listOpportunityPageIds } = await import(
      './admin-opportunity-query'
    );

    await listOpportunityPageIds({
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
    });

    const [sql, ...params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('regexp_split_to_array');
    expect(sql).toContain('NOT (EXISTS');
    expect(sql).toContain('o.salary_min IS NULL AND o.salary_max IS NULL');
    expect(sql).toContain('latest.score >=');
    expect(sql).toContain('latest.score <=');
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

    await listLatestOpportunityRelatedContext(ids);

    const [sql, idParam, limitParam] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('FROM applications a');
    expect(sql).toContain('FROM evaluation_scores es');
    expect(sql).toMatch(
      /COALESCE\(es\.source_content_fingerprint, ''\) =\s+COALESCE\(o\.source_content_fingerprint, ''\)/,
    );
    expect(sql.match(/LIMIT 1/g)).toHaveLength(2);
    expect(sql).toContain('WHERE o.id = ANY($1)');
    expect(sql).not.toContain('o.id::text');
    expect(sql).not.toContain('$1::text[]');
    expect(sql).toContain('LIMIT $2');
    expect(idParam).toEqual(ids);
    expect(limitParam).toBe(2);
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
