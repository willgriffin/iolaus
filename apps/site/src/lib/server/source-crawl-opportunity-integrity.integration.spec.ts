import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDbConfig } from './db.js';
import {
  applySourceCrawlOpportunityRepair,
  ensureSourceCrawlOpportunityGuard,
  getSourceCrawlOpportunityGuardStatus,
  inspectSourceCrawlOpportunityOrphans,
  inspectSourceCrawlOpportunityPlanAttestations,
  mergeOpportunityCrawlReferences,
  SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY,
} from './source-crawl-opportunity-integrity.js';

const runPostgresCoverage = process.env.SOURCE_CRAWL_INTEGRITY_DB === '1';
const schema = `source_crawl_integrity_${randomUUID().replaceAll('-', '')}`;
type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type DbSession = Awaited<
  ReturnType<NonNullable<SmrtDatabase['acquireSession']>>
>;

describe.runIf(runPostgresCoverage)(
  'source crawl opportunity integrity on PostgreSQL',
  () => {
    let database: SmrtDatabase;
    let primary: DbSession | undefined;
    let concurrent: DbSession | undefined;

    beforeAll(async () => {
      database = await resolveDatabase(getDbConfig(), {
        dbid: `source-crawl-integrity-test-${randomUUID()}`,
      });
      if (typeof database.acquireSession !== 'function') {
        throw new Error(
          'PostgreSQL integration coverage requires pinned sessions.',
        );
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
      await primary.query(`DROP TABLE IF EXISTS ${schema}.data_repair_audit`);
      await primary.query(`DROP TABLE IF EXISTS ${schema}.data_repair_runs`);
      await primary.query(`DROP TABLE IF EXISTS ${schema}.source_crawl_items`);
      await primary.query(`DROP TABLE IF EXISTS ${schema}.opportunities`);
      await primary.query(`
        CREATE TABLE ${schema}.opportunities (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await primary.query(`
        CREATE TABLE ${schema}.source_crawl_items (
          id UUID PRIMARY KEY,
          opportunity_id TEXT NULL,
          reconciliation_status TEXT NOT NULL DEFAULT 'unmatched',
          reconciliation_notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'seen',
          reason TEXT NOT NULL DEFAULT '',
          raw_json TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    });

    afterAll(async () => {
      if (!primary || !concurrent) return;
      try {
        await primary.query('ROLLBACK');
        await concurrent.query('ROLLBACK');
        await primary.query('SET search_path TO public');
        await concurrent.query('SET search_path TO public');
        await primary.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await primary.release();
        await concurrent.release();
      }
    });

    it('rejects new dangling writes and generic deletes of referenced opportunities', async () => {
      if (!primary) throw new Error('Missing primary PostgreSQL session.');
      await ensureSourceCrawlOpportunityGuard(primary as never);
      const opportunityId = randomUUID();
      await primary.query('INSERT INTO opportunities (id) VALUES (?)', [
        opportunityId,
      ]);
      await primary.query(
        'INSERT INTO source_crawl_items (id, opportunity_id) VALUES (?, ?)',
        [randomUUID(), opportunityId],
      );

      await expect(
        primary.query(
          'INSERT INTO source_crawl_items (id, opportunity_id) VALUES (?, ?)',
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      await expect(
        primary.query('DELETE FROM opportunities WHERE id = ?', [
          opportunityId,
        ]),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    });

    it('serializes a concurrent crawl-item insert before rejecting the parent delete', async () => {
      if (!primary || !concurrent) {
        throw new Error('Missing PostgreSQL sessions.');
      }
      await ensureSourceCrawlOpportunityGuard(primary as never);
      const opportunityId = randomUUID();
      await primary.query('INSERT INTO opportunities (id) VALUES (?)', [
        opportunityId,
      ]);
      await primary.query('BEGIN');
      await primary.query(
        'INSERT INTO source_crawl_items (id, opportunity_id) VALUES (?, ?)',
        [randomUUID(), opportunityId],
      );
      await concurrent.query('BEGIN');
      await concurrent.query("SET LOCAL statement_timeout = '5s'");
      const deleteAttempt = concurrent.query(
        'DELETE FROM opportunities WHERE id = ?',
        [opportunityId],
      );
      await primary.query('COMMIT');
      await expect(deleteAttempt).rejects.toMatchObject({
        code: 'DATABASE_ERROR',
      });
      await concurrent.query('ROLLBACK');

      const rows = await primary.query(
        'SELECT opportunity_id::text AS "opportunityId" FROM source_crawl_items',
      );
      expect(rows.rows).toEqual([{ opportunityId }]);
    });

    it('retargets every crawl reference before deleting a duplicate alias', async () => {
      if (!primary) throw new Error('Missing primary PostgreSQL session.');
      const session = primary;
      await ensureSourceCrawlOpportunityGuard(primary as never);
      const aliasId = randomUUID();
      const survivorId = randomUUID();
      await primary.query('INSERT INTO opportunities (id) VALUES (?), (?)', [
        aliasId,
        survivorId,
      ]);
      await primary.query(
        'INSERT INTO source_crawl_items (id, opportunity_id) VALUES (?, ?), (?, ?)',
        [randomUUID(), aliasId, randomUUID(), aliasId],
      );

      await primary.query('BEGIN');
      const moved = await mergeOpportunityCrawlReferences(primary as never, {
        aliasId,
        deleteAlias: async () => {
          const deleted = await session.query(
            'DELETE FROM opportunities WHERE id = ?',
            [aliasId],
          );
          return deleted.rowCount === 1;
        },
        survivorId,
      });
      await primary.query('COMMIT');

      expect(moved).toBe(2);
      const rows = await primary.query(
        'SELECT opportunity_id::text AS "opportunityId" FROM source_crawl_items ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { opportunityId: survivorId },
        { opportunityId: survivorId },
      ]);
    });

    it('rolls reference retargeting back when alias deletion fails', async () => {
      if (!primary) throw new Error('Missing primary PostgreSQL session.');
      await ensureSourceCrawlOpportunityGuard(primary as never);
      const aliasId = randomUUID();
      const survivorId = randomUUID();
      await primary.query('INSERT INTO opportunities (id) VALUES (?), (?)', [
        aliasId,
        survivorId,
      ]);
      await primary.query(
        'INSERT INTO source_crawl_items (id, opportunity_id) VALUES (?, ?)',
        [randomUUID(), aliasId],
      );

      await primary.query('BEGIN');
      await expect(
        mergeOpportunityCrawlReferences(primary as never, {
          aliasId,
          deleteAlias: async () => {
            throw new Error('injected delete failure');
          },
          survivorId,
        }),
      ).rejects.toThrow('injected delete failure');
      await primary.query('ROLLBACK');

      const item = await primary.query(
        'SELECT opportunity_id::text AS "opportunityId" FROM source_crawl_items',
      );
      const alias = await primary.query(
        'SELECT id FROM opportunities WHERE id = ?',
        [aliasId],
      );
      expect(item.rows).toEqual([{ opportunityId: aliasId }]);
      expect(alias.rows).toHaveLength(1);
    });

    it('audits a bounded repair, preserves raw provenance, and validates the constraint', async () => {
      if (!primary) throw new Error('Missing primary PostgreSQL session.');
      const missingOpportunityId = randomUUID();
      const secondMissingOpportunityId = randomUUID();
      const rowId = '00000000-0000-0000-0000-000000000001';
      const secondRowId = '00000000-0000-0000-0000-000000000002';
      const rawJson = JSON.stringify({
        source: 'qa',
        title: 'Original posting',
      });
      await primary.query(
        `INSERT INTO source_crawl_items (
           id, opportunity_id, reconciliation_status, status, raw_json
         ) VALUES (?, ?, 'matched', 'created_opportunity', ?),
                  (?, ?, 'matched', 'created_opportunity', ?)`,
        [
          rowId,
          missingOpportunityId,
          rawJson,
          secondRowId,
          secondMissingOpportunityId,
          rawJson,
        ],
      );
      await ensureSourceCrawlOpportunityGuard(primary as never);
      const attestations = await inspectSourceCrawlOpportunityPlanAttestations(
        primary as never,
        {
          limit: 1,
        },
      );
      expect(attestations).toHaveLength(2);
      expect(attestations.map((entry) => entry.afterId)).toEqual(['', rowId]);
      const plan = await inspectSourceCrawlOpportunityOrphans(
        primary as never,
        {
          limit: 1,
        },
      );
      expect(attestations[0]?.planSha256).toBe(plan.fingerprint);
      expect(plan).toMatchObject({ hasMore: true, totalDangling: 2 });
      expect(plan.rows).toHaveLength(1);

      const transactional = transactionAdapter(primary);
      const result = await applySourceCrawlOpportunityRepair(transactional, {
        backupSha256: '0'.repeat(64),
        expectedFingerprint: plan.fingerprint,
        limit: 1,
      });
      const repeated = await applySourceCrawlOpportunityRepair(transactional, {
        backupSha256: '0'.repeat(64),
        expectedFingerprint: plan.fingerprint,
        limit: 1,
      });
      expect(repeated).toEqual(result);
      await expect(
        getSourceCrawlOpportunityGuardStatus(primary as never),
      ).resolves.toEqual({
        foreignKeyPresent: true,
        foreignKeyValidated: false,
        totalDangling: 1,
      });

      const repaired = await primary.query(
        `SELECT opportunity_id AS "opportunityId",
                reconciliation_status AS "reconciliationStatus",
                status, raw_json AS "rawJson"
         FROM source_crawl_items
         WHERE id = ?`,
        [rowId],
      );
      expect(repaired.rows).toEqual([
        {
          opportunityId: null,
          rawJson,
          reconciliationStatus: 'error',
          status: 'persistence_error',
        },
      ]);
      const audit = await primary.query(
        `SELECT before_data->>'raw_json' AS "rawJson"
         FROM data_repair_audit
         WHERE row_id = ?`,
        [rowId],
      );
      expect(audit.rows).toEqual([{ rawJson }]);

      const secondPlan = await inspectSourceCrawlOpportunityOrphans(
        primary as never,
        { afterId: rowId, limit: 1 },
      );
      expect(secondPlan).toMatchObject({
        afterId: rowId,
        hasMore: false,
        totalDangling: 1,
      });
      expect(secondPlan.rows.map((row) => row.rowId)).toEqual([secondRowId]);
      expect(attestations[1]?.planSha256).toBe(secondPlan.fingerprint);
      await applySourceCrawlOpportunityRepair(transactional, {
        afterId: rowId,
        backupSha256: '0'.repeat(64),
        expectedFingerprint: secondPlan.fingerprint,
        limit: 1,
      });
      await expect(
        getSourceCrawlOpportunityGuardStatus(primary as never),
      ).resolves.toEqual({
        foreignKeyPresent: true,
        foreignKeyValidated: true,
        totalDangling: 0,
      });
      const constraint = await primary.query(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conname = ?
           AND connamespace = ?::regnamespace`,
        [SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY, schema],
      );
      expect(constraint.rows).toEqual([{ convalidated: true }]);
    });
  },
);

function transactionAdapter(session: DbSession): SmrtDatabase {
  return {
    query: session.query.bind(session),
    transaction: async <T>(work: (db: never) => Promise<T>) => {
      await session.query('BEGIN');
      try {
        const result = await work(transactionAdapter(session) as never);
        await session.query('COMMIT');
        return result;
      } catch (error) {
        await session.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as SmrtDatabase;
}
