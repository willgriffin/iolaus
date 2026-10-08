import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown, ensure: vi.fn() }));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<object>()),
  resolveDatabase: async () => state.db,
}));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./opportunity-analysis.js', () => ({
  ensureOpportunityAnalysis: state.ensure,
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));

import { ensureAnalysisBudgetWindow } from './opportunity-analysis-enrichment.js';
import {
  backfillOpportunityAnalyses,
  claimAnalysisWindowSlot,
  ensureOpportunityAnalysisMaintenanceSchema,
  pruneExpiredOpportunityAnalyses,
} from './opportunity-analysis-maintenance.js';

describe.each([
  'sqlite',
  ...(process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL ? ['postgres'] : []),
])('analysis maintenance real %s', (dialect) => {
  let db: DatabaseInterface,
    admin: DatabaseInterface | undefined,
    dir = '',
    schema = '';
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  beforeEach(async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_ENABLED', 'true');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '8');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '100000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '50000');
    if (dialect === 'postgres') {
      schema = `analysis_maintenance_${randomUUID().replaceAll('-', '')}`;
      admin = await getDatabase({
        type: 'postgres',
        url: String(process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL),
        cache: false,
      });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(
        String(process.env.ANALYSIS_LEDGER_TEST_DATABASE_URL),
      );
      url.searchParams.set('options', `-csearch_path=${schema}`);
      db = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        cache: false,
      });
    } else {
      dir = await mkdtemp(join(tmpdir(), 'analysis-maintenance-'));
      db = await getDatabase({
        type: 'sqlite',
        url: `file:${join(dir, 'db.sqlite')}`,
        cache: false,
      });
    }
    state.db = db;
    state.ensure.mockReset().mockResolvedValue({ status: 'deterministic' });
    await ensureOpportunityAnalysisMaintenanceSchema(db);
    const key = dialect === 'postgres' ? 'UUID' : 'TEXT';
    await db.query(
      `CREATE TABLE opportunities (id ${key} PRIMARY KEY,source_content_fingerprint TEXT,status TEXT,current_analysis_id ${key})`,
    );
    await db.query(
      `CREATE TABLE opportunity_analyses (id ${key} PRIMARY KEY,opportunity_id ${key},source_content_fingerprint TEXT,requirements_json TEXT,updated_at TIMESTAMP)`,
    );
    await db.query(`CREATE TABLE opportunity_skills (analysis_id ${key})`);
    await db.query(
      `CREATE TABLE opportunity_recommendation_ranks (opportunity_id ${key},source_content_fingerprint TEXT)`,
    );
    await db.query(
      'CREATE TABLE requirement_evidence_decisions (requirement_hash TEXT)',
    );
    await db.query(`CREATE TABLE agent_runs (id ${key} PRIMARY KEY,slug TEXT,context TEXT,tenant_id TEXT,owner_user_id TEXT,candidate_profile_id TEXT,run_type TEXT,status TEXT,
      intelligence_call_limit INTEGER,intelligence_input_token_limit INTEGER,intelligence_spend_limit_micros INTEGER,
      intelligence_reserved_calls INTEGER,intelligence_reserved_input_tokens INTEGER,intelligence_reserved_spend_micros INTEGER,
      intelligence_actual_calls INTEGER,intelligence_actual_input_tokens INTEGER,intelligence_actual_output_tokens INTEGER,intelligence_actual_spend_micros INTEGER,
      input_json TEXT,started_at TIMESTAMP,created_at TIMESTAMP,updated_at TIMESTAMP)`);
    for (const id of ids)
      await db.query(
        'INSERT INTO opportunities (id,source_content_fingerprint,status) VALUES (?, ?, ?)',
        [id, 'source', 'active'],
      );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close?.();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close?.();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('uses a valid UUID durable money window without raising or resetting funds', async () => {
    const first = await ensureAnalysisBudgetWindow(1000);
    await db.query(
      'UPDATE agent_runs SET intelligence_actual_spend_micros=100 WHERE id=?',
      [first],
    );
    expect(await ensureAnalysisBudgetWindow(2000)).toBe(first);
    expect(
      (
        await db.query(
          'SELECT intelligence_spend_limit_micros,intelligence_actual_spend_micros FROM agent_runs',
        )
      ).rows[0],
    ).toMatchObject({
      intelligence_spend_limit_micros: 1000,
      intelligence_actual_spend_micros: 100,
    });
    await ensureAnalysisBudgetWindow(500);
    expect(
      (await db.query('SELECT intelligence_spend_limit_micros FROM agent_runs'))
        .rows[0],
    ).toMatchObject({ intelligence_spend_limit_micros: 500 });
  });
  it('resumes stable keyset cursor including native UUID first page', async () => {
    const first = await backfillOpportunityAnalyses({ max: 1 });
    expect(first).toMatchObject({ analyzed: 1, truncated: true });
    expect(first.nextCursor).toBeTruthy();
    const second = await backfillOpportunityAnalyses({
      max: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second).toMatchObject({
      analyzed: 1,
      truncated: false,
      nextCursor: null,
    });
    expect(state.ensure.mock.calls.map((call) => call[0])).toEqual(ids);
  });
  it('atomically enforces hourly and daily bounds without partial increments', async () => {
    await claimAnalysisWindowSlot(db, '2026-10-07T10');
    await db.query(
      "UPDATE opportunity_analysis_windows SET processed_count=299 WHERE window_id='day:2026-10-07'",
    );
    expect(await claimAnalysisWindowSlot(db, '2026-10-07T11')).toBe(true);
    expect(await claimAnalysisWindowSlot(db, '2026-10-07T12')).toBe(false);
    expect(
      (
        await db.query(
          "SELECT * FROM opportunity_analysis_windows WHERE window_id='hour:2026-10-07T12'",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('retains private-referenced and current analyses, pruning only old unreferenced rows', async () => {
    const hash = 'a'.repeat(64),
      old = '2020-01-01T00:00:00Z',
      extra = randomUUID();
    for (const id of [...ids, extra]) {
      await db.query(
        'INSERT INTO opportunity_analyses VALUES (?, ?, ?, ?, ?)',
        [
          id,
          ids[0],
          'source',
          JSON.stringify(id === ids[0] ? [{ hash }] : []),
          old,
        ],
      );
      await db.query('INSERT INTO opportunity_skills VALUES (?)', [id]);
    }
    await db.query('INSERT INTO requirement_evidence_decisions VALUES (?)', [
      hash,
    ]);
    await db.query(
      'UPDATE opportunities SET current_analysis_id=? WHERE id=?',
      [ids[1], ids[0]],
    );
    expect(await pruneExpiredOpportunityAnalyses(db)).toBe(1);
    expect(
      (await db.query('SELECT id FROM opportunity_analyses')).rows,
    ).toHaveLength(2);
    expect(
      (await db.query('SELECT analysis_id FROM opportunity_skills')).rows,
    ).toHaveLength(2);
  });
  it('retains an old analysis referenced by a private recommendation provenance', async () => {
    await db.query('INSERT INTO opportunity_analyses VALUES (?, ?, ?, ?, ?)', [
      ids[0],
      ids[0],
      'old-source',
      '[]',
      '2020-01-01T00:00:00Z',
    ]);
    await db.query(
      'INSERT INTO opportunity_recommendation_ranks VALUES (?, ?)',
      [ids[0], 'old-source'],
    );
    expect(await pruneExpiredOpportunityAnalyses(db)).toBe(0);
  });
  it('rejects malformed cursor, unbounded max and implicit paid budgets', async () => {
    await expect(backfillOpportunityAnalyses({ max: 301 })).rejects.toThrow();
    await expect(
      backfillOpportunityAnalyses({ max: 1, cursor: '?' }),
    ).rejects.toThrow();
    await expect(
      backfillOpportunityAnalyses({ max: 1, enrich: true }),
    ).rejects.toThrow();
    expect(state.ensure).not.toHaveBeenCalled();
  });
});
