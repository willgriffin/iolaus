import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDbConfig } from './db.js';
import {
  findUniqueOpportunityIdentityMatch,
  opportunityIdentityLockKeys,
  withOpportunityIdentityKeyLocks,
} from './opportunity-source-crawler.js';
import { getCollection } from './smrt.js';
import {
  createSourceCrawlAttempt,
  ensureSourceCrawlAccountingSchema,
  finalizeSourceCrawlAttempt,
  getSourceCrawlAccountingSchemaStatus,
  persistCreatedSourceCrawlAttempt,
  prepareSourceCrawlAttempt,
  reconcileSourceCrawlAccounting,
  recordSourceCrawlAttemptPersistenceIntent,
  recordSourceCrawlAttemptTerminalIntent,
  recoverSourceCrawlAttempt,
} from './source-crawl-accounting.js';
import { ensureSourceCrawlOpportunityGuard } from './source-crawl-opportunity-integrity.js';
import {
  completeSourceCrawl,
  failSourceCrawl,
} from './source-crawl-watchdog.js';

const runPostgresCoverage = process.env.SOURCE_CRAWL_ACCOUNTING_DB === '1';
const schema = `source_crawl_accounting_${randomUUID().replaceAll('-', '')}`;
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
  'source crawl accounting on PostgreSQL',
  () => {
    let database: SmrtDatabase;
    let primary: DbSession | undefined;
    let concurrent: DbSession | undefined;

    beforeAll(async () => {
      database = await resolveDatabase(getDbConfig(), {
        dbid: `source-crawl-accounting-test-${randomUUID()}`,
      });
      if (typeof database.acquireSession !== 'function') {
        throw new Error('PostgreSQL integration coverage requires sessions.');
      }
      primary = await database.acquireSession();
      concurrent = await database.acquireSession();
      await primary.query(`CREATE SCHEMA ${schema}`);
      for (const session of [primary, concurrent]) {
        await session.query(`SET search_path TO ${schema}, public`);
      }
    });

    beforeEach(async () => {
      if (!primary) throw new Error('Missing primary PostgreSQL session.');
      await primary.query(`DROP TABLE IF EXISTS ${schema}.source_crawl_items`);
      await primary.query(`DROP TABLE IF EXISTS ${schema}.opportunities`);
      await primary.query(`DROP TABLE IF EXISTS ${schema}.source_crawls`);
      await primary.query(`
        CREATE TABLE ${schema}.source_crawls (
          id UUID PRIMARY KEY,
          source_id TEXT NOT NULL DEFAULT 'source-1',
          status TEXT NOT NULL DEFAULT 'running',
          started_at TIMESTAMP,
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
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await primary.query(`
        CREATE TABLE ${schema}.opportunities (
          id UUID PRIMARY KEY,
          source_id TEXT NOT NULL DEFAULT 'source-1',
          external_id TEXT NOT NULL DEFAULT '',
          posting_url TEXT NOT NULL DEFAULT '',
          canonical_url TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await primary.query(`
        CREATE TABLE ${schema}.source_crawl_items (
          id UUID PRIMARY KEY,
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
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await ensureSourceCrawlAccountingSchema(primary as never);
      await ensureSourceCrawlOpportunityGuard(primary as never);
    });

    afterAll(async () => {
      if (!primary || !concurrent) return;
      try {
        await primary.query('SET search_path TO public');
        await concurrent.query('SET search_path TO public');
        await primary.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await primary.release();
        await concurrent.release();
      }
    });

    it('deduplicates concurrent attempt creation by crawl and attempt key', async () => {
      if (!primary || !concurrent) throw new Error('Missing sessions.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);

      const [first, second] = await Promise.all([
        createSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: 'provider:42',
          sourceCrawlId: crawlId,
        }),
        createSourceCrawlAttempt(transactionalSession(concurrent), {
          attemptKey: 'provider:42',
          sourceCrawlId: crawlId,
        }),
      ]);

      expect(first.id).toBe(second.id);
      const count = await primary.query(
        'SELECT COUNT(*)::integer AS count FROM source_crawl_items',
      );
      expect(count.rows[0]?.count).toBe(1);
    });

    it('inserts same-title opportunities with distinct crawler identities through the ORM', async () => {
      if (!database.transaction) {
        throw new Error(
          'PostgreSQL integration coverage requires transactions.',
        );
      }
      const opportunityIds = [randomUUID(), randomUUID()];
      const slugs = opportunityIds.map((id) => `crawl-opportunity-${id}`);

      try {
        await database.transaction(async (transaction) => {
          const opportunities = await getCollection('Opportunity', {
            db: transaction as never,
          });
          for (const [index, id] of opportunityIds.entries()) {
            await opportunities.create({
              _insertOnly: true,
              id,
              postingUrl: `https://example.com/jobs/platform-engineer-${index + 1}`,
              slug: slugs[index],
              title: 'Platform Engineer',
            });
          }
        });

        const persisted = await database.query(
          `SELECT id::text AS id, slug, title
             FROM public.opportunities
            WHERE id IN (?, ?)
            ORDER BY id`,
          opportunityIds,
        );
        expect(persisted.rows).toHaveLength(2);
        expect(new Set(persisted.rows.map((row) => row.id))).toEqual(
          new Set(opportunityIds),
        );
        expect(new Set(persisted.rows.map((row) => row.slug))).toEqual(
          new Set(slugs),
        );
        expect(
          persisted.rows.every((row) => row.title === 'Platform Engineer'),
        ).toBe(true);
      } finally {
        await database.query(
          'DELETE FROM public.opportunities WHERE id IN (?, ?)',
          opportunityIds,
        );
      }
    });

    it('fences terminal outcomes and reconciles every committed outcome', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);
      const outcomes = [
        'created',
        'reused',
        'relisted',
        'duplicate',
        'skipped',
        'failed_persistence',
      ] as const;
      const opportunityIds = new Map<string, string>();
      for (const outcome of outcomes.slice(0, 4)) {
        const opportunityId = randomUUID();
        opportunityIds.set(outcome, opportunityId);
        await primary.query('INSERT INTO opportunities (id) VALUES (?)', [
          opportunityId,
        ]);
      }
      for (const outcome of outcomes) {
        await createSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: outcome,
          sourceCrawlId: crawlId,
        });
        await finalizeSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: outcome,
          canonicalUrl:
            outcome === 'created' ? 'https://example.com/resolved' : undefined,
          companyName: outcome === 'created' ? 'Example Co' : undefined,
          opportunityId: opportunityIds.get(outcome),
          outcome,
          postingUrl:
            outcome === 'created'
              ? 'https://example.com/discovered'
              : undefined,
          rawJson: outcome === 'created' ? '{"resolved":true}' : undefined,
          sourceCrawlId: crawlId,
          title: outcome === 'created' ? 'Resolved role' : undefined,
        });
      }

      await expect(
        finalizeSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: 'created',
          opportunityId: opportunityIds.get('created'),
          outcome: 'created',
          sourceCrawlId: crawlId,
        }),
      ).resolves.toMatchObject({ outcome: 'created' });
      await expect(
        finalizeSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: 'created',
          outcome: 'skipped',
          sourceCrawlId: crawlId,
        }),
      ).rejects.toThrow('already terminal with outcome created');

      const accounting = await reconcileSourceCrawlAccounting(
        transactionalSession(primary),
        crawlId,
        { requireTerminal: true },
      );
      expect(accounting).toEqual({
        attemptCount: 6,
        createdCount: 1,
        duplicateCount: 1,
        failedPersistenceCount: 1,
        pendingCount: 0,
        relistedCount: 1,
        reusedCount: 1,
        skippedCount: 1,
        terminalCount: 6,
      });
      const crawl = await primary.query(
        `SELECT result_count AS "resultCount",
                new_opportunity_count AS "createdCount",
                terminal_count AS "terminalCount"
         FROM source_crawls WHERE id = ?`,
        [crawlId],
      );
      expect(crawl.rows[0]).toEqual({
        createdCount: 1,
        resultCount: 6,
        terminalCount: 6,
      });
      const createdItem = await primary.query(
        `SELECT canonical_url AS "canonicalUrl",
                posting_url AS "postingUrl",
                company_name AS "companyName",
                title,
                raw_json AS "rawJson"
         FROM source_crawl_items
         WHERE source_crawl_id = ? AND attempt_key = 'created'`,
        [crawlId],
      );
      expect(createdItem.rows[0]).toEqual({
        canonicalUrl: 'https://example.com/resolved',
        companyName: 'Example Co',
        postingUrl: 'https://example.com/discovered',
        rawJson: '{"resolved":true}',
        title: 'Resolved role',
      });
    });

    it('retains the opportunity foreign key and rejects unfinished crawls', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'pending',
        sourceCrawlId: crawlId,
      });
      await expect(
        reconcileSourceCrawlAccounting(transactionalSession(primary), crawlId, {
          requireTerminal: true,
        }),
      ).rejects.toThrow('non-terminal attempts');
      await expect(
        primary.query(
          'UPDATE source_crawl_items SET opportunity_id = ? WHERE source_crawl_id = ?',
          [randomUUID(), crawlId],
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      expect(
        await getSourceCrawlAccountingSchemaStatus(primary as never),
      ).toEqual({
        attemptIndexPresent: true,
        outcomeConstraintPresent: true,
        requiredColumnsPresent: 3,
        requiredColumnsTotal: 3,
      });
      await expect(
        primary.query(
          `INSERT INTO source_crawl_items (
             id, slug, context, source_crawl_id, attempt_key, outcome
           ) VALUES (?, ?, '', ?, ?, NULL)`,
          [
            randomUUID(),
            `null-outcome-${randomUUID()}`,
            crawlId,
            'null-outcome',
          ],
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      const durableOpportunityId = randomUUID();
      await primary.query('INSERT INTO opportunities (id) VALUES (?)', [
        durableOpportunityId,
      ]);
      await expect(
        primary.query(
          `UPDATE source_crawl_items
           SET outcome = 'failed_persistence', opportunity_id = ?
           WHERE source_crawl_id = ? AND attempt_key = 'pending'`,
          [durableOpportunityId, crawlId],
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      await expect(
        primary.query(
          `UPDATE source_crawl_items
           SET outcome = 'created', opportunity_id = NULL
           WHERE source_crawl_id = ? AND attempt_key = 'pending'`,
          [crawlId],
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    });

    it('rejects an attempt that loses the race with terminal crawl fencing', async () => {
      if (!primary || !concurrent) throw new Error('Missing sessions.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);
      await primary.query('BEGIN');
      await primary.query(
        'SELECT id FROM source_crawls WHERE id = ? FOR UPDATE',
        [crawlId],
      );

      let transactionStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        transactionStarted = resolve;
      });
      const concurrentDatabase = {
        query: concurrent.query.bind(concurrent),
        transaction: async <T>(work: (db: DbSession) => Promise<T>) => {
          await concurrent?.query('BEGIN');
          transactionStarted?.();
          try {
            const result = await work(concurrent as DbSession);
            await concurrent?.query('COMMIT');
            return result;
          } catch (error) {
            await concurrent?.query('ROLLBACK');
            throw error;
          }
        },
      } as unknown as SmrtDatabase;
      const lateAttempt = createSourceCrawlAttempt(concurrentDatabase, {
        attemptKey: 'late',
        sourceCrawlId: crawlId,
      });
      await started;
      await primary.query(
        `UPDATE source_crawls
         SET status = 'timed_out', finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [crawlId],
      );
      await primary.query('COMMIT');

      await expect(lateAttempt).rejects.toThrow('is no longer running');
      const attempts = await primary.query(
        'SELECT COUNT(*)::integer AS count FROM source_crawl_items WHERE source_crawl_id = ?',
        [crawlId],
      );
      expect(attempts.rows[0]?.count).toBe(0);
    });

    it('holds the parent fence from success reconciliation through terminalization', async () => {
      if (!primary || !concurrent) throw new Error('Missing sessions.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'finished',
        sourceCrawlId: crawlId,
      });
      await finalizeSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'finished',
        outcome: 'skipped',
        sourceCrawlId: crawlId,
        status: 'skipped_not_relevant',
      });

      let terminalUpdateReached: (() => void) | undefined;
      const terminalUpdateStarted = new Promise<void>((resolve) => {
        terminalUpdateReached = resolve;
      });
      let releaseTerminalUpdate: (() => void) | undefined;
      const terminalUpdateReleased = new Promise<void>((resolve) => {
        releaseTerminalUpdate = resolve;
      });
      const completionDatabase = {
        query: primary.query.bind(primary),
        transaction: async <T>(work: (db: DbSession) => Promise<T>) => {
          await primary?.query('BEGIN');
          const transaction = {
            query: async (sql: string, parameters?: unknown[]) => {
              if (sql.includes('SET status = ?, finished_at = ?')) {
                terminalUpdateReached?.();
                await terminalUpdateReleased;
              }
              return await primary?.query(sql, parameters);
            },
          } as DbSession;
          try {
            const result = await work(transaction);
            await primary?.query('COMMIT');
            return result;
          } catch (error) {
            await primary?.query('ROLLBACK');
            throw error;
          }
        },
      } as unknown as SmrtDatabase;
      const completion = completeSourceCrawl(
        { id: crawlId, status: 'running' },
        { error: '', status: 'completed' },
        completionDatabase,
      );
      await terminalUpdateStarted;

      let lateTransactionStarted: (() => void) | undefined;
      const lateStarted = new Promise<void>((resolve) => {
        lateTransactionStarted = resolve;
      });
      const concurrentDatabase = {
        query: concurrent.query.bind(concurrent),
        transaction: async <T>(work: (db: DbSession) => Promise<T>) => {
          await concurrent?.query('BEGIN');
          lateTransactionStarted?.();
          try {
            const result = await work(concurrent as DbSession);
            await concurrent?.query('COMMIT');
            return result;
          } catch (error) {
            await concurrent?.query('ROLLBACK');
            throw error;
          }
        },
      } as unknown as SmrtDatabase;
      const lateAttempt = createSourceCrawlAttempt(concurrentDatabase, {
        attemptKey: 'late-after-reconcile',
        sourceCrawlId: crawlId,
      });
      await lateStarted;
      releaseTerminalUpdate?.();

      await expect(completion).resolves.toBe(true);
      await expect(lateAttempt).rejects.toThrow('is no longer running');
      const state = await primary.query(
        `SELECT status, pending_count AS "pendingCount",
                (SELECT COUNT(*)::integer FROM source_crawl_items
                 WHERE source_crawl_id = ? AND outcome = 'pending') AS "pendingItems"
         FROM source_crawls WHERE id = ?`,
        [crawlId, crawlId],
      );
      expect(state.rows[0]).toEqual({
        pendingCount: 0,
        pendingItems: 0,
        status: 'completed',
      });
    });

    it('recovers created, reused, and relisted outcomes after post-save process loss', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const startedAt = new Date(Date.now() - 60_000);
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, ?)',
        [crawlId, 'source-recovery', startedAt],
      );
      const createdId = randomUUID();
      const reusedId = randomUUID();
      const relistedId = randomUUID();
      const attempts = [
        {
          attemptKey: 'created-loss',
          externalId: 'created-identity',
          opportunityId: createdId,
          relisted: false,
        },
        {
          attemptKey: 'reused-loss',
          externalId: 'reused-identity',
          opportunityId: reusedId,
          relisted: false,
        },
        {
          attemptKey: 'relisted-loss',
          externalId: 'relisted-identity',
          opportunityId: relistedId,
          relisted: true,
        },
      ];
      for (const attempt of attempts) {
        await createSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: attempt.attemptKey,
          sourceCrawlId: crawlId,
        });
        await prepareSourceCrawlAttempt(transactionalSession(primary), {
          ...attempt,
          postingUrl: `https://example.com/${attempt.attemptKey}`,
          sourceCrawlId: crawlId,
        });
        await recordSourceCrawlAttemptPersistenceIntent(
          transactionalSession(primary),
          {
            attemptKey: attempt.attemptKey,
            intent:
              attempt.attemptKey === 'created-loss'
                ? 'created'
                : attempt.relisted
                  ? 'relisted'
                  : 'reused',
            opportunityId: attempt.opportunityId,
            sourceCrawlId: crawlId,
          },
        );
      }
      await primary.query(
        `INSERT INTO opportunities
           (id, source_id, external_id, posting_url, created_at)
         VALUES
           (?, 'source-recovery', 'created-identity', 'https://example.com/created-loss', CURRENT_TIMESTAMP),
           (?, 'source-recovery', 'reused-identity', 'https://example.com/reused-loss', ?),
           (?, 'source-recovery', 'relisted-identity', 'https://example.com/relisted-loss', ?)`,
        [
          createdId,
          reusedId,
          new Date(startedAt.getTime() - 60_000),
          relistedId,
          new Date(startedAt.getTime() - 60_000),
        ],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'worker process disappeared after opportunity save',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const recovered = await primary.query(
        `SELECT attempt_key AS "attemptKey", outcome,
                opportunity_id AS "opportunityId"
         FROM source_crawl_items WHERE source_crawl_id = ?
         ORDER BY attempt_key`,
        [crawlId],
      );
      expect(recovered.rows).toEqual([
        {
          attemptKey: 'created-loss',
          opportunityId: createdId,
          outcome: 'created',
        },
        {
          attemptKey: 'relisted-loss',
          opportunityId: relistedId,
          outcome: 'relisted',
        },
        {
          attemptKey: 'reused-loss',
          opportunityId: reusedId,
          outcome: 'reused',
        },
      ]);
      const accounting = await primary.query(
        `SELECT new_opportunity_count AS "createdCount",
                reused_count AS "reusedCount",
                relisted_count AS "relistedCount",
                failed_persistence_count AS "failedPersistenceCount"
         FROM source_crawls WHERE id = ?`,
        [crawlId],
      );
      expect(accounting.rows[0]).toEqual({
        createdCount: 1,
        failedPersistenceCount: 0,
        relistedCount: 1,
        reusedCount: 1,
      });
    });

    it('fails closed when pending recovery matches multiple opportunities', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-ambiguous'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'ambiguous-loss',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'ambiguous-loss',
        externalId: 'ambiguous-identity',
        sourceCrawlId: crawlId,
      });
      const intendedOpportunityId = randomUUID();
      await recordSourceCrawlAttemptPersistenceIntent(
        transactionalSession(primary),
        {
          attemptKey: 'ambiguous-loss',
          intent: 'created',
          opportunityId: intendedOpportunityId,
          sourceCrawlId: crawlId,
        },
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, external_id)
         VALUES (?, 'source-ambiguous', 'ambiguous-identity'),
                (?, 'source-ambiguous', 'ambiguous-identity')`,
        [intendedOpportunityId, randomUUID()],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'ambiguous recovery',
          transactionalSession(primary),
        ),
      ).rejects.toThrow('matches multiple durable opportunities');
      const state = await primary.query(
        `SELECT crawl.status, item.outcome
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({ outcome: 'pending', status: 'running' });
    });

    it('fails closed when a durable match has no recorded persistence intent', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-missing-intent'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'missing-intent',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'missing-intent',
        externalId: 'missing-intent-identity',
        sourceCrawlId: crawlId,
      });
      await primary.query(
        `INSERT INTO opportunities (id, source_id, external_id)
         VALUES (?, 'source-missing-intent', 'missing-intent-identity')`,
        [randomUUID()],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'missing intent recovery',
          transactionalSession(primary),
        ),
      ).rejects.toThrow('no unambiguous persistence intent');
      const state = await primary.query(
        `SELECT crawl.status, item.outcome
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({ outcome: 'pending', status: 'running' });
    });

    it('does not credit a foreign later-crawl Opportunity to a pre-save created intent', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const intendedOpportunityId = randomUUID();
      const foreignOpportunityId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-pre-save-loss'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'pre-save-loss',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'pre-save-loss',
        canonicalUrl: 'https://example.com/final/pre-save-loss',
        sourceCrawlId: crawlId,
      });
      await recordSourceCrawlAttemptPersistenceIntent(
        transactionalSession(primary),
        {
          attemptKey: 'pre-save-loss',
          intent: 'created',
          opportunityId: intendedOpportunityId,
          sourceCrawlId: crawlId,
        },
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, canonical_url)
         VALUES (?, 'source-pre-save-loss', 'https://example.com/final/pre-save-loss')`,
        [foreignOpportunityId],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'worker disappeared before its own opportunity insert',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const state = await primary.query(
        `SELECT item.outcome, item.opportunity_id AS "opportunityId",
                crawl.new_opportunity_count AS "createdCount",
                crawl.failed_persistence_count AS "failedPersistenceCount"
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({
        createdCount: 0,
        failedPersistenceCount: 1,
        opportunityId: null,
        outcome: 'failed_persistence',
      });
    });

    it('recovers the attributed Opportunity through a final-detail-only identity', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const opportunityId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-final-detail'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'final-detail-loss',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'final-detail-loss',
        canonicalUrl: 'https://provider.example/final/42',
        postingUrl: 'https://alias.example/discovered/42',
        sourceCrawlId: crawlId,
      });
      await recordSourceCrawlAttemptPersistenceIntent(
        transactionalSession(primary),
        {
          attemptKey: 'final-detail-loss',
          intent: 'created',
          opportunityId,
          sourceCrawlId: crawlId,
        },
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, canonical_url)
         VALUES (?, 'source-final-detail', 'https://provider.example/final/42')`,
        [opportunityId],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'worker disappeared after final-detail save',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const state = await primary.query(
        `SELECT outcome, opportunity_id AS "opportunityId", canonical_url AS "canonicalUrl"
         FROM source_crawl_items WHERE source_crawl_id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({
        canonicalUrl: 'https://provider.example/final/42',
        opportunityId,
        outcome: 'created',
      });
    });

    it('atomically reconciles an attributed write recovered before catch-path terminalization', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const opportunityId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-direct-recovery'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'direct-recovery',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'direct-recovery',
        externalId: 'direct-recovery-id',
        sourceCrawlId: crawlId,
      });
      await recordSourceCrawlAttemptPersistenceIntent(
        transactionalSession(primary),
        {
          attemptKey: 'direct-recovery',
          intent: 'created',
          opportunityId,
          sourceCrawlId: crawlId,
        },
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, external_id)
         VALUES (?, 'source-direct-recovery', 'direct-recovery-id')`,
        [opportunityId],
      );

      await expect(
        recoverSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: 'direct-recovery',
          sourceCrawlId: crawlId,
        }),
      ).resolves.toBe('created');
      const state = await primary.query(
        `SELECT item.outcome, item.opportunity_id AS "opportunityId",
                crawl.new_opportunity_count AS "createdCount",
                crawl.pending_count AS "pendingCount",
                crawl.terminal_count AS "terminalCount"
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({
        createdCount: 1,
        opportunityId,
        outcome: 'created',
        pendingCount: 0,
        terminalCount: 1,
      });
    });

    it('fails live dedupe closed when URL and external-id aliases resolve to different Opportunities', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const canonicalId = randomUUID();
      const externalId = randomUUID();
      await primary.query(
        `INSERT INTO opportunities
           (id, source_id, external_id, canonical_url)
         VALUES
           (?, 'source-live-ambiguity', '', 'https://example.com/final/ambiguous'),
           (?, 'source-live-ambiguity', 'external-ambiguous', '')`,
        [canonicalId, externalId],
      );
      const identities = [
        { canonicalUrl: 'https://example.com/final/ambiguous' },
        {
          externalId: 'external-ambiguous',
          sourceId: 'source-live-ambiguity',
        },
      ];
      await expect(
        findUniqueOpportunityIdentityMatch(identities, async (where) => {
          if (where.canonicalUrl) {
            const result = await primary?.query(
              `SELECT id::text AS id FROM opportunities WHERE canonical_url = ? LIMIT 2`,
              [where.canonicalUrl],
            );
            return (result?.rows ?? []) as never;
          }
          const result = await primary?.query(
            `SELECT id::text AS id FROM opportunities
             WHERE source_id = ? AND external_id = ? LIMIT 2`,
            [where.sourceId, where.externalId],
          );
          return (result?.rows ?? []) as never;
        }),
      ).rejects.toThrow('ambiguous across 2 durable records');
    });

    it('fails recovery closed when a raw root alias identifies a second Opportunity', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const intendedOpportunityId = randomUUID();
      const aliasOpportunityId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-raw-alias'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'raw-alias-loss',
        sourceCrawlId: crawlId,
      });
      await prepareSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'raw-alias-loss',
        canonicalUrl: 'https://provider.example/final/raw-alias',
        rawJson: JSON.stringify({
          recoveryIdentities: {
            finalCanonicalUrl: 'https://provider.example/final/raw-alias',
            rootPostingUrl: 'https://alias.example/root/raw-alias',
          },
        }),
        sourceCrawlId: crawlId,
      });
      await recordSourceCrawlAttemptPersistenceIntent(
        transactionalSession(primary),
        {
          attemptKey: 'raw-alias-loss',
          intent: 'created',
          opportunityId: intendedOpportunityId,
          sourceCrawlId: crawlId,
        },
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, canonical_url)
         VALUES
           (?, 'source-raw-alias', 'https://provider.example/final/raw-alias'),
           (?, 'source-raw-alias', 'https://alias.example/root/raw-alias')`,
        [intendedOpportunityId, aliasOpportunityId],
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'worker disappeared after save',
          transactionalSession(primary),
        ),
      ).rejects.toThrow('matches multiple durable opportunities');
      const state = await primary.query(
        `SELECT crawl.status, item.outcome
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({ outcome: 'pending', status: 'running' });
    });

    it('recovers durable skipped and duplicate intents after process loss', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-terminal-intents'],
      );
      for (const [attemptKey, outcome, status] of [
        ['skipped-loss', 'skipped', 'skipped_not_relevant'],
        ['duplicate-loss', 'duplicate', 'duplicate'],
      ] as const) {
        await createSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey,
          sourceCrawlId: crawlId,
        });
        await recordSourceCrawlAttemptTerminalIntent(
          transactionalSession(primary),
          { attemptKey, outcome, sourceCrawlId: crawlId, status },
        );
      }

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'worker disappeared before terminal write returned',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const state = await primary.query(
        `SELECT item.attempt_key AS "attemptKey", item.outcome, item.status,
                crawl.duplicate_count AS "duplicateCount",
                crawl.skipped_count AS "skippedCount",
                crawl.failed_persistence_count AS "failedPersistenceCount"
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ? ORDER BY item.attempt_key`,
        [crawlId],
      );
      expect(state.rows).toEqual([
        {
          attemptKey: 'duplicate-loss',
          duplicateCount: 1,
          failedPersistenceCount: 0,
          outcome: 'duplicate',
          skippedCount: 1,
          status: 'duplicate',
        },
        {
          attemptKey: 'skipped-loss',
          duplicateCount: 1,
          failedPersistenceCount: 0,
          outcome: 'skipped',
          skippedCount: 1,
          status: 'skipped_not_relevant',
        },
      ]);
    });

    it('holds the parent fence through the Opportunity insert and created terminalization', async () => {
      if (!primary || !concurrent) throw new Error('Missing sessions.');
      const crawlId = randomUUID();
      const opportunityId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-watchdog-save'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'watchdog-vs-save',
        canonicalUrl: 'https://example.com/jobs/watchdog-save',
        sourceCrawlId: crawlId,
      });

      let insertedResolve: (() => void) | undefined;
      const inserted = new Promise<void>((resolve) => {
        insertedResolve = resolve;
      });
      let releaseResolve: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      const persistence = persistCreatedSourceCrawlAttempt(
        transactionalSession(primary),
        {
          attemptKey: 'watchdog-vs-save',
          canonicalUrl: 'https://example.com/jobs/watchdog-save',
          contentFingerprint: 'watchdog-fingerprint',
          contentVersion: 1,
          opportunityId,
          sourceCrawlId: crawlId,
          status: 'created_opportunity',
        },
        async (transaction) => {
          await transaction.query(
            `INSERT INTO opportunities (id, source_id, canonical_url)
             VALUES (?, 'source-watchdog-save', 'https://example.com/jobs/watchdog-save')`,
            [opportunityId],
          );
          insertedResolve?.();
          await release;
          return opportunityId;
        },
      );
      await inserted;
      const watchdog = failSourceCrawl(
        { id: crawlId, status: 'running' },
        'watchdog raced the save',
        transactionalSession(concurrent),
      );
      const watchdogState = await Promise.race([
        watchdog.then(() => 'settled'),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 100),
        ),
      ]);
      expect(watchdogState).toBe('blocked');
      releaseResolve?.();
      await expect(persistence).resolves.toMatchObject({
        attempt: { opportunityId, outcome: 'created' },
        value: opportunityId,
      });
      await expect(watchdog).resolves.toBe(true);

      const state = await primary.query(
        `SELECT crawl.new_opportunity_count AS "createdCount",
                crawl.failed_persistence_count AS "failedPersistenceCount",
                item.outcome, item.opportunity_id AS "opportunityId",
                (SELECT COUNT(*)::integer FROM opportunities WHERE id = ?) AS "opportunityCount"
         FROM source_crawls AS crawl
         JOIN source_crawl_items AS item
           ON item.source_crawl_id = CAST(crawl.id AS TEXT)
         WHERE crawl.id = ?`,
        [opportunityId, crawlId],
      );
      expect(state.rows[0]).toEqual({
        createdCount: 1,
        failedPersistenceCount: 0,
        opportunityCount: 1,
        opportunityId,
        outcome: 'created',
      });
    });

    it('recovers cross-source reused and relisted URL intents globally', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      const opportunityId = randomUUID();
      const canonicalUrl = 'https://global.example/jobs/shared-role';
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-b'],
      );
      await primary.query(
        `INSERT INTO opportunities (id, source_id, canonical_url)
         VALUES (?, 'source-a', ?)`,
        [opportunityId, canonicalUrl],
      );
      for (const intent of ['reused', 'relisted'] as const) {
        await createSourceCrawlAttempt(transactionalSession(primary), {
          attemptKey: `cross-source-${intent}`,
          canonicalUrl,
          sourceCrawlId: crawlId,
        });
        await recordSourceCrawlAttemptPersistenceIntent(
          transactionalSession(primary),
          {
            attemptKey: `cross-source-${intent}`,
            intent,
            opportunityId,
            sourceCrawlId: crawlId,
          },
        );
      }

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'process lost after foreign-source URL reuse',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const items = await primary.query(
        `SELECT attempt_key AS "attemptKey", outcome,
                opportunity_id AS "opportunityId"
         FROM source_crawl_items WHERE source_crawl_id = ?
         ORDER BY attempt_key`,
        [crawlId],
      );
      expect(items.rows).toEqual([
        {
          attemptKey: 'cross-source-relisted',
          opportunityId,
          outcome: 'relisted',
        },
        {
          attemptKey: 'cross-source-reused',
          opportunityId,
          outcome: 'reused',
        },
      ]);
    });

    it('recovers a skipped intent when provider JSON collides with the recovery envelope', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query(
        'INSERT INTO source_crawls (id, source_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [crawlId, 'source-malformed-raw'],
      );
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'malformed-raw-skip',
        rawJson: JSON.stringify({ recoveryIdentities: [] }),
        sourceCrawlId: crawlId,
      });
      await recordSourceCrawlAttemptTerminalIntent(
        transactionalSession(primary),
        {
          attemptKey: 'malformed-raw-skip',
          outcome: 'skipped',
          sourceCrawlId: crawlId,
          status: 'skipped_not_relevant',
        },
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'process lost after skipped intent',
          transactionalSession(primary),
        ),
      ).resolves.toBe(true);
      const state = await primary.query(
        `SELECT outcome, status FROM source_crawl_items
         WHERE source_crawl_id = ? AND attempt_key = 'malformed-raw-skip'`,
        [crawlId],
      );
      expect(state.rows[0]).toEqual({
        outcome: 'skipped',
        status: 'skipped_not_relevant',
      });
    });

    it('rolls back terminalization when aggregate reconciliation fails', async () => {
      if (!primary) throw new Error('Missing primary session.');
      const crawlId = randomUUID();
      await primary.query('INSERT INTO source_crawls (id) VALUES (?)', [
        crawlId,
      ]);
      await createSourceCrawlAttempt(transactionalSession(primary), {
        attemptKey: 'rollback',
        sourceCrawlId: crawlId,
      });
      await primary.query(
        `ALTER TABLE source_crawls DROP COLUMN failed_persistence_count`,
      );

      await expect(
        failSourceCrawl(
          { id: crawlId, status: 'running' },
          'forced reconciliation failure',
          transactionalSession(primary),
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      const crawl = await primary.query(
        'SELECT status, finished_at AS "finishedAt" FROM source_crawls WHERE id = ?',
        [crawlId],
      );
      const attempt = await primary.query(
        'SELECT outcome FROM source_crawl_items WHERE source_crawl_id = ?',
        [crawlId],
      );
      expect(crawl.rows[0]).toEqual({ finishedAt: null, status: 'running' });
      expect(attempt.rows[0]?.outcome).toBe('pending');
    });

    it('executes the production multi-key lock path for URL and external-id aliases', async () => {
      if (!primary || !concurrent) throw new Error('Missing sessions.');
      const canonicalDetail = {
        canonicalUrl: 'https://example.com/jobs/canonical',
        descriptionRaw: 'Build systems.',
        message: '',
        provider: 'generic' as const,
        status: 'resolved' as const,
        title: 'Engineer',
      };
      const firstKeys = opportunityIdentityLockKeys(
        { postingUrl: 'https://alias-a.example/jobs/1', title: 'Engineer' },
        'source-1',
        canonicalDetail,
      );
      const secondKeys = opportunityIdentityLockKeys(
        { postingUrl: 'https://alias-b.example/jobs/2', title: 'Engineer' },
        'source-1',
        canonicalDetail,
      );
      const shared = firstKeys.find((key) => secondKeys.includes(key));
      expect(firstKeys).toEqual([...firstKeys].sort());
      expect(secondKeys).toEqual([...secondKeys].sort());
      expect(shared).toBe('url:https://example.com/jobs/canonical');
      expect(firstKeys.indexOf(shared ?? '')).toBeGreaterThan(0);
      expect(secondKeys.indexOf(shared ?? '')).toBeGreaterThan(0);

      const assertContends = async (left: string[], right: string[]) => {
        let firstLocked: (() => void) | undefined;
        const locked = new Promise<void>((resolve) => {
          firstLocked = resolve;
        });
        let releaseFirst: (() => void) | undefined;
        const released = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const first = withOpportunityIdentityKeyLocks(
          primary as DbSession,
          left,
          async () => {
            firstLocked?.();
            await released;
          },
          { releaseSession: false, statementTimeoutMs: 100 },
        );
        await locked;
        await expect(
          withOpportunityIdentityKeyLocks(
            concurrent as DbSession,
            right,
            async () => undefined,
            { releaseSession: false, statementTimeoutMs: 100 },
          ),
        ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
        releaseFirst?.();
        await first;
      };

      await assertContends(firstKeys, secondKeys);

      const externalFirst = opportunityIdentityLockKeys(
        {
          externalId: 'shared-external-id',
          postingUrl: 'https://external-a.example/jobs/1',
          title: 'Engineer',
        },
        'source-1',
        {
          ...canonicalDetail,
          canonicalUrl: 'https://external-a.example/final',
        },
      );
      const externalSecond = opportunityIdentityLockKeys(
        {
          externalId: 'shared-external-id',
          postingUrl: 'https://external-b.example/jobs/2',
          title: 'Engineer',
        },
        'source-1',
        {
          ...canonicalDetail,
          canonicalUrl: 'https://external-b.example/final',
        },
      );
      expect(
        externalFirst.filter((key) => externalSecond.includes(key)),
      ).toEqual(['external:source-1:shared-external-id']);
      await assertContends(externalFirst, externalSecond);
    });
  },
);
