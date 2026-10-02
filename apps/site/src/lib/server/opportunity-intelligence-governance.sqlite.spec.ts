import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', keys: [] as string[] }));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./change-feed.js', () => ({
  bumpOpportunityTableChangeFeed: vi.fn(),
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));
vi.mock('./sqlite-operation-lock.js', async () => {
  const { withKeyedFileLock } = await import(
    '../../../../../scripts/smrt-keyed-lock.mjs'
  );
  return {
    withSqliteOperationLock: async <T>(
      key: string,
      action: () => Promise<T>,
    ) => {
      state.keys.push(key);
      return await withKeyedFileLock(
        { stateRoot: state.root, key, retryMs: 1 },
        action,
      );
    },
  };
});

import {
  DatabaseOpportunityIntelligenceGovernanceStore,
  type OpportunityIntelligenceReservation,
} from './opportunity-intelligence-governance';

const ownershipColumns =
  "tenant_id TEXT DEFAULT '', owner_user_id TEXT DEFAULT '', candidate_profile_id TEXT DEFAULT ''";
const budgetColumns = `intelligence_call_limit INTEGER DEFAULT 2,
  intelligence_input_token_limit INTEGER DEFAULT 100,
  intelligence_spend_limit_micros INTEGER DEFAULT 100,
  intelligence_reserved_calls INTEGER DEFAULT 0,
  intelligence_reserved_input_tokens INTEGER DEFAULT 0,
  intelligence_reserved_spend_micros INTEGER DEFAULT 0,
  intelligence_actual_calls INTEGER DEFAULT 0,
  intelligence_actual_input_tokens INTEGER DEFAULT 0,
  intelligence_actual_output_tokens INTEGER DEFAULT 0,
  intelligence_actual_spend_micros INTEGER DEFAULT 0, updated_at TEXT`;

function reservation(
  id: string,
  overrides: Partial<OpportunityIntelligenceReservation> = {},
): OpportunityIntelligenceReservation {
  return {
    agentRunId: 'run-1',
    contentFingerprint: 'content-1',
    feature: 'opportunity-extraction',
    model: 'fixture/model',
    opportunityId: `opp-${id}`,
    outputSchemaVersion: 'schema/v1',
    preparedPayloadVersion: 'prepared/v1',
    profile: 'fixture',
    promptVersion: 'prompt/v1',
    estimatedInputTokens: 10,
    idempotencyKey: `key-${id}`,
    inputTokenCeiling: 10,
    maxOutputTokens: 5,
    requestId: `request-${id}`,
    reservedInputTokens: 10,
    reservedSpendMicros: 20,
    sourceCrawlId: 'crawl-1',
    ...overrides,
  };
}

describe.each([
  false,
  true,
])('real SQLite governance (built-in driver: %s)', (native) => {
  let directory = '';
  let db: DatabaseInterface;
  let otherDb: DatabaseInterface;
  let store: DatabaseOpportunityIntelligenceGovernanceStore;
  let otherStore: DatabaseOpportunityIntelligenceGovernanceStore;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(await realpath(tmpdir()), 'iolaus-governance-'),
    );
    state.root = directory;
    state.keys = [];
    const config = {
      type: 'sqlite' as const,
      url: `file:${join(directory, 'ledger.sqlite')}`,
      cache: false,
      ...(native
        ? {
            secureFile: {
              driver: 'node:sqlite' as const,
              custody: 'trusted-parent' as const,
              root: directory,
            },
          }
        : {}),
    };
    db = await getDatabase(config);
    await db.query(
      `CREATE TABLE agent_runs (id TEXT PRIMARY KEY, ${ownershipColumns}, ${budgetColumns})`,
    );
    await db.query(
      `CREATE TABLE source_crawls (id TEXT PRIMARY KEY, ${budgetColumns})`,
    );
    await db.query(`CREATE TABLE opportunity_intelligence_controls (
      id TEXT PRIMARY KEY, control_key TEXT UNIQUE, enabled INTEGER DEFAULT 1,
      circuit_state TEXT DEFAULT 'closed', circuit_reason TEXT DEFAULT '', opened_at TEXT,
      window_request_count INTEGER DEFAULT 0, window_input_tokens INTEGER DEFAULT 0,
      request_threshold INTEGER DEFAULT 100, input_token_threshold INTEGER DEFAULT 1000000,
      consecutive_failures INTEGER DEFAULT 0, consecutive_aborts INTEGER DEFAULT 0,
      latency_threshold_ms INTEGER DEFAULT 10000, abort_threshold INTEGER DEFAULT 3,
      failure_threshold INTEGER DEFAULT 3, last_request_at TEXT, updated_at TEXT)`);
    await db.query(`CREATE TABLE opportunity_intelligence_results (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, idempotency_key TEXT UNIQUE,
      opportunity_id TEXT, ${ownershipColumns}, source_crawl_id TEXT, source_crawl_item_id TEXT,
      agent_run_id TEXT, content_fingerprint TEXT, input_fingerprint TEXT, prepared_payload_version TEXT,
      prompt_version TEXT, output_schema_version TEXT, feature TEXT, profile TEXT, model TEXT,
      status TEXT, owner_request_id TEXT, request_id TEXT, output_json TEXT, error_code TEXT,
      started_at TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT)`);
    await db.query(`CREATE TABLE opportunity_intelligence_requests (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, request_id TEXT UNIQUE, provider_request_id TEXT,
      idempotency_key TEXT, feature TEXT, source_crawl_id TEXT, source_crawl_item_id TEXT,
      opportunity_id TEXT, ${ownershipColumns}, agent_run_id TEXT, content_fingerprint TEXT,
      input_fingerprint TEXT, profile TEXT, model TEXT, provider TEXT, status TEXT, attempts INTEGER,
      estimated_input_tokens INTEGER, input_token_ceiling INTEGER, requested_max_output_tokens INTEGER,
      reserved_input_tokens INTEGER, reserved_spend_micros INTEGER, actual_input_tokens INTEGER,
      actual_output_tokens INTEGER, actual_total_tokens INTEGER, actual_spend_micros INTEGER,
      accounting_basis TEXT, duration_ms INTEGER, error_code TEXT, started_at TEXT,
      created_at TEXT, updated_at TEXT, finished_at TEXT)`);
    await db.query("INSERT INTO agent_runs (id) VALUES ('run-1'), ('run-2')");
    await db.query("INSERT INTO source_crawls (id) VALUES ('crawl-1')");
    await db.query(
      "INSERT INTO opportunity_intelligence_controls (id,control_key) VALUES ('control-1','opportunity-intelligence')",
    );
    otherDb = await getDatabase(config);
    expect(otherDb).not.toBe(db);
    store = new DatabaseOpportunityIntelligenceGovernanceStore(db);
    otherStore = new DatabaseOpportunityIntelligenceGovernanceStore(otherDb);
  });

  afterEach(async () => {
    try {
      await otherDb?.close?.();
      await db?.close?.();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  async function row(table: string, id = 'run-1') {
    return (await db.query(`SELECT * FROM ${table} WHERE id = ?`, [id]))
      .rows[0];
  }

  it('proves INSERT ownership from the returned ID on the pinned native transaction', async () => {
    if (!db.transaction)
      throw new Error('Native SQLite transaction unavailable.');
    await db.transaction(async (transaction) => {
      const sql = `INSERT INTO opportunity_intelligence_results (id, idempotency_key)
        VALUES (?, ?) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
      const inserted = await transaction.query(sql, [
        'metadata-proof',
        'metadata-key',
      ]);
      const duplicate = await transaction.query(sql, [
        'another-id',
        'metadata-key',
      ]);
      expect(inserted.rows.map((item) => item.id)).toEqual(['metadata-proof']);
      expect(duplicate.rows).toEqual([]);
      console.info('SQLite INSERT RETURNING metadata', {
        native,
        insertedRowCount: inserted.rowCount,
        insertedRows: inserted.rows.length,
        duplicateRowCount: duplicate.rowCount,
        duplicateRows: duplicate.rows.length,
      });
    });
  });

  it('serializes duplicate reservations across separate database handles with one owner and ledger request', async () => {
    const r = reservation('same');
    const outcomes = await Promise.all([
      store.reserve(r),
      otherStore.reserve(r),
    ]);
    expect(outcomes.map((x) => x.kind).sort()).toEqual(['blocked', 'owner']);
    expect(outcomes.find((x) => x.kind === 'blocked')).toMatchObject({
      code: 'duplicate_in_progress',
    });
    expect(
      (await db.query('SELECT * FROM opportunity_intelligence_requests')).rows,
    ).toHaveLength(1);
    expect(await row('agent_runs')).toMatchObject({
      intelligence_reserved_calls: 1,
      intelligence_reserved_spend_micros: 20,
    });
    expect(new Set(state.keys)).toEqual(
      new Set(['opportunity-intelligence-governance']),
    );
  });

  it.each([
    ['calls', 'intelligence_call_limit', 1],
    ['input tokens', 'intelligence_input_token_limit', 10],
    ['spend', 'intelligence_spend_limit_micros', 20],
  ])('enforces the shared run %s cap for concurrent different opportunities and rolls back the loser', async (_label, column, limit) => {
    await db.query(`UPDATE agent_runs SET ${column} = ? WHERE id = 'run-1'`, [
      limit,
    ]);
    const outcomes = await Promise.all([
      store.reserve(reservation('a')),
      otherStore.reserve(reservation('b')),
    ]);
    expect(outcomes.map((x) => x.kind).sort()).toEqual(['blocked', 'owner']);
    expect(
      (await db.query('SELECT * FROM opportunity_intelligence_results')).rows,
    ).toHaveLength(1);
    expect(await row('agent_runs')).toMatchObject({
      intelligence_reserved_calls: 1,
      intelligence_reserved_input_tokens: 10,
      intelligence_reserved_spend_micros: 20,
    });
    expect(
      await row('opportunity_intelligence_controls', 'control-1'),
    ).toMatchObject({ window_request_count: 1, circuit_state: 'open' });
  });

  it('enforces a global control cap across distinct runs and crawl budgets', async () => {
    await db.query(
      'UPDATE opportunity_intelligence_controls SET request_threshold = 1',
    );
    const outcomes = await Promise.all([
      store.reserve(reservation('a')),
      otherStore.reserve(reservation('b', { agentRunId: 'run-2' })),
    ]);
    expect(outcomes.map((x) => x.kind).sort()).toEqual(['blocked', 'owner']);
    expect(await row('source_crawls', 'crawl-1')).toMatchObject({
      intelligence_reserved_calls: 1,
    });
    expect(
      await row('opportunity_intelligence_controls', 'control-1'),
    ).toMatchObject({ window_request_count: 1 });
  });

  it('rolls back the reserved run and result when the crawl budget refuses', async () => {
    await db.query(
      'UPDATE source_crawls SET intelligence_spend_limit_micros = 1',
    );
    expect(await store.reserve(reservation('refused'))).toMatchObject({
      kind: 'blocked',
      code: 'budget_exhausted',
    });
    expect(await row('agent_runs')).toMatchObject({
      intelligence_reserved_calls: 0,
    });
    expect(
      (await db.query('SELECT * FROM opportunity_intelligence_results')).rows,
    ).toHaveLength(0);
  });

  it('settles actual usage in the same ledger and reuses completed global extraction without another reservation', async () => {
    const r = reservation('complete');
    expect(await store.reserve(r)).toMatchObject({ kind: 'owner' });
    await otherStore.complete(r, {
      status: 'succeeded',
      output: { title: 'Captured' },
      durationMs: 1,
      accountingBasis: 'actual',
      actualSpendMicros: 7,
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    });
    for (const [table, id] of [
      ['agent_runs', 'run-1'],
      ['source_crawls', 'crawl-1'],
    ]) {
      expect(await row(table, id)).toMatchObject({
        intelligence_reserved_calls: 0,
        intelligence_reserved_spend_micros: 0,
        intelligence_actual_calls: 1,
        intelligence_actual_input_tokens: 4,
        intelligence_actual_output_tokens: 2,
        intelligence_actual_spend_micros: 7,
      });
    }
    expect(await store.reserve(r)).toMatchObject({
      kind: 'reused',
      output: { title: 'Captured' },
    });
    expect(
      (await db.query('SELECT * FROM opportunity_intelligence_requests')).rows,
    ).toHaveLength(1);
  });

  it('retains candidate scope and refuses a foreign run without ledger or budget writes', async () => {
    await db.query(
      "UPDATE agent_runs SET tenant_id='tenant-a', owner_user_id='user-a', candidate_profile_id='profile-a' WHERE id='run-1'",
    );
    const r = reservation('candidate', {
      workspaceSubject: {
        tenantId: 'tenant-a',
        userId: 'user-a',
        profileId: 'profile-a',
      },
      sourceCrawlId: '',
    });
    expect(await store.reserve(r)).toMatchObject({ kind: 'owner' });
    const foreign = reservation('foreign', {
      workspaceSubject: {
        tenantId: 'tenant-b',
        userId: 'user-b',
        profileId: 'profile-b',
      },
      sourceCrawlId: '',
    });
    expect(await otherStore.reserve(foreign)).toMatchObject({
      kind: 'blocked',
      code: 'budget_missing',
    });
    expect(await row('agent_runs')).toMatchObject({
      intelligence_reserved_calls: 1,
    });
    expect(
      (await db.query('SELECT tenant_id FROM opportunity_intelligence_results'))
        .rows,
    ).toEqual([{ tenant_id: 'tenant-a' }]);
  });

  it('accounts a failed invocation conservatively and never reuses its failed output', async () => {
    const r = reservation('failure');
    expect(await store.reserve(r)).toMatchObject({ kind: 'owner' });
    await store.complete(r, {
      status: 'failed',
      durationMs: 1,
      actualSpendMicros: 20,
      accountingBasis: 'conservative',
    });
    expect(await row('agent_runs')).toMatchObject({
      intelligence_reserved_calls: 0,
      intelligence_actual_calls: 1,
      intelligence_actual_input_tokens: 10,
      intelligence_actual_output_tokens: 5,
      intelligence_actual_spend_micros: 20,
    });
    expect(await otherStore.reserve(r)).toMatchObject({
      kind: 'blocked',
      code: 'prior_attempt_failed',
    });
  });
});
