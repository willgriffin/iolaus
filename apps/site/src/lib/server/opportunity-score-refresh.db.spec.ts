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
    await database.query(
      'DROP TABLE IF EXISTS opportunity_intelligence_controls',
    );
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
  await database.query(`CREATE ${temporary}TABLE opportunity_intelligence_controls (
    id TEXT PRIMARY KEY, score_refresh_cursor TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0, circuit_state TEXT NOT NULL DEFAULT 'open',
    circuit_reason TEXT NOT NULL DEFAULT '', request_threshold INTEGER NOT NULL DEFAULT 20,
    updated_at TIMESTAMP
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
          'TRUNCATE TABLE pg_temp.evaluation_scores, pg_temp.opportunities, pg_temp.opportunity_intelligence_controls',
        );
      } else {
        await database.query('DELETE FROM evaluation_scores');
        await database.query('DELETE FROM opportunities');
        await database.query('DELETE FROM opportunity_intelligence_controls');
      }
      await database.query(
        "INSERT INTO opportunity_intelligence_controls (id,score_refresh_cursor,enabled,circuit_state,circuit_reason,request_threshold) VALUES ('control-1','',1,'closed','governed',77)",
      );
      mocks.control.scoreRefreshCursor = '';
      mocks.control.save.mockClear();
      mocks.control.save.mockImplementation(async () => {});
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
      expect(mocks.control.save).not.toHaveBeenCalled();
      expect(mocks.enqueue).toHaveBeenCalledWith(
        'z',
        expect.anything(),
        expect.anything(),
      );
    });

    it('allows only one overlapping reservation for the same retryable target', async () => {
      await database.query(`INSERT INTO opportunities (id,status,source_content_fingerprint,scoring_material_fingerprint,scoring_refresh_fingerprint,scoring_refresh_attempts)
        VALUES ('a','found','source-a','material-a','material-a',0)`);
      await database.query(
        "INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id) VALUES ('score-a','a','source-a','old','')",
      );
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: 'material-a',
        scoringRefreshFingerprint: 'material-a',
        scoringRefreshAttempts: 0,
        testMaterial: 'material-a',
      });
      const { reconcileSavedOpportunityScores } = await import(
        './opportunity-score-refresh'
      );
      const now = new Date('2026-02-01T00:00:00Z');
      await Promise.all([
        reconcileSavedOpportunityScores(mocks.control as never, {
          db: database,
          now,
        }),
        reconcileSavedOpportunityScores(
          { ...mocks.control, save: vi.fn(async () => {}) } as never,
          { db: database, now },
        ),
      ]);
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      const row = await database.query(
        "SELECT scoring_refresh_attempts, scoring_refresh_next_attempt_at FROM opportunities WHERE id = 'a'",
      );
      expect(row.rows[0]).toMatchObject({ scoring_refresh_attempts: 1 });
      expect(row.rows[0]?.scoring_refresh_next_attempt_at).toBeTruthy();
    });

    it('does not enqueue after the source changes between targeting and reservation', async () => {
      await database.query(`INSERT INTO opportunities (id,status,source_content_fingerprint,scoring_material_fingerprint,scoring_refresh_fingerprint,scoring_refresh_attempts)
        VALUES ('a','found','source-a','','',0)`);
      await database.query(
        "INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id) VALUES ('score-a','a','source-a','old','')",
      );
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: '',
        scoringRefreshAttempts: 0,
        testMaterial: 'material-a',
      });
      const mutatingDatabase = {
        query: async (sql: string, args?: unknown[]) => {
          const result = await database.query(sql, args);
          if (sql.includes('SET scoring_material_fingerprint')) {
            await database.query(
              "UPDATE opportunities SET source_content_fingerprint = 'source-new' WHERE id = 'a'",
            );
          }
          return result;
        },
      };
      const { reconcileSavedOpportunityScores } = await import(
        './opportunity-score-refresh'
      );
      await reconcileSavedOpportunityScores(mocks.control as never, {
        db: mutatingDatabase as never,
        now: new Date('2026-02-01T00:00:00Z'),
      });
      expect(mocks.enqueue).not.toHaveBeenCalled();
      const row = await database.query(
        "SELECT scoring_refresh_attempts FROM opportunities WHERE id = 'a'",
      );
      expect(row.rows[0]).toMatchObject({ scoring_refresh_attempts: 0 });
    });

    it('updates only the durable cursor and leaves concurrent governance values intact', async () => {
      await database.query(`INSERT INTO opportunities (id,status,source_content_fingerprint,scoring_material_fingerprint,scoring_refresh_fingerprint,scoring_refresh_attempts)
        VALUES ('a','found','source-a','material-a','material-a',3)`);
      await database.query(
        "INSERT INTO evaluation_scores (id,opportunity_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id) VALUES ('score-a','a','source-a','old','')",
      );
      mocks.opportunities.set('a', {
        id: 'a',
        sourceContentFingerprint: 'source-a',
        scoringMaterialFingerprint: 'material-a',
        scoringRefreshFingerprint: 'material-a',
        scoringRefreshAttempts: 3,
        testMaterial: 'material-a',
      });
      mocks.control.save.mockImplementation(async () => {
        await database.query(
          "UPDATE opportunity_intelligence_controls SET enabled = 0, circuit_state = 'open', circuit_reason = 'stale-save', request_threshold = 1 WHERE id = 'control-1'",
        );
      });
      const staleControl = {
        ...mocks.control,
        enabled: false,
        circuitState: 'open',
        circuitReason: 'stale-save',
        requestThreshold: 1,
      };
      const { reconcileSavedOpportunityScores } = await import(
        './opportunity-score-refresh'
      );
      await reconcileSavedOpportunityScores(staleControl as never, {
        db: database,
        now: new Date('2026-02-01T00:00:00Z'),
      });
      expect(mocks.control.save).not.toHaveBeenCalled();
      const row = await database.query(
        "SELECT score_refresh_cursor, enabled, circuit_state, circuit_reason, request_threshold FROM opportunity_intelligence_controls WHERE id = 'control-1'",
      );
      expect(row.rows[0]).toMatchObject({
        score_refresh_cursor: '',
        enabled: 1,
        circuit_state: 'closed',
        circuit_reason: 'governed',
        request_threshold: 77,
      });
    });
  });
}

suite('sqlite', { type: 'sqlite', url: ':memory:' });
if (postgresUrl)
  suite('disposable PostgreSQL', { type: 'postgres', url: postgresUrl });
