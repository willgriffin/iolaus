import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'postgres', url: 'postgresql://test' }),
}));

import {
  ensureSourceCrawlJobDedupe,
  getSourceCrawlJobDedupeStatus,
  isSourceCrawlActiveJobConflict,
  SOURCE_CRAWL_ACTIVE_JOB_INDEX,
} from './source-crawl-job-schema.js';

const readyIndex = {
  index_definition: `CREATE UNIQUE INDEX ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}
    ON public._smrt_jobs USING btree (object_type, object_id, method)
    WHERE status = ANY (ARRAY['pending'::text, 'running'::text])
      AND queue = ANY (ARRAY['source-crawls'::text, 'agents'::text])
      AND object_type = '@willgriffin/iolaus-site:Source'::text
      AND method = 'crawl'::text
      AND object_id IS NOT NULL`,
  is_ready: true,
  is_unique: true,
  is_valid: true,
};

function transactionalDatabase(query: ReturnType<typeof vi.fn>) {
  return {
    query,
    transaction: async (work: (db: { query: typeof query }) => unknown) =>
      await work({ query }),
  };
}

const reconciledAccounting = {
  attemptCount: 1,
  createdCount: 0,
  duplicateCount: 0,
  failedPersistenceCount: 1,
  pendingCount: 0,
  relistedCount: 0,
  reusedCount: 0,
  skippedCount: 0,
  terminalCount: 1,
};

describe('source crawl job schema', () => {
  it('preserves a running job and cancels pending duplicates before adding uniqueness', async () => {
    let statusReads = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('pg_get_indexdef')) {
        statusReads += 1;
        return { rows: statusReads === 1 ? [] : [readyIndex] };
      }
      return { rows: [] };
    });
    await ensureSourceCrawlJobDedupe(transactionalDatabase(query) as never);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("status IN ('pending', 'running')");
    expect(sql).toContain("CASE WHEN status = 'running' THEN 0 ELSE 1 END ASC");
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain("AND jobs.status = 'pending'");
    expect(sql).toContain('SELECT id, object_id FROM cancelled');
    expect(sql).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}`,
    );
    expect(sql).toContain('ON _smrt_jobs (object_type, object_id, method)');
    expect(sql).toContain('PARTITION BY object_type, object_id, method');
    expect(sql).toContain('queue IN (?, ?)');
    expect(sql).toContain("queue IN ('source-crawls', 'agents')");
  });

  it('recognizes only conflicts from the source-crawl active index', () => {
    expect(
      isSourceCrawlActiveJobConflict({
        code: '23505',
        constraint: SOURCE_CRAWL_ACTIVE_JOB_INDEX,
      }),
    ).toBe(true);
    expect(
      isSourceCrawlActiveJobConflict({ code: '23505', constraint: 'other' }),
    ).toBe(false);
  });

  it('reports the active-job index ready only for the exact physical guard', async () => {
    const present = await getSourceCrawlJobDedupeStatus({
      query: vi.fn(async () => ({ rows: [readyIndex] })),
    } as never);
    const missing = await getSourceCrawlJobDedupeStatus({
      query: vi.fn(async () => ({ rows: [] })),
    } as never);
    const nonUnique = await getSourceCrawlJobDedupeStatus({
      query: vi.fn(async () => ({
        rows: [{ ...readyIndex, is_unique: false }],
      })),
    } as never);
    const wrongColumnOrder = await getSourceCrawlJobDedupeStatus({
      query: vi.fn(async () => ({
        rows: [
          {
            ...readyIndex,
            index_definition: readyIndex.index_definition.replace(
              '(object_type, object_id, method)',
              '(object_id, object_type, method)',
            ),
          },
        ],
      })),
    } as never);
    const wrongPredicate = await getSourceCrawlJobDedupeStatus({
      query: vi.fn(async () => ({
        rows: [
          {
            ...readyIndex,
            index_definition: readyIndex.index_definition.replace(
              "status = ANY (ARRAY['pending'::text, 'running'::text])",
              "status = 'pending'::text",
            ),
          },
        ],
      })),
    } as never);

    expect(present).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: true,
    });
    expect(missing).toEqual({
      activeIndexNamed: false,
      activeIndexPresent: false,
    });
    expect(nonUnique).toEqual({
      activeIndexNamed: true,
      activeIndexPresent: false,
    });
    expect(wrongColumnOrder.activeIndexPresent).toBe(false);
    expect(wrongPredicate.activeIndexPresent).toBe(false);
  });

  it('repairs a named malformed index before recreating the guard', async () => {
    let statusReads = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('pg_get_indexdef')) {
        statusReads += 1;
        return {
          rows:
            statusReads === 1
              ? [{ ...readyIndex, is_valid: false }]
              : [readyIndex],
        };
      }
      return { rows: [] };
    });

    await ensureSourceCrawlJobDedupe(transactionalDatabase(query) as never);

    expect(query).toHaveBeenCalledWith(
      `DROP INDEX ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}`,
    );
  });

  it('atomically reconciles a cancelled scheduled retry before terminalizing its crawl', async () => {
    let statusReads = 0;
    let cancellationRuns = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('pg_get_indexdef')) {
        statusReads += 1;
        return { rows: statusReads === 1 ? [] : [readyIndex] };
      }
      if (statement.includes('SELECT id, object_id FROM cancelled')) {
        cancellationRuns += 1;
        return {
          rowCount: cancellationRuns === 1 ? 1 : 0,
          rows:
            cancellationRuns === 1
              ? [{ id: 'scheduled-job', object_id: 'source-1' }]
              : [],
        };
      }
      if (statement.includes('CAST(source_id AS TEXT) AS source_id')) {
        return {
          rows: [{ id: 'crawl-1', source_id: 'source-1', status: 'running' }],
        };
      }
      if (statement.includes('COUNT(*)::integer')) {
        return { rows: [reconciledAccounting] };
      }
      if (statement.includes('SELECT id FROM source_crawls WHERE id = ?')) {
        return { rows: [{ id: 'crawl-1' }] };
      }
      if (
        statement.includes('UPDATE source_crawls') &&
        statement.includes("SET status = 'failed'")
      ) {
        return { rowCount: 1, rows: [{ id: 'crawl-1' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const database = transactionalDatabase(query);

    await ensureSourceCrawlJobDedupe(database as never);

    const statements = query.mock.calls.map(([statement]) => statement);
    const terminalizeAttempts = statements.findIndex((statement) =>
      statement.includes("SET outcome = 'failed_persistence'"),
    );
    const reconcileAccounting = statements.findIndex((statement) =>
      statement.includes('SET result_count = ?'),
    );
    const terminalizeCrawl = statements.findIndex(
      (statement) =>
        statement.includes('UPDATE source_crawls') &&
        statement.includes("SET status = 'failed'"),
    );
    expect(terminalizeAttempts).toBeGreaterThan(-1);
    expect(reconcileAccounting).toBeGreaterThan(terminalizeAttempts);
    expect(terminalizeCrawl).toBeGreaterThan(reconcileAccounting);
    expect(statements[terminalizeCrawl]).toContain('AND job_id = ?');
    expect(statements[terminalizeCrawl]).toContain(
      'AND CAST(source_id AS TEXT) = ?',
    );

    statusReads = 0;
    await ensureSourceCrawlJobDedupe(database as never);
    expect(cancellationRuns).toBe(2);
    expect(
      query.mock.calls.filter(
        ([statement]) =>
          statement.includes('UPDATE source_crawls') &&
          statement.includes("SET status = 'failed'"),
      ),
    ).toHaveLength(1);
  });

  it('rejects a cancelled job with a mismatched crawl/source binding', async () => {
    let statusReads = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('pg_get_indexdef')) {
        statusReads += 1;
        return { rows: statusReads === 1 ? [] : [readyIndex] };
      }
      if (statement.includes('SELECT id, object_id FROM cancelled')) {
        return {
          rows: [{ id: 'scheduled-job', object_id: 'source-1' }],
        };
      }
      if (statement.includes('CAST(source_id AS TEXT) AS source_id')) {
        return {
          rows: [
            { id: 'crawl-forged', source_id: 'source-2', status: 'running' },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(
      ensureSourceCrawlJobDedupe(transactionalDatabase(query) as never),
    ).rejects.toThrow('mismatched crawl/source binding');
    expect(
      query.mock.calls.some(
        ([statement]) =>
          statement.includes('UPDATE source_crawls') &&
          statement.includes("SET status = 'failed'"),
      ),
    ).toBe(false);
  });
});
