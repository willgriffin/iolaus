import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSourceCrawlAttempt,
  finalizeSourceCrawlAttempt,
  recordSourceCrawlAttemptPersistenceIntent,
  recordSourceCrawlAttemptTerminalIntent,
} from './source-crawl-accounting.js';
import {
  completeSourceCrawl,
  failSourceCrawl,
  finalizeSourceCrawl,
} from './source-crawl-watchdog.js';

describe.each([false, true])('native crawl accounting: %s', (native) => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(await realpath(tmpdir()), 'iolaus-crawl-accounting-'),
    );
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'accounting.sqlite'),
      ...(native
        ? {
            secureFile: {
              custody: 'trusted-parent' as const,
              driver: 'node:sqlite' as const,
              root: directory,
            },
          }
        : {}),
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
      finishedAt: null as Date | null,
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
      `SELECT status, finished_at AS "finishedAt", attempt_count AS "attemptCount",
              terminal_count AS "terminalCount", reused_count AS "reusedCount"
       FROM source_crawls WHERE id = ?`,
      ['crawl-complete'],
    );
    expect(result.rows[0]).toMatchObject({
      attemptCount: 1,
      finishedAt: crawl.finishedAt?.getTime(),
      reusedCount: 1,
      status: 'completed',
      terminalCount: 1,
    });
    const finishedAt = crawl.finishedAt;
    await expect(
      completeSourceCrawl(
        crawl,
        { error: 'late result', status: 'completed_with_errors' },
        database as never,
      ),
    ).resolves.toBe(false);
    expect(crawl.finishedAt).toEqual(finishedAt);
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
      finishedAt: null as Date | null,
      id: 'crawl-failed',
      jobAttempt: 0,
      jobId: '',
      status: 'running',
    };

    await expect(
      failSourceCrawl(crawl, 'provider failed', database as never),
    ).resolves.toBe(true);

    const result = await database.query(
      `SELECT crawl.status, crawl.finished_at AS "finishedAt",
              crawl.failed_persistence_count AS "failedPersistenceCount",
              item.outcome, item.status AS "itemStatus", item.terminal_at AS "terminalAt"
       FROM source_crawls AS crawl
       JOIN source_crawl_items AS item ON item.source_crawl_id = crawl.id
       WHERE crawl.id = ?`,
      ['crawl-failed'],
    );
    expect(result.rows[0]).toMatchObject({
      failedPersistenceCount: 1,
      finishedAt: crawl.finishedAt?.getTime(),
      itemStatus: 'persistence_error',
      outcome: 'failed_persistence',
      status: 'failed',
      terminalAt: crawl.finishedAt?.getTime(),
    });
  });

  it('recovers recorded intents before failing an interrupted local crawl', async () => {
    const sourceCrawlId = 'crawl-interrupted';
    await database.query(
      `INSERT INTO source_crawls (id, source_id) VALUES (?, 'source-1')`,
      [sourceCrawlId],
    );
    await database.query(
      `INSERT INTO opportunities (id, source_id, external_id)
       VALUES ('persisted', 'source-1', 'external-1')`,
    );
    await createSourceCrawlAttempt(database as never, {
      attemptKey: 'attributed',
      externalId: 'external-1',
      sourceCrawlId,
    });
    await recordSourceCrawlAttemptPersistenceIntent(database as never, {
      attemptKey: 'attributed',
      intent: 'created',
      opportunityId: 'persisted',
      sourceCrawlId,
    });
    await createSourceCrawlAttempt(database as never, {
      attemptKey: 'skip',
      sourceCrawlId,
    });
    await recordSourceCrawlAttemptTerminalIntent(database as never, {
      attemptKey: 'skip',
      outcome: 'skipped',
      sourceCrawlId,
      status: 'filtered',
    });
    const crawl = {
      finishedAt: null as Date | null,
      id: sourceCrawlId,
      jobAttempt: 0,
      jobId: '',
      status: 'running',
    };
    await expect(
      failSourceCrawl(crawl, 'provider interrupted', database as never),
    ).resolves.toBe(true);
    await expect(
      failSourceCrawl(crawl, 'late retry', database as never),
    ).resolves.toBe(false);

    const result = await database.query(
      `SELECT crawl.status AS "crawlStatus", crawl.pending_count AS "pendingCount",
              crawl.terminal_count AS "terminalCount", item.outcome, item.status,
              item.opportunity_id AS "opportunityId", item.terminal_at AS "terminalAt"
       FROM source_crawl_items AS item
       JOIN source_crawls AS crawl ON item.source_crawl_id = crawl.id
       WHERE crawl.id = ? ORDER BY item.attempt_key`,
      [sourceCrawlId],
    );
    const terminal = {
      crawlStatus: 'failed',
      pendingCount: 0,
      terminalAt: crawl.finishedAt?.getTime(),
      terminalCount: 2,
    };
    expect(result.rows).toEqual([
      {
        ...terminal,
        opportunityId: 'persisted',
        outcome: 'created',
        status: 'created_opportunity',
      },
      {
        ...terminal,
        opportunityId: null,
        outcome: 'skipped',
        status: 'filtered',
      },
    ]);
  });

  it('uses the exact attempt fence for direct terminal writes', async () => {
    await database.query(
      `INSERT INTO source_crawls (id, source_id, job_id, job_attempt)
       VALUES ('crawl-owned', 'source-1', 'job-1', 2)`,
    );
    const crawl = {
      db: database,
      finishedAt: null as Date | null,
      id: 'crawl-owned',
      jobAttempt: 2,
      jobId: 'job-1',
      status: 'running',
    };
    const update = { error: '', status: 'completed' } as const;
    await expect(
      finalizeSourceCrawl({ ...crawl, jobAttempt: 1 }, update),
    ).resolves.toBe(false);
    await expect(finalizeSourceCrawl(crawl, update)).resolves.toBe(true);
    const result = await database.query(
      `SELECT status, finished_at AS "finishedAt" FROM source_crawls`,
    );
    expect(result.rows).toEqual([
      { finishedAt: crawl.finishedAt?.getTime(), status: 'completed' },
    ]);
  });
});
