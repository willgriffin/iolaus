import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveDatabase: vi.fn() }));
vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: mocks.resolveDatabase,
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));

const indexName = 'idx_smrt_jobs_opportunity_intelligence_active_material';
const sqliteIndex = `CREATE UNIQUE INDEX ${indexName} ON _smrt_jobs (
  queue, object_type, object_id, method,
  COALESCE(args ->> 'contentFingerprint', ''),
  COALESCE(args ->> 'scoringMaterialFingerprint', '')
) WHERE status IN ('pending', 'running')
  AND queue = 'opportunity-intelligence'
  AND object_type = '@willgriffin/iolaus-site:Opportunity'
  AND method = 'processIntelligence' AND object_id IS NOT NULL`;

const postgresIndex = `CREATE UNIQUE INDEX ${indexName} ON public._smrt_jobs USING btree (
  queue, object_type, object_id, method,
  COALESCE((args ->> 'contentFingerprint'::text), ''::text),
  COALESCE((args ->> 'scoringMaterialFingerprint'::text), ''::text)
) WHERE ((status = ANY (ARRAY['pending'::text, 'running'::text]))
  AND (queue = 'opportunity-intelligence'::text)
  AND (object_type = '@willgriffin/iolaus-site:Opportunity'::text)
  AND (method = 'processIntelligence'::text) AND (object_id IS NOT NULL))`;

type SchemaModule = typeof import('./opportunity-intelligence-job-schema');

describe.each([
  { label: 'SQLite adapter', native: false },
  { label: 'native SQLite adapter', native: true },
])('opportunity intelligence material index: $label', ({ native }) => {
  let db: DatabaseInterface;
  let schema: SchemaModule;
  let fixtureDirectory: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    fixtureDirectory = native
      ? await mkdtemp(
          join(await realpath(tmpdir()), 'iolaus-intelligence-dedupe-'),
        )
      : undefined;
    db = await getDatabase({
      type: 'sqlite',
      url: fixtureDirectory
        ? `file:${join(fixtureDirectory, 'jobs.sqlite')}`
        : ':memory:',
      cache: false,
      ...(native
        ? {
            secureFile: {
              driver: 'node:sqlite' as const,
              custody: 'trusted-parent' as const,
              root: fixtureDirectory,
            },
          }
        : {}),
    });
    await db.query(`CREATE TABLE _smrt_jobs (
      id TEXT PRIMARY KEY, queue TEXT, object_type TEXT, object_id TEXT,
      method TEXT, args TEXT, status TEXT, priority INTEGER DEFAULT 0,
      run_at TEXT, created_at TEXT, last_error TEXT,
      worker_id TEXT, worker_heartbeat TEXT
    )`);
    mocks.resolveDatabase.mockReset().mockResolvedValue(db);
    schema = await import('./opportunity-intelligence-job-schema');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await db?.close?.();
    } finally {
      if (fixtureDirectory) {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    }
  });

  async function insert(
    id: string,
    options: {
      content?: string;
      material?: string;
      status?: string;
      queue?: string;
    } = {},
  ) {
    await db.query(
      `INSERT INTO _smrt_jobs
        (id, queue, object_type, object_id, method, args, status, run_at, created_at)
       VALUES (?, ?, ?, 'opp-1', 'processIntelligence', ?, ?, '2026-10-02', '2026-10-02')`,
      [
        id,
        options.queue ?? 'opportunity-intelligence',
        '@willgriffin/iolaus-site:Opportunity',
        JSON.stringify({
          contentFingerprint: options.content,
          scoringMaterialFingerprint: options.material,
        }),
        options.status ?? 'pending',
      ],
    );
  }

  it('attests the exact unique partial expression index without runtime DDL', async () => {
    await db.query(sqliteIndex);
    const query = vi.spyOn(db, 'query');
    await expect(
      schema.ensureOpportunityIntelligenceJobDedupe(),
    ).resolves.toBeUndefined();
    expect(await schema.getOpportunityIntelligenceJobDedupeStatus(db)).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: true,
    });
    expect(
      query.mock.calls.every(([sql]) => /^(SELECT|PRAGMA)\b/i.test(sql.trim())),
    ).toBe(true);
  });

  it('fails closed on a missing index and never installs one at runtime', async () => {
    const query = vi.spyOn(db, 'query');
    await expect(
      schema.ensureOpportunityIntelligenceJobDedupe(),
    ).rejects.toThrow('run db:migrate');
    expect(await schema.getOpportunityIntelligenceJobDedupeStatus(db)).toEqual({
      activeIndexNamed: false,
      activeIndexPresent: false,
    });
    expect(
      query.mock.calls.every(([sql]) => /^SELECT\b/i.test(sql.trim())),
    ).toBe(true);
    // A rejected cached verification must permit a later explicit migration.
    query.mockRestore();
    await db.query(sqliteIndex);
    await expect(
      schema.ensureOpportunityIntelligenceJobDedupe(),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['non-unique', sqliteIndex.replace('CREATE UNIQUE INDEX', 'CREATE INDEX')],
    [
      'missing material fingerprint',
      sqliteIndex.replace(
        ",\n  COALESCE(args ->> 'scoringMaterialFingerprint', '')",
        '',
      ),
    ],
    ['wrong status', sqliteIndex.replace("'running'", "'completed'")],
    [
      'wrong method literal case',
      sqliteIndex.replace("'processIntelligence'", "'PROCESSINTELLIGENCE'"),
    ],
    ['missing partial predicate', sqliteIndex.split(' WHERE ')[0]],
  ])('rejects the same-name %s index at runtime without repairs', async (_label, definition) => {
    await db.query(definition);
    const query = vi.spyOn(db, 'query');
    expect(await schema.getOpportunityIntelligenceJobDedupeStatus(db)).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: false,
    });
    await expect(
      schema.ensureOpportunityIntelligenceJobDedupe(),
    ).rejects.toThrow('run db:migrate');
    expect(
      query.mock.calls.every(([sql]) => /^(SELECT|PRAGMA)\b/i.test(sql.trim())),
    ).toBe(true);
  });

  it('installs only through the explicit migration handle, reconciles duplicates and is repeatable', async () => {
    await insert('first', { content: 'content-1', material: 'material-1' });
    await insert('second', { content: 'content-1', material: 'material-1' });
    await schema.ensureOpportunityIntelligenceJobDedupe(db);
    expect(
      (await db.query('SELECT id, status FROM _smrt_jobs ORDER BY id')).rows,
    ).toEqual([
      { id: 'first', status: 'pending' },
      { id: 'second', status: 'cancelled' },
    ]);
    await schema.ensureOpportunityIntelligenceJobDedupe(db);
    expect(await schema.getOpportunityIntelligenceJobDedupeStatus(db)).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: true,
    });
    expect(mocks.resolveDatabase).not.toHaveBeenCalled();
  });

  it('recognizes the actual material-index conflict while admitting materially different and inactive jobs', async () => {
    await db.query(sqliteIndex);
    await insert('original', { content: 'content-1', material: 'material-1' });
    let conflict: unknown;
    try {
      await insert('duplicate', {
        content: 'content-1',
        material: 'material-1',
        status: 'running',
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeDefined();
    expect(schema.isOpportunityIntelligenceActiveJobConflict(conflict)).toBe(
      true,
    );
    await insert('new-content', {
      content: 'content-2',
      material: 'material-1',
    });
    await insert('new-material', {
      content: 'content-1',
      material: 'material-2',
    });
    await insert('inactive', {
      content: 'content-1',
      material: 'material-1',
      status: 'completed',
    });
    await insert('other-queue', {
      content: 'content-1',
      material: 'material-1',
      queue: 'another-queue',
    });
    await expect(insert('original', { content: 'other' })).rejects.toSatisfy(
      (error: unknown) =>
        !schema.isOpportunityIntelligenceActiveJobConflict(error),
    );
  });

  it('coalesces absent fingerprint keys to enforce identical blank-material uniqueness', async () => {
    await db.query(sqliteIndex);
    await insert('blank-first');
    await expect(insert('blank-second')).rejects.toSatisfy(
      schema.isOpportunityIntelligenceActiveJobConflict,
    );
  });
});

describe('PostgreSQL intelligence catalog attestation', () => {
  it.each([
    ['valid', true, true, true, postgresIndex, true],
    ['not unique', false, true, true, postgresIndex, false],
    ['not ready', true, false, true, postgresIndex, false],
    ['not valid', true, true, false, postgresIndex, false],
    [
      'wrong definition',
      true,
      true,
      true,
      postgresIndex.replace("'running'", "'completed'"),
      false,
    ],
  ])('preserves %s catalog result', async (_label, unique, ready, valid, definition, expected) => {
    const { getOpportunityIntelligenceJobDedupeStatus } = await import(
      './opportunity-intelligence-job-schema'
    );
    const query = vi.fn(async (_statement: string) => ({
      rowCount: 1,
      rows: [
        {
          is_unique: unique,
          is_ready: ready,
          is_valid: valid,
          index_definition: definition,
        },
      ],
    }));
    expect(
      await getOpportunityIntelligenceJobDedupeStatus({
        query,
        url: 'postgres://localhost/test',
      }),
    ).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: expected,
    });
    expect(query.mock.calls[0]?.[0]).toContain('pg_get_indexdef');
  });

  it('fails closed without querying unsupported database dialects', async () => {
    const { getOpportunityIntelligenceJobDedupeStatus } = await import(
      './opportunity-intelligence-job-schema'
    );
    const query = vi.fn(async (_statement: string) => ({
      rows: [],
      rowCount: 0,
    }));
    await expect(
      getOpportunityIntelligenceJobDedupeStatus({
        query,
        url: '/tmp/test.duckdb',
      }),
    ).rejects.toThrow('dialect is unsupported');
    expect(query).not.toHaveBeenCalled();
  });

  it('recognizes PostgreSQL material and legacy fingerprint constraints, excluding unrelated or non-unique errors', async () => {
    const { isOpportunityIntelligenceActiveJobConflict } = await import(
      './opportunity-intelligence-job-schema'
    );
    for (const constraint of [
      indexName,
      'idx_smrt_jobs_opportunity_intelligence_active_fingerprint',
    ]) {
      expect(
        isOpportunityIntelligenceActiveJobConflict({
          code: '23505',
          constraint,
        }),
      ).toBe(true);
    }
    expect(
      isOpportunityIntelligenceActiveJobConflict({
        code: '23505',
        constraint: `${indexName}_other`,
      }),
    ).toBe(false);
    expect(
      isOpportunityIntelligenceActiveJobConflict({
        code: '23514',
        constraint: indexName,
      }),
    ).toBe(false);
  });
});
