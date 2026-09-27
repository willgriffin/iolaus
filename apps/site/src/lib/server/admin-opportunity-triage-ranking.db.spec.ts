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
    first_seen_at TIMESTAMP
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
  if (dialect === 'postgres') {
    // The opt-in suite never names a persistent table. `pg_temp` resolves only
    // for this test connection, so reset cannot touch the supplied database.
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
    await database.query(
      'TRUNCATE TABLE pg_temp.evaluation_scores, pg_temp.opportunities',
    );
  } else {
    await database.query('DROP TABLE IF EXISTS evaluation_scores');
    await database.query('DROP TABLE IF EXISTS opportunities');
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
  }
  const opportunityTable =
    dialect === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
  const scoreTable =
    dialect === 'postgres' ? 'pg_temp.evaluation_scores' : 'evaluation_scores';
  await database.query(`INSERT INTO ${opportunityTable}
    (id, status, human_review_status, source_content_fingerprint, updated_at, posted_at)
    VALUES
    ('reject-100', 'recommended', '', 'current-reject', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('recommend-96', 'recommended', '', 'current-recommend', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ('unscored', 'recommended', '', 'current-unscored', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
    ('unknown-90', 'recommended', '', 'current-unknown', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
    ('reject-20', 'recommended', '', 'current-reject-low', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z')`);
  await database.query(`INSERT INTO ${scoreTable}
    (id, opportunity_id, source_content_fingerprint, updated_at, score, recommendation)
    VALUES
    ('reject-100-current', 'reject-100', 'current-reject', '2026-01-06T00:00:00Z', 100, ' ReJeCt '),
    ('recommend-96-current', 'recommend-96', 'current-recommend', '2026-01-06T00:00:00Z', 96, 'recommend'),
    ('unknown-90-current', 'unknown-90', 'current-unknown', '2026-01-06T00:00:00Z', 90, 'unknown'),
    ('reject-20-current', 'reject-20', 'current-reject-low', '2026-01-06T00:00:00Z', 20, 'reject'),
    ('unscored-stale', 'unscored', 'stale-content', '2026-01-07T00:00:00Z', 98, 'reject')`);
}

function query(triageRejectDepriority = false) {
  return {
    candidateSkills: [],
    filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' as const },
    reviewFilter: 'unsorted',
    triageRejectDepriority,
  };
}

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

      expect(first).toEqual(['recommend-96', 'unknown-90', 'unscored']);
      expect(second).toEqual(['reject-100', 'reject-20']);
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
        'unknown-90',
        'reject-20',
        'unscored',
      ]);
      expect(newest).toEqual([
        'reject-20',
        'unknown-90',
        'unscored',
        'recommend-96',
        'reject-100',
      ]);
    });

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
