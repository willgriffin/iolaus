import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDbConfig } from './db.js';
import { inspectSourceCrawlItemQuarantine } from './source-crawl-item-quarantine.js';

const runPostgresCoverage = process.env.SOURCE_CRAWL_ITEM_QUARANTINE_DB === '1';
const schema = `source_crawl_item_quarantine_${randomUUID().replaceAll('-', '')}`;
const NOW = new Date('2026-08-31T12:00:00.000Z');
type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type DbSession = Awaited<
  ReturnType<NonNullable<SmrtDatabase['acquireSession']>>
>;

describe.runIf(runPostgresCoverage)(
  'source crawl item quarantine on PostgreSQL',
  () => {
    let database: SmrtDatabase;
    let session: DbSession | undefined;

    beforeAll(async () => {
      database = await resolveDatabase(getDbConfig(), {
        dbid: `source-crawl-item-quarantine-test-${randomUUID()}`,
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
      await session.query('DROP TABLE IF EXISTS source_crawl_items CASCADE');
      await session.query('DROP TABLE IF EXISTS source_crawls CASCADE');
      await session.query(`
        CREATE TABLE source_crawls (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TIMESTAMP,
          finished_at TIMESTAMP
        )
      `);
      await session.query(`
        CREATE TABLE source_crawl_items (
          id TEXT PRIMARY KEY, source_crawl_id TEXT NOT NULL,
          outcome TEXT NOT NULL, terminal_at TIMESTAMP, opportunity_id TEXT,
          status TEXT NOT NULL DEFAULT ''
        )
      `);
      await session.query("SET TIME ZONE 'America/Edmonton'");
      await session.query(`
        INSERT INTO source_crawls (id, status, started_at, finished_at)
        VALUES ('crawl-1', 'running', TIMESTAMP '2026-08-31 11:57:00', NULL)
      `);
      await session.query(`
        INSERT INTO source_crawl_items (
          id, source_crawl_id, outcome, terminal_at, opportunity_id, status
        ) VALUES ('item-1', 'crawl-1', 'pending', NULL, NULL, 'pending')
      `);
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

    it('uses the PostgreSQL epoch for a timezone-less timestamp at the timeout boundary', async () => {
      if (!session) throw new Error('Missing PostgreSQL session.');
      const plan = await inspectSourceCrawlItemQuarantine(session as never, {
        crawlId: 'crawl-1',
        itemId: 'item-1',
        now: NOW,
      });

      expect(plan).toMatchObject({
        eligible: true,
        reason: expect.any(String),
      });
    });
  },
);
