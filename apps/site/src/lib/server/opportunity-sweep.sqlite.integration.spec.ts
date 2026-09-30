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
  database: undefined as DatabaseInterface | undefined,
  insertProtectionBeforeUpdate: undefined as (() => Promise<void>) | undefined,
  recordAgentAudit: vi.fn(async () => ({ id: 'agent-run-1' })),
}));

function interceptedDatabase(database: DatabaseInterface) {
  const transact = database.transaction;
  if (!transact) throw new Error('SQLite transaction support is required.');
  const query = async (sql: string, ...params: unknown[]) => {
    if (
      sql.trimStart().startsWith('UPDATE opportunities') &&
      mocks.insertProtectionBeforeUpdate
    ) {
      const insertProtection = mocks.insertProtectionBeforeUpdate;
      mocks.insertProtectionBeforeUpdate = undefined;
      await insertProtection();
    }
    return await database.query(sql, ...params);
  };
  return {
    query,
    transaction: async <T>(run: (tx: { query: typeof query }) => Promise<T>) =>
      await transact(async () => await run({ query })),
  };
}

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => {
    if (!mocks.database) throw new Error('SQLite fixture is unavailable.');
    return interceptedDatabase(mocks.database);
  }),
}));
vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: vi.fn(() => undefined),
}));
vi.mock('./db.js', () => ({ getDbConfig: vi.fn(() => ({ type: 'sqlite' })) }));
vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed: vi.fn(async () => 0),
}));
vi.mock('./application-workflow.js', () => ({
  closeReviewTasksForArchivedOpportunities: vi.fn(async () => 0),
  recordAgentAudit: mocks.recordAgentAudit,
}));

let database: DatabaseInterface;

async function createTables() {
  for (const table of [
    'decisions',
    'applications',
    'sources',
    'opportunities',
  ]) {
    await database.query(`DROP TABLE IF EXISTS ${table}`);
  }
  await database.query(`CREATE TABLE opportunities (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, status TEXT NOT NULL,
    human_review_status TEXT, last_seen_at TEXT, title TEXT, freshness TEXT,
    archive_reason TEXT, updated_at TEXT
  )`);
  await database.query(
    'CREATE TABLE sources (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL)',
  );
  await database.query(
    'CREATE TABLE applications (id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL)',
  );
  await database.query(
    'CREATE TABLE decisions (id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, decision_by TEXT NOT NULL)',
  );
}

async function seedCandidate(id: string) {
  await database.query(
    "INSERT INTO sources (id, is_active) VALUES ('inactive', 0)",
  );
  await database.query(
    "INSERT INTO opportunities (id, source_id, status, human_review_status, last_seen_at, title) VALUES (?, 'inactive', 'found', 'needs_input', '2020-01-01T00:00:00.000Z', 'Fictional candidate')",
    id,
  );
}

async function opportunityStatus(id: string) {
  const result = await database.query(
    'SELECT status FROM opportunities WHERE id = ?',
    id,
  );
  return String((result.rows ?? [])[0]?.status ?? '');
}

beforeAll(async () => {
  database = await getDatabase({
    type: 'sqlite',
    url: ':memory:',
    cache: false,
  });
  mocks.database = database;
});
afterAll(async () => await database.close?.());
beforeEach(async () => {
  await createTables();
  mocks.insertProtectionBeforeUpdate = undefined;
  mocks.recordAgentAudit.mockReset();
  mocks.recordAgentAudit.mockResolvedValue({ id: 'agent-run-1' });
});

describe('inactive opportunity sweep on SQLite', () => {
  it.each([
    [
      'application',
      "INSERT INTO applications (id, opportunity_id) VALUES ('application-1', 'candidate')",
    ],
    [
      'owner decision',
      "INSERT INTO decisions (id, opportunity_id, decision_by) VALUES ('decision-1', 'candidate', 'owner')",
    ],
  ])('leaves a row protected by a concurrent %s untouched', async (_label, statement) => {
    await seedCandidate('candidate');
    mocks.insertProtectionBeforeUpdate = async () => {
      await database.query(statement);
    };
    const { sweepInactiveSourceOpportunities } = await import(
      './opportunity-sweep'
    );

    const result = await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: new Date('2026-09-30T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      count: 1,
      lockedCount: 1,
      archivedCount: 0,
      skippedCount: 1,
    });
    expect(await opportunityStatus('candidate')).toBe('found');
  });

  it('rolls back its archive when the audit cannot be recorded', async () => {
    await seedCandidate('candidate');
    mocks.recordAgentAudit.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    const { sweepInactiveSourceOpportunities } = await import(
      './opportunity-sweep'
    );

    await expect(
      sweepInactiveSourceOpportunities({
        dryRun: false,
        now: new Date('2026-09-30T00:00:00.000Z'),
      }),
    ).rejects.toThrow('audit unavailable');
    expect(await opportunityStatus('candidate')).toBe('found');
  });
});
