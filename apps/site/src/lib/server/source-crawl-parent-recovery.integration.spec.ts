import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDbConfig } from './db.js';
import {
  applySourceCrawlParentRecovery,
  inspectSourceCrawlParentRecovery,
} from './source-crawl-parent-recovery.js';

const runPostgresCoverage = process.env.SOURCE_CRAWL_PARENT_RECOVERY_DB === '1';
const schema = `source_crawl_parent_${randomUUID().replaceAll('-', '')}`;
type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type DbSession = Awaited<
  ReturnType<NonNullable<SmrtDatabase['acquireSession']>>
>;

function transactionalSession(session: DbSession): SmrtDatabase {
  return {
    query: session.query.bind(session),
    transaction: async <T>(work: (db: DbSession) => Promise<T>) => {
      await session.query('BEGIN');
      try {
        const result = await work(session);
        await session.query('COMMIT');
        return result;
      } catch (error) {
        await session.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as SmrtDatabase;
}

describe.runIf(runPostgresCoverage)(
  'source crawl parent recovery on PostgreSQL',
  () => {
    let database: SmrtDatabase;
    let session: DbSession | undefined;

    beforeAll(async () => {
      database = await resolveDatabase(getDbConfig(), {
        dbid: `source-crawl-parent-recovery-test-${randomUUID()}`,
      });
      if (typeof database.acquireSession !== 'function') {
        throw new Error('PostgreSQL integration coverage requires sessions.');
      }
      session = await database.acquireSession();
      await session.query(`CREATE SCHEMA ${schema}`);
      await session.query(`SET search_path TO ${schema}, public`);
    });

    beforeEach(async () => {
      if (!session) throw new Error('Missing PostgreSQL session.');
      for (const table of [
        'data_repair_audit',
        'data_repair_runs',
        'source_crawl_items',
        '_smrt_jobs',
        'source_crawls',
      ]) {
        await session.query(`DROP TABLE IF EXISTS ${schema}.${table} CASCADE`);
      }
      await session.query(`
        CREATE TABLE source_crawls (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, status TEXT NOT NULL,
          job_id TEXT NOT NULL, job_attempt INTEGER, started_at TIMESTAMP,
          finished_at TIMESTAMP, error TEXT NOT NULL DEFAULT '',
          result_count INTEGER, new_opportunity_count INTEGER,
          duplicate_count INTEGER, skipped_count INTEGER,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          terminal_count INTEGER NOT NULL DEFAULT 0,
          pending_count INTEGER NOT NULL DEFAULT 0,
          reused_count INTEGER NOT NULL DEFAULT 0,
          relisted_count INTEGER NOT NULL DEFAULT 0,
          failed_persistence_count INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await session.query(`
        CREATE TABLE _smrt_jobs (
          id TEXT PRIMARY KEY, object_id TEXT, status TEXT, attempts INTEGER,
          queue TEXT, object_type TEXT, method TEXT,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await session.query(`
        CREATE TABLE source_crawl_items (
          id TEXT PRIMARY KEY, source_crawl_id TEXT NOT NULL,
          attempt_key TEXT NOT NULL, outcome TEXT NOT NULL,
          terminal_at TIMESTAMP, opportunity_id TEXT,
          status TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await seedEligible(session);
    });

    afterAll(async () => {
      if (!session) return;
      try {
        await session.query('SET search_path TO public');
        await session.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await session.release();
      }
    });

    it('archives all rows, terminalizes conservatively, and replays exactly', async () => {
      if (!session) throw new Error('Missing PostgreSQL session.');
      const db = transactionalSession(session);
      const now = await databaseNow(session);
      const plan = await inspectSourceCrawlParentRecovery(db, {
        crawlId: 'crawl-1',
        now,
      });
      expect(plan.eligible).toBe(true);
      const input = {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: plan.fingerprint,
        now,
        reason: 'Integration test confirms failed legacy ownership.',
      };
      const first = await applySourceCrawlParentRecovery(db, input);
      const retry = await applySourceCrawlParentRecovery(db, input);
      expect(retry).toEqual(first);
      expect(first).toMatchObject({ archivedRows: 4, status: 'timed_out' });
      const parent = await session.query(
        'SELECT status, finished_at AS "finishedAt" FROM source_crawls WHERE id = ?',
        ['crawl-1'],
      );
      expect(parent.rows[0]?.status).toBe('timed_out');
      expect(parent.rows[0]?.finishedAt).not.toBeNull();
      const audits = await session.query(
        `SELECT table_name AS "tableName", before_data AS "beforeData"
         FROM data_repair_audit ORDER BY table_name, row_id`,
      );
      expect(audits.rows).toHaveLength(4);
      expect(audits.rows.every((row) => row.beforeData != null)).toBe(true);
      const runs = await session.query(
        'SELECT COUNT(*)::integer AS count FROM data_repair_runs',
      );
      expect(runs.rows[0]?.count).toBe(1);
    });

    it('rolls the archives and accounting back when the terminal fence rejects', async () => {
      if (!session) throw new Error('Missing PostgreSQL session.');
      const db = transactionalSession(session);
      const now = await databaseNow(session);
      const plan = await inspectSourceCrawlParentRecovery(db, {
        crawlId: 'crawl-1',
        now,
      });
      await session.query(`
        CREATE FUNCTION reject_parent_timeout() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced timeout rejection'; END;
        $$ LANGUAGE plpgsql
      `);
      await session.query(`
        CREATE TRIGGER reject_parent_timeout
        BEFORE UPDATE ON source_crawls
        FOR EACH ROW WHEN (NEW.status = 'timed_out')
        EXECUTE FUNCTION reject_parent_timeout()
      `);
      await expect(
        applySourceCrawlParentRecovery(db, {
          backupSha256: 'b'.repeat(64),
          crawlId: 'crawl-1',
          expectedFingerprint: plan.fingerprint,
          now,
          reason: 'Exercise transaction rollback.',
        }),
      ).rejects.toThrow('Failed to execute session query');
      const parent = await session.query(
        'SELECT status, finished_at AS "finishedAt" FROM source_crawls WHERE id = ?',
        ['crawl-1'],
      );
      expect(parent.rows[0]).toEqual({ finishedAt: null, status: 'running' });
      await expect(countRows(session, 'data_repair_audit')).resolves.toBe(0);
      await expect(countRows(session, 'data_repair_runs')).resolves.toBe(0);
    });

    it('refuses a worker ownership change after inspection without audit writes', async () => {
      if (!session) throw new Error('Missing PostgreSQL session.');
      const db = transactionalSession(session);
      const now = await databaseNow(session);
      const plan = await inspectSourceCrawlParentRecovery(db, {
        crawlId: 'crawl-1',
        now,
      });
      await session.query(
        'UPDATE source_crawls SET job_attempt = 4 WHERE id = ?',
        ['crawl-1'],
      );
      await expect(
        applySourceCrawlParentRecovery(db, {
          backupSha256: 'b'.repeat(64),
          crawlId: 'crawl-1',
          expectedFingerprint: plan.fingerprint,
          now,
          reason: 'Must reject newly acquired ownership.',
        }),
      ).rejects.toThrow('plan changed');
      await expect(countRows(session, 'data_repair_audit')).resolves.toBe(0);
      expect(
        (
          await session.query(
            'SELECT status, job_attempt AS "jobAttempt" FROM source_crawls WHERE id = ?',
            ['crawl-1'],
          )
        ).rows[0],
      ).toEqual({ jobAttempt: 4, status: 'running' });
    });
  },
);

async function seedEligible(session: DbSession): Promise<void> {
  await session.query(
    `INSERT INTO source_crawls (
       id, source_id, status, job_id, job_attempt, started_at, finished_at
     ) VALUES (?, ?, 'running', ?, 0, CURRENT_TIMESTAMP - INTERVAL '1 hour', NULL)`,
    ['crawl-1', 'source-1', 'job-1'],
  );
  await session.query(
    `INSERT INTO _smrt_jobs (
       id, object_id, status, attempts, queue, object_type, method
     ) VALUES (?, ?, 'failed', 3, 'agents', '@willgriffin/iolaus-site:Source', 'crawl')`,
    ['job-1', 'source-1'],
  );
  await session.query(
    `INSERT INTO source_crawl_items (
       id, source_crawl_id, attempt_key, outcome, terminal_at, opportunity_id
     ) VALUES
       ('item-1', 'crawl-1', 'attempt-1', 'created', CURRENT_TIMESTAMP, 'opportunity-1'),
       ('item-2', 'crawl-1', 'attempt-2', 'failed_persistence', CURRENT_TIMESTAMP, NULL)`,
  );
}

async function countRows(session: DbSession, table: string): Promise<number> {
  const exists = await session.query('SELECT to_regclass(?)::text AS name', [
    `${schema}.${table}`,
  ]);
  if (!exists.rows[0]?.name) return 0;
  const count = await session.query(
    `SELECT COUNT(*)::integer AS count FROM ${schema}.${table}`,
  );
  return Number(count.rows[0]?.count ?? 0);
}

async function databaseNow(session: DbSession): Promise<Date> {
  const result = await session.query(
    'SELECT CURRENT_TIMESTAMP AS "currentTimestamp"',
  );
  const value = result.rows[0]?.currentTimestamp;
  const now = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(now.getTime()))
    throw new Error('Invalid database clock.');
  return now;
}
