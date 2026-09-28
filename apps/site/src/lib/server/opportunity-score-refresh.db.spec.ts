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

const mocks = vi.hoisted(() => ({
  control: {
    id: 'control-1',
    scoreRefreshCursor: '',
    save: vi.fn(async () => {}),
  },
  enqueue: vi.fn(async () => ({ enqueued: true, job: { id: 'job-1' } })),
  opportunities: new Map<string, Record<string, unknown>>(),
  scheduleUpsert: vi.fn(async () => ({})),
}));

vi.mock('@happyvertical/smrt-agents', () => ({
  AgentScheduleCollection: {
    create: vi.fn(async () => ({ getOrUpsert: mocks.scheduleUpsert })),
  },
}));
vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed: vi.fn(async () => {}),
}));
vi.mock('./db.js', () => ({ getDbConfig: vi.fn(() => ({})) }));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  ensureOpportunityIntelligenceControl: vi.fn(async () => {}),
  OPPORTUNITY_INTELLIGENCE_CONTROL_KEY: 'opportunity-intelligence',
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: mocks.enqueue,
}));
vi.mock('./opportunity-intelligence.js', () => ({
  scoringMaterialForOpportunity: vi.fn(
    async (opportunity: Record<string, unknown>) => ({
      fingerprint: String(opportunity.testMaterial),
      sourceContentFingerprint: String(opportunity.sourceContentFingerprint),
      sourceContentVersion: 1,
    }),
  ),
}));
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (name: string) => {
    if (name === 'Opportunity')
      return { get: async (id: string) => mocks.opportunities.get(id) ?? null };
    return { list: async () => [mocks.control] };
  }),
}));

const postgresUrl = process.env.TRIAGE_TEST_POSTGRES_URL?.trim();

async function setup(
  database: DatabaseInterface,
  dialect: 'sqlite' | 'postgres',
) {
  const temporary = dialect === 'postgres' ? 'TEMP ' : '';
  if (dialect === 'sqlite') {
    await database.query('DROP TABLE IF EXISTS evaluation_scores');
    await database.query('DROP TABLE IF EXISTS opportunities');
  }
  await database.query(`CREATE ${temporary}TABLE opportunities (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, source_content_fingerprint TEXT,
    scoring_material_fingerprint TEXT, scoring_refresh_fingerprint TEXT,
    scoring_refresh_attempts INTEGER NOT NULL DEFAULT 0,
    scoring_refresh_next_attempt_at TIMESTAMP, updated_at TIMESTAMP
  )`);
  await database.query(`CREATE ${temporary}TABLE evaluation_scores (
    id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL,
    source_content_fingerprint TEXT, scoring_material_fingerprint TEXT,
    created_by_profile_id TEXT, updated_at TIMESTAMP
  )`);
}

function suite(
  label: string,
  config: { type: 'sqlite' | 'postgres'; url: string },
) {
  describe(label, () => {
    let database: DatabaseInterface;

    beforeAll(async () => {
      database = await getDatabase(
        config.type === 'postgres'
          ? { ...config, cache: false, max: 1 }
          : { ...config, cache: false },
      );
      await setup(database, config.type);
    });
    beforeEach(async () => {
      if (config.type === 'postgres') {
        await database.query(
          'TRUNCATE TABLE pg_temp.evaluation_scores, pg_temp.opportunities',
        );
      } else {
        await database.query('DELETE FROM evaluation_scores');
        await database.query('DELETE FROM opportunities');
      }
      mocks.control.scoreRefreshCursor = '';
      mocks.control.save.mockClear();
      mocks.enqueue.mockClear();
      mocks.scheduleUpsert.mockClear();
      mocks.opportunities.clear();
    });
    afterAll(async () => {
      await database.close?.();
    });

    it('registers the singleton generic schedule idempotently', async () => {
      const { ensureOpportunityScoreRefreshSchedule } = await import(
        './opportunity-score-refresh'
      );
      await ensureOpportunityScoreRefreshSchedule(database);
      await ensureOpportunityScoreRefreshSchedule(database);
      expect(mocks.scheduleUpsert).toHaveBeenCalledTimes(2);
      expect(mocks.scheduleUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cron: '* * * * *',
          maxConcurrent: 1,
          method: 'refreshSavedEvaluationScores',
          slug: 'opportunity-score-refresh',
        }),
      );
    });

    it('reconciles target atomically, preserves timestamps on no-op, and preserves human scores', async () => {
      await database.query(`INSERT INTO opportunities (id,status,source_content_fingerprint,scoring_material_fingerprint,scoring_refresh_fingerprint,scoring_refresh_attempts,updated_at)
        VALUES ('a','found','source-a','','',0,'2026-01-01T00:00:00Z'),
               ('b','found','source-b','','',0,'2026-01-02T00:00:00Z')`);
      await database.query(`INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id,updated_at)
        VALUES ('score-a','a','source-a','old','','2026-01-01T00:00:00Z'),
               ('human-b','b','source-b','old','profile-1','2026-01-01T00:00:00Z')`);
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: '',
        scoringRefreshAttempts: 0,
        testMaterial: 'new-a',
      });
      mocks.opportunities.set('b', {
        id: 'b',
        sourceContentFingerprint: 'source-b',
        scoringMaterialFingerprint: '',
        scoringRefreshAttempts: 0,
        testMaterial: 'new-b',
      });
      const { reconcileSavedOpportunityScores } = await import(
        './opportunity-score-refresh'
      );
      await expect(
        reconcileSavedOpportunityScores(mocks.control as never, {
          db: database,
          now: new Date('2026-02-01T00:00:00Z'),
        }),
      ).resolves.toMatchObject({ enqueued: 1, scanned: 2 });
      const row = await database.query(
        "SELECT scoring_material_fingerprint, scoring_refresh_attempts, updated_at FROM opportunities WHERE id = 'a'",
      );
      expect(row.rows[0]).toMatchObject({
        scoring_material_fingerprint: 'new-a',
        scoring_refresh_attempts: 1,
        updated_at: expect.anything(),
      });
      const before = row.rows[0]?.updated_at;
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: 'new-a',
        scoringRefreshAttempts: 1,
        testMaterial: 'new-a',
      });
      await database.query(
        "INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id,updated_at) VALUES ('fresh-a','a','source-a','new-a','','2026-02-01T00:00:00Z')",
      );
      mocks.control.scoreRefreshCursor = '';
      await reconcileSavedOpportunityScores(mocks.control as never, {
        db: database,
        now: new Date('2026-02-01T00:01:00Z'),
      });
      const after = await database.query(
        "SELECT updated_at FROM opportunities WHERE id = 'a'",
      );
      expect(after.rows[0]?.updated_at).toEqual(before);
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    });

    it('uses a durable cursor and caps retries for an unchanged target', async () => {
      await database.query(`INSERT INTO opportunities (id,status,source_content_fingerprint,scoring_material_fingerprint,scoring_refresh_fingerprint,scoring_refresh_attempts)
        VALUES ('a','found','source-a','material-a','material-a',3), ('z','found','source-z','','',0)`);
      await database.query(
        "INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id) VALUES ('score-a','a','source-a','old',''), ('score-z','z','source-z','old','')",
      );
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: 'material-a',
        scoringRefreshAttempts: 3,
        testMaterial: 'material-a',
      });
      mocks.opportunities.set('z', {
        id: 'z',
        sourceContentFingerprint: 'source-z',
        scoringMaterialFingerprint: '',
        scoringRefreshAttempts: 0,
        testMaterial: 'material-z',
      });
      const { reconcileSavedOpportunityScores } = await import(
        './opportunity-score-refresh'
      );
      const result = await reconcileSavedOpportunityScores(
        mocks.control as never,
        { db: database, now: new Date('2026-02-01T00:00:00Z') },
      );
      expect(result).toMatchObject({ enqueued: 1, scanned: 2 });
      expect(mocks.control.save).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledWith(
        'z',
        expect.anything(),
        expect.anything(),
      );
    });
  });
}

suite('sqlite', { type: 'sqlite', url: ':memory:' });
if (postgresUrl)
  suite('disposable PostgreSQL', { type: 'postgres', url: postgresUrl });
