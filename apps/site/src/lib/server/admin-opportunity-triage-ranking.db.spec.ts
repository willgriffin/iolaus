import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  config: { type: 'sqlite' },
  database: undefined as DatabaseInterface | undefined,
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => {
    if (!mocks.database) throw new Error('Test database is not initialized.');
    return mocks.database;
  }),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: vi.fn(() => undefined),
}));

vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => mocks.config),
}));

const postgresUrl = process.env.TRIAGE_TEST_POSTGRES_URL?.trim();

async function createTables(
  database: DatabaseInterface,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  const createOpportunityTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} opportunities (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    human_review_status TEXT,
    source_content_fingerprint TEXT,
    updated_at TIMESTAMP,
    posted_at TIMESTAMP,
    first_seen_at TIMESTAMP,
    company_id TEXT,
    title TEXT,
    description_summary TEXT,
    required_skills TEXT,
    preferred_skills TEXT,
    locations TEXT,
    posting_url TEXT,
    expires_at TIMESTAMP,
    freshness TEXT,
    salary_min REAL,
    salary_max REAL,
    human_rating REAL
  )`;
  const createScoreTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} evaluation_scores (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    source_content_fingerprint TEXT,
    updated_at TIMESTAMP,
    score REAL,
    recommendation TEXT
  )`;
  const createCompanyTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} companies (
    id TEXT PRIMARY KEY,
    name TEXT
  )`;
  if (dialect === 'postgres') {
    // The opt-in suite never names a persistent table. `pg_temp` resolves only
    // for this test connection, so reset cannot touch the supplied database.
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
    await database.query(createCompanyTable);
    await database.query(
      'TRUNCATE TABLE pg_temp.evaluation_scores, pg_temp.opportunities, pg_temp.companies',
    );
  } else {
    await database.query('DROP TABLE IF EXISTS evaluation_scores');
    await database.query('DROP TABLE IF EXISTS opportunities');
    await database.query('DROP TABLE IF EXISTS companies');
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
    await database.query(createCompanyTable);
  }
  const opportunityTable =
    dialect === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
  const scoreTable =
    dialect === 'postgres' ? 'pg_temp.evaluation_scores' : 'evaluation_scores';
  const tabNewlineReject =
    dialect === 'postgres'
      ? "chr(9) || 'reject' || chr(10)"
      : "char(9) || 'reject' || char(10)";
  const nbspBomReject =
    dialect === 'postgres'
      ? "chr(160) || chr(65279) || 'reject' || chr(160)"
      : "char(160) || char(65279) || 'reject' || char(160)";
  await database.query(`INSERT INTO ${opportunityTable}
    (id, status, human_review_status, source_content_fingerprint, updated_at, posted_at)
    VALUES
    ('reject-100', 'recommended', '', 'current-reject', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('recommend-96', 'recommended', '', 'current-recommend', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ('score-96-tie', 'recommended', '', 'current-score-tie', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ('unscored', 'recommended', '', 'current-unscored', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
    ('unknown-90', 'recommended', '', 'current-unknown', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
    ('reject-20', 'recommended', '', 'current-reject-low', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
    ('matches-list-context', 'found', '', 'match-current', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    ('wrong-skill', 'found', '', 'wrong-skill-current', '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z'),
    ('wrong-search', 'found', '', 'wrong-search-current', '2026-02-03T00:00:00Z', '2026-02-03T00:00:00Z'),
    ('wrong-status', 'recommended', '', 'wrong-status-current', '2026-02-04T00:00:00Z', '2026-02-04T00:00:00Z'),
    ('expired', 'found', '', 'expired-current', '2026-02-05T00:00:00Z', '2026-02-05T00:00:00Z'),
    ('stale', 'found', '', 'stale-current', '2026-02-06T00:00:00Z', '2026-02-06T00:00:00Z'),
    ('decided', 'found', 'apply', 'decided-current', '2026-02-07T00:00:00Z', '2026-02-07T00:00:00Z')`);
  await database.query(`UPDATE ${opportunityTable}
    SET title = 'Platform Rust Engineer',
        description_summary = 'A platform role',
        required_skills = 'Rust, TypeScript',
        preferred_skills = 'PostgreSQL',
        locations = 'Remote',
        posting_url = 'https://example.test/platform-rust',
        expires_at = '2099-01-01T00:00:00Z',
        freshness = 'fresh',
        salary_min = 120000,
        salary_max = 160000,
        human_rating = 4
    WHERE id IN ('matches-list-context', 'wrong-skill', 'wrong-search', 'wrong-status', 'expired', 'stale', 'decided')`);
  await database.query(`UPDATE ${opportunityTable}
    SET required_skills = 'Java', preferred_skills = 'Kotlin'
    WHERE id = 'wrong-skill'`);
  await database.query(`UPDATE ${opportunityTable}
    SET title = 'Infrastructure Engineer', description_summary = 'A systems role',
        posting_url = 'https://example.test/infrastructure'
    WHERE id = 'wrong-search'`);
  await database.query(`UPDATE ${opportunityTable}
    SET expires_at = '2000-01-01T00:00:00Z' WHERE id = 'expired'`);
  await database.query(`UPDATE ${opportunityTable}
    SET freshness = 'stale' WHERE id = 'stale'`);
  await database.query(`INSERT INTO ${scoreTable}
    (id, opportunity_id, source_content_fingerprint, updated_at, score, recommendation)
    VALUES
    ('reject-100-current', 'reject-100', 'current-reject', '2026-01-06T00:00:00Z', 100, ${tabNewlineReject}),
    ('recommend-96-current', 'recommend-96', 'current-recommend', '2026-01-06T00:00:00Z', 96, 'recommend'),
    ('score-96-tie-current', 'score-96-tie', 'current-score-tie', '2026-01-06T00:00:00Z', 96, 'recommend'),
    ('unknown-90-current', 'unknown-90', 'current-unknown', '2026-01-06T00:00:00Z', 90, 'unknown'),
    ('reject-20-current', 'reject-20', 'current-reject-low', '2026-01-06T00:00:00Z', 20, ${nbspBomReject}),
    ('unscored-stale', 'unscored', 'stale-content', '2026-01-07T00:00:00Z', 98, 'reject'),
    ('matches-list-context-score', 'matches-list-context', 'match-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-skill-score', 'wrong-skill', 'wrong-skill-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-search-score', 'wrong-search', 'wrong-search-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-status-score', 'wrong-status', 'wrong-status-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('expired-score', 'expired', 'expired-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('stale-score', 'stale', 'stale-current', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('decided-score', 'decided', 'decided-current', '2026-02-08T00:00:00Z', 80, 'recommend')`);
}

function query(triageRejectDepriority = false) {
  return {
    candidateSkills: [],
    filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' as const },
    reviewFilter: 'unsorted',
    triageRejectDepriority,
  };
}

const listContextRankings = [
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unknown-90',
      'wrong-status',
      'reject-20',
      'unscored',
    ],
    sort: 'best' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unknown-90',
      'wrong-status',
      'reject-20',
      'unscored',
    ],
    sort: 'best' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unscored',
      'unknown-90',
      'reject-20',
      'wrong-status',
    ],
    sort: 'newest' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'newest' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'reject-20',
      'wrong-status',
      'unknown-90',
      'recommend-96',
      'score-96-tie',
      'reject-100',
      'unscored',
    ],
    sort: 'score' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unknown-90',
      'wrong-status',
      'reject-20',
      'unscored',
    ],
    sort: 'score' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'salary' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'salary' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'rating' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'rating' as const,
    sortDirection: 'desc' as const,
  },
] as const;

function runSuite(
  label: string,
  config: { type: 'postgres' | 'sqlite'; url: string },
) {
  describe(label, () => {
    let database: DatabaseInterface;

    beforeAll(async () => {
      database = await getDatabase(
        config.type === 'postgres'
          ? { cache: false, ...config, max: 1 }
          : { cache: false, ...config },
      );
      mocks.config = { type: config.type };
      mocks.database = database;
    });

    beforeEach(async () => {
      await createTables(database, config.type);
    });

    afterAll(async () => {
      await database?.close?.();
      mocks.database = undefined;
    });

    it('orders current nonrejects before explicit rejects and preserves paging', async () => {
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const first = await listOpportunityPageIds({
        ...query(true),
        limit: 3,
        offset: 0,
      });
      const second = await listOpportunityPageIds({
        ...query(true),
        limit: 3,
        offset: 3,
      });

      expect(first).toEqual(['recommend-96', 'score-96-tie', 'unknown-90']);
      expect(second).toEqual(['stale', 'expired', 'wrong-status']);
    });

    it('does not change ordinary numeric score and newest ordering', async () => {
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const numeric = await listOpportunityPageIds({
        ...query(),
        limit: 10,
        offset: 0,
      });
      const newest = await listOpportunityPageIds({
        ...query(true),
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'newest' },
        limit: 10,
        offset: 0,
      });

      expect(numeric).toEqual([
        'reject-100',
        'recommend-96',
        'score-96-tie',
        'unknown-90',
        'stale',
        'expired',
        'wrong-status',
        'wrong-search',
        'wrong-skill',
        'matches-list-context',
      ]);
      expect(newest).toEqual([
        'stale',
        'expired',
        'wrong-status',
        'wrong-search',
        'wrong-skill',
        'matches-list-context',
        'reject-20',
        'unknown-90',
        'unscored',
        'recommend-96',
      ]);
    });

    it.each(
      listContextRankings,
    )('orders the recommended list $sort/$sortDirection exactly', async ({
      expected,
      sort,
      sortDirection,
    }) => {
      const { countOpportunityRecords, listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const listQuery = {
        ...query(false),
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          sort,
          sortDirection,
          status: 'recommended',
        },
      };
      await expect(countOpportunityRecords(listQuery)).resolves.toBe(
        expected.length,
      );
      await expect(
        listOpportunityPageIds({
          ...listQuery,
          limit: 100,
          offset: 0,
        }),
      ).resolves.toEqual(expected);
    });

    it.runIf(config.type === 'postgres')(
      'matches the list query only when every inherited filter still matches',
      async () => {
        const { countOpportunityRecords, listOpportunityPageIds } =
          await import('./admin-opportunity-query');
        const matchingQuery = {
          candidateSkills: [],
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            excludeExpired: true,
            excludeStale: true,
            skills: ['Rust'],
            sort: 'score' as const,
            status: 'found',
          },
          reviewFilter: 'unsorted',
          search: 'platform',
          triageRejectDepriority: false,
        };

        await expect(countOpportunityRecords(matchingQuery)).resolves.toBe(1);
        await expect(
          listOpportunityPageIds({ ...matchingQuery, limit: 10, offset: 0 }),
        ).resolves.toEqual(['matches-list-context']);
      },
    );

    it('returns only bounded, fingerprint-current SQLite score context', async () => {
      const { listCurrentOpportunityScores } = await import(
        './admin-opportunity-query'
      );
      const scores = await listCurrentOpportunityScores([
        'recommend-96',
        'unscored',
      ]);

      expect(scores).toEqual(
        new Map([
          ['recommend-96', { recommendation: 'recommend', score: 96 }],
          ['unscored', { recommendation: '', score: null }],
        ]),
      );
    });
  });
}

runSuite('triage ranking SQL on SQLite', { type: 'sqlite', url: ':memory:' });

describe.skipIf(!postgresUrl)('triage ranking SQL on PostgreSQL', () => {
  runSuite('isolated temporary tables', {
    type: 'postgres',
    url: postgresUrl!,
  });
});
