import { randomUUID } from 'node:crypto';
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
  ...(process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL
    ? ['postgres' as const]
    : []),
])('analysis retry ledger (driver: %s)', (native) => {
  let directory = '';
  let admin: DatabaseInterface | undefined;
  let schema = '';
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
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_MODEL', 'jev-test');
    const sqliteConfig = {
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
    if (native === 'postgres') {
      schema = `analysis_retry_${randomUUID().replaceAll('-', '')}`;
      admin = await getDatabase({
        type: 'postgres',
        url: String(process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL),
        cache: false,
      });
      await admin.query(`CREATE SCHEMA ${schema}`);
    }
    const url = new URL(
      process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL || 'postgres://unused',
    );
    if (schema) url.searchParams.set('options', `-csearch_path=${schema}`);
    const config =
      native === 'postgres'
        ? { type: 'postgres' as const, url: url.toString(), cache: false }
        : sqliteConfig;
    db = await getDatabase(config);
    await db.query(
      `CREATE TABLE agent_runs (id TEXT PRIMARY KEY, ${ownershipColumns}, ${budgetColumns})`,
    );
    await db.query(
      `CREATE TABLE source_crawls (id TEXT PRIMARY KEY, ${budgetColumns})`,
    );
    await db.query(`CREATE TABLE opportunity_intelligence_controls (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, created_at TEXT,
      window_started_at TEXT DEFAULT CURRENT_TIMESTAMP, control_key TEXT UNIQUE, enabled ${native === 'postgres' ? 'BOOLEAN DEFAULT TRUE' : 'INTEGER DEFAULT 1'},
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
    if (native === 'postgres') {
      for (const table of [
        'agent_runs',
        'source_crawls',
        'opportunity_intelligence_controls',
        'opportunity_intelligence_requests',
        'opportunity_intelligence_results',
      ]) {
        const dates = (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name LIKE '%_at'",
            [schema, table],
          )
        ).rows;
        for (const row of dates)
          await db.query(
            `ALTER TABLE ${table} ALTER COLUMN ${row.column_name} TYPE TIMESTAMPTZ USING ${row.column_name}::timestamptz`,
          );
      }
    }
    otherDb = await getDatabase(config);
    expect(otherDb).not.toBe(db);
    store = new DatabaseOpportunityIntelligenceGovernanceStore(db);
    otherStore = new DatabaseOpportunityIntelligenceGovernanceStore(otherDb);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await otherDb?.close?.();
      await db?.close?.();
      if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin?.close?.();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  function analysis(
    id: string,
    overrides: Partial<OpportunityIntelligenceReservation> = {},
  ) {
    return reservation(id, {
      analysisRetry: true,
      feature: 'opportunity-analysis',
      profile: 'opportunity-intelligence-extraction',
      model: 'openai/gpt-6-luna',
      sourceCrawlId: undefined,
      idempotencyKey: 'analysis-key',
      opportunityId: 'analysis-opportunity',
      ...overrides,
    });
  }
  const failure = {
    status: 'failed' as const,
    durationMs: 1,
    errorCode: 'provider_timeout',
    accountingBasis: 'actual' as const,
    actualSpendMicros: 10,
    usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
  };
  async function expandLimits() {
    await db.query(
      'UPDATE agent_runs SET intelligence_call_limit=8, intelligence_input_token_limit=1000, intelligence_spend_limit_micros=1000',
    );
    await db.query(
      'UPDATE opportunity_intelligence_controls SET failure_threshold=10',
    );
  }
  it('retries only explicit global analysis, bills each attempt, preserves failures, and caps at three', async () => {
    await expandLimits();
    for (let i = 1; i <= 3; i++) {
      const attempt = analysis(`retry-${i}`);
      expect(await store.reserve(attempt)).toMatchObject({ kind: 'owner' });
      expect(await otherStore.reserve(analysis(`parallel-${i}`))).toMatchObject(
        { kind: 'blocked', code: 'duplicate_in_progress' },
      );
      await store.complete(attempt, failure);
    }
    expect(await store.reserve(analysis('fourth'))).toMatchObject({
      kind: 'blocked',
      code: 'prior_attempt_failed',
    });
    expect(
      (await db.query('SELECT status FROM opportunity_intelligence_requests'))
        .rows,
    ).toHaveLength(3);
    expect(
      (
        await db.query(
          'SELECT intelligence_actual_calls,intelligence_actual_spend_micros,intelligence_reserved_calls FROM agent_runs WHERE id=?',
          ['run-1'],
        )
      ).rows[0],
    ).toMatchObject({
      intelligence_actual_calls: 3,
      intelligence_actual_spend_micros: 30,
      intelligence_reserved_calls: 0,
    });
  });
  it('keeps default failed-key semantics and denies cross-contract retry', async () => {
    await expandLimits();
    const attempt = analysis('first');
    expect(await store.reserve(attempt)).toMatchObject({ kind: 'owner' });
    await store.complete(attempt, failure);
    for (const overrides of [
      { analysisRetry: false },
      { feature: 'other' },
      { sourceCrawlId: 'crawl-1' },
      { model: 'other' },
    ])
      expect(await store.reserve(analysis('denied', overrides))).toMatchObject({
        kind: 'blocked',
        code: 'prior_attempt_failed',
      });
    expect(
      (
        await db.query(
          'SELECT request_id FROM opportunity_intelligence_requests',
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('rolls failed-result handover back when run or global provider budgets refuse', async () => {
    await expandLimits();
    const first = analysis('first');
    expect(await store.reserve(first)).toMatchObject({ kind: 'owner' });
    await store.complete(first, failure);
    await db.query('UPDATE agent_runs SET intelligence_call_limit=1');
    expect(await store.reserve(analysis('run-refused'))).toMatchObject({
      kind: 'blocked',
      code: 'budget_exhausted',
    });
    expect(
      (
        await db.query(
          'SELECT status,owner_request_id FROM opportunity_intelligence_results',
        )
      ).rows[0],
    ).toMatchObject({ status: 'failed', owner_request_id: first.requestId });
    await db.query('UPDATE agent_runs SET intelligence_call_limit=8');
    await db.query(
      "UPDATE opportunity_intelligence_controls SET circuit_state='closed'",
    );
    await db.query(
      "UPDATE opportunity_intelligence_controls SET request_threshold=1 WHERE control_key='opportunity-intelligence:volume:openai'",
    );
    expect(await store.reserve(analysis('global-refused'))).toMatchObject({
      kind: 'blocked',
      code: 'budget_exhausted',
    });
    expect(
      (
        await db.query(
          'SELECT request_id FROM opportunity_intelligence_requests',
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('returns successful retry output without another reservation or charge', async () => {
    await expandLimits();
    const first = analysis('first');
    expect(await store.reserve(first)).toMatchObject({ kind: 'owner' });
    await store.complete(first, failure);
    const second = analysis('second');
    expect(await store.reserve(second)).toMatchObject({ kind: 'owner' });
    await store.complete(second, {
      ...failure,
      status: 'succeeded',
      output: { safe: true },
    });
    expect(await store.reserve(analysis('third'))).toMatchObject({
      kind: 'reused',
      output: { safe: true },
      requestId: second.requestId,
    });
    expect(
      (
        await db.query(
          'SELECT intelligence_actual_calls FROM agent_runs WHERE id=?',
          ['run-1'],
        )
      ).rows[0],
    ).toMatchObject({ intelligence_actual_calls: 2 });
  });
});
