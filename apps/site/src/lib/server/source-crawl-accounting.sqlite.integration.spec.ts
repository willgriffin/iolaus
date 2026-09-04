import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSourceCrawlAttempt,
  finalizeSourceCrawlAttempt,
} from './source-crawl-accounting.js';
import {
  completeSourceCrawl,
  failSourceCrawl,
} from './source-crawl-watchdog.js';

describe('source crawl accounting on SQLite', () => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-crawl-accounting-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'accounting.sqlite'),
    });
    await database.query(`
      CREATE TABLE source_crawls (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        finished_at TIMESTAMP,
        error TEXT,
        result_count INTEGER,
        new_opportunity_count INTEGER,
        duplicate_count INTEGER,
        skipped_count INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        terminal_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        reused_count INTEGER NOT NULL DEFAULT 0,
        relisted_count INTEGER NOT NULL DEFAULT 0,
        failed_persistence_count INTEGER NOT NULL DEFAULT 0,
        intelligence_enqueued_count INTEGER NOT NULL DEFAULT 0,
        intelligence_duplicate_count INTEGER NOT NULL DEFAULT 0,
        intelligence_skipped_count INTEGER NOT NULL DEFAULT 0,
        job_id TEXT NOT NULL DEFAULT '',
        job_attempt INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await database.query(`
      CREATE TABLE opportunities (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL DEFAULT '',
        posting_url TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL DEFAULT ''
      )
    `);
    await database.query(`
      CREATE TABLE source_crawl_items (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        source_crawl_id TEXT,
        attempt_key TEXT,
        outcome TEXT,
        terminal_at TIMESTAMP,
        opportunity_id TEXT,
        duplicate_of_source_crawl_item_id TEXT,
        external_id TEXT,
        posting_url TEXT,
        canonical_url TEXT,
        title TEXT,
        company_name TEXT,
        status TEXT,
        content_fingerprint TEXT,
        content_version INTEGER,
        intelligence_enqueue_status TEXT,
        reason TEXT,
        raw_json TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterEach(async () => {
    await database.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  it('creates, finalizes, reconciles, and completes a local crawl', async () => {
    await database.query(
      `INSERT INTO source_crawls (id, source_id) VALUES (?, ?)`,
      ['crawl-complete', 'source-1'],
    );

    const first = await createSourceCrawlAttempt(database as never, {
      attemptKey: 'provider:1',
      sourceCrawlId: 'crawl-complete',
      title: 'Platform Engineer',
    });
    const replay = await createSourceCrawlAttempt(database as never, {
      attemptKey: 'provider:1',
      sourceCrawlId: 'crawl-complete',
      title: 'Platform Engineer',
    });
    expect(replay.id).toBe(first.id);

    await finalizeSourceCrawlAttempt(database as never, {
      attemptKey: 'provider:1',
      outcome: 'reused',
      opportunityId: 'opportunity-1',
      sourceCrawlId: 'crawl-complete',
    });
    const crawl = {
      finishedAt: null,
      id: 'crawl-complete',
      jobAttempt: 0,
      jobId: '',
      status: 'running',
    };
    await expect(
      completeSourceCrawl(
        crawl,
        { error: '', status: 'completed' },
        database as never,
      ),
    ).resolves.toBe(true);

    const result = await database.query(
      `SELECT status, attempt_count AS "attemptCount",
              terminal_count AS "terminalCount", reused_count AS "reusedCount"
       FROM source_crawls WHERE id = ?`,
      ['crawl-complete'],
    );
    expect(result.rows[0]).toMatchObject({
      attemptCount: 1,
      reusedCount: 1,
      status: 'completed',
      terminalCount: 1,
    });
  });

  it('terminalizes pending attempts when a local crawl fails', async () => {
    await database.query(
      `INSERT INTO source_crawls (id, source_id) VALUES (?, ?)`,
      ['crawl-failed', 'source-1'],
    );
    await createSourceCrawlAttempt(database as never, {
      attemptKey: 'provider:failed',
      sourceCrawlId: 'crawl-failed',
      title: 'Unavailable role',
    });
    const crawl = {
      finishedAt: null,
      id: 'crawl-failed',
      jobAttempt: 0,
      jobId: '',
      status: 'running',
    };

    await expect(
      failSourceCrawl(crawl, 'provider failed', database as never),
    ).resolves.toBe(true);

    const result = await database.query(
      `SELECT crawl.status,
              crawl.failed_persistence_count AS "failedPersistenceCount",
              item.outcome, item.status AS "itemStatus"
       FROM source_crawls AS crawl
       JOIN source_crawl_items AS item ON item.source_crawl_id = crawl.id
       WHERE crawl.id = ?`,
      ['crawl-failed'],
    );
    expect(result.rows[0]).toMatchObject({
      failedPersistenceCount: 1,
      itemStatus: 'persistence_error',
      outcome: 'failed_persistence',
      status: 'failed',
    });
  });
});
