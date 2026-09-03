import { describe, expect, it, vi } from 'vitest';
import {
  completeSourceCrawl,
  failSourceCrawl,
  finalizeSourceCrawl,
  getSourceCrawlWatchdogStatus,
  reapStaleSourceCrawls,
  reconcileFailedSourceCrawlJob,
  SOURCE_CRAWL_RECONCILIATION_BATCH_SIZE,
  SOURCE_CRAWL_TIMEOUT_ERROR,
} from './source-crawl-watchdog';

function firstQueryCall(query: {
  mock: { calls: unknown };
}): [string, unknown[]] {
  const call = (query.mock.calls as unknown as Array<[string, unknown[]]>)[0];
  if (!call) throw new Error('Expected a database query.');
  return call;
}

function queryCallContaining(
  query: { mock: { calls: unknown } },
  fragment: string,
): [string, unknown[]] {
  const call = (query.mock.calls as unknown as Array<[string, unknown[]]>).find(
    ([sql]) => sql.includes(fragment),
  );
  if (!call)
    throw new Error(`Expected a database query containing ${fragment}.`);
  return call;
}

function transactionalDatabase(query: ReturnType<typeof vi.fn>) {
  const transaction = async (work: (db: { query: typeof query }) => unknown) =>
    await work({ query });
  return { query, transaction };
}

const emptyAccounting = {
  attemptCount: 0,
  createdCount: 0,
  duplicateCount: 0,
  failedPersistenceCount: 0,
  pendingCount: 0,
  relistedCount: 0,
  reusedCount: 0,
  skippedCount: 0,
  terminalCount: 0,
};

describe('source crawl watchdog', () => {
  it('reconciles and completes under one transaction with no pending attempts', async () => {
    const query = vi.fn(async (sql: string) => ({
      rowCount: 1,
      rows: sql.includes('COUNT(*)') ? [emptyAccounting] : [{ id: 'crawl-1' }],
    }));
    const database = transactionalDatabase(query);
    const crawl = {
      finishedAt: null,
      id: 'crawl-1',
      jobAttempt: 1,
      jobId: 'job-1',
      status: 'running',
    };

    await expect(
      completeSourceCrawl(
        crawl as never,
        { error: '', status: 'completed' },
        database as never,
      ),
    ).resolves.toBe(true);

    expect(query.mock.calls.some(([sql]) => sql.includes('COUNT(*)'))).toBe(
      true,
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain('SET status = ?');
    expect(crawl).toMatchObject({
      finishedAt: expect.any(Date),
      status: 'completed',
    });
  });

  it('permits an exact no-job manual binding through every terminal fence', async () => {
    const manualCrawl = {
      finishedAt: null,
      id: 'crawl-manual',
      jobAttempt: 0,
      jobId: '',
      status: 'running',
    };
    const finalizeQuery = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const finalizableCrawl = { ...manualCrawl, db: { query: finalizeQuery } };

    await expect(
      finalizeSourceCrawl(finalizableCrawl as never, {
        error: '',
        status: 'completed',
      }),
    ).resolves.toBe(true);
    expect(firstQueryCall(finalizeQuery)[0]).toContain(
      "job_id = '' AND job_attempt = 0",
    );
    expect(firstQueryCall(finalizeQuery)[1].at(-1)).toBe('crawl-manual');

    const completeQuery = vi.fn(async (sql: string) => ({
      rowCount: 1,
      rows: sql.includes('COUNT(*)')
        ? [emptyAccounting]
        : [{ id: 'crawl-manual' }],
    }));
    await expect(
      completeSourceCrawl(
        { ...manualCrawl } as never,
        { error: '', status: 'completed' },
        transactionalDatabase(completeQuery) as never,
      ),
    ).resolves.toBe(true);
    expect(queryCallContaining(completeQuery, 'FOR UPDATE')[0]).toContain(
      "job_id = '' AND job_attempt = 0",
    );

    const failQuery = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ id: 'crawl-manual' }],
    }));
    await expect(
      failSourceCrawl(
        { ...manualCrawl } as never,
        'provider failed',
        transactionalDatabase(failQuery) as never,
      ),
    ).resolves.toBe(true);
    expect(queryCallContaining(failQuery, 'FOR UPDATE')[0]).toContain(
      "job_id = '' AND job_attempt = 0",
    );
  });

  it('refuses completion after a newer runner attempt takes ownership', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{ error: '', finishedAt: null, status: 'running' }],
      };
    });
    const crawl = {
      finishedAt: null,
      id: 'crawl-1',
      jobAttempt: 2,
      jobId: 'job-1',
      status: 'running',
    };

    await expect(
      completeSourceCrawl(
        crawl as never,
        { error: '', status: 'completed' },
        transactionalDatabase(query) as never,
      ),
    ).resolves.toBe(false);

    const [sql, parameters] = queryCallContaining(query, 'FOR UPDATE');
    expect(sql).toContain('job_id = ? AND job_attempt = ?');
    expect(parameters).toEqual(['crawl-1', 'job-1', 2]);
    expect(crawl).toMatchObject({ finishedAt: null, status: 'running' });
  });

  it('reaps overdue running crawls and their still-running source job', async () => {
    const database = transactionalDatabase(
      vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('ORDER BY crawl.started_at ASC, crawl.id ASC')) {
          return {
            rowCount: 2,
            rows: [{ id: 'crawl-1' }, { id: 'crawl-2' }],
          };
        }
        if (sql.includes('WHERE CAST(crawl.id AS TEXT) = ?')) {
          return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
        }
        if (sql.includes('WITH stale_crawls')) {
          return {
            rowCount: 1,
            rows: [{ id: parameters?.[0] }],
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { rowCount: 1, rows: [emptyAccounting] };
        }
        if (sql.includes('SELECT id FROM source_crawls')) {
          return { rowCount: 1, rows: [{ id: 'crawl-1' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    );
    const now = new Date('2026-08-31T01:00:00.000Z');

    await expect(
      reapStaleSourceCrawls(database as never, now),
    ).resolves.toEqual({
      timedOut: 2,
    });

    const [sql, parameters] = queryCallContaining(
      database.query,
      'WITH stale_crawls',
    );
    expect(sql).toContain("status = 'running'");
    expect(parameters).toContain('timed_out');
    expect(sql).toContain('CAST(job.id AS TEXT) = crawl.job_id');
    expect(sql).toContain(
      'CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)',
    );
    expect(sql).toContain(
      "NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL",
    );
    expect(sql).toContain(
      'CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))',
    );
    expect(sql).toContain('crawl.job_attempt > 0');
    expect(sql).toContain('job.attempts = crawl.job_attempt');
    expect(sql).toContain("job.status = 'running'");
    expect(parameters).toContain(SOURCE_CRAWL_TIMEOUT_ERROR);
  });

  it('is idempotent when a second watchdog finds no still-running crawl', async () => {
    const database = transactionalDatabase(
      vi.fn(async () => ({ rowCount: 0, rows: [] })),
    );

    await expect(reapStaleSourceCrawls(database as never)).resolves.toEqual({
      timedOut: 0,
    });
  });

  it('isolates an irrecoverable stale crawl so a later safe crawl still reconciles', async () => {
    const ambiguousCrawlId = `crawl-${'x'.repeat(300)}`;
    let committedTransactions = 0;
    let rolledBackTransactions = 0;
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('ORDER BY crawl.created_at ASC, crawl.id ASC')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('ORDER BY crawl.started_at ASC, crawl.id ASC')) {
        return {
          rowCount: 2,
          rows: [{ id: ambiguousCrawlId }, { id: 'crawl-safe' }],
        };
      }
      if (sql.includes('WHERE CAST(crawl.id AS TEXT) = ?')) {
        return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
      }
      if (sql.includes('FROM source_crawl_items AS item')) {
        if (parameters?.[0] === ambiguousCrawlId) {
          return {
            rowCount: 1,
            rows: [
              {
                itemId: 'item-ambiguous',
                itemStatus: 'pending',
                opportunityId: 'opportunity-1',
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('WITH stale_crawls')) {
        return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
      }
      if (sql.includes('SELECT id FROM source_crawls WHERE id = ?')) {
        return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
      }
      if (sql.includes('COUNT(*)')) {
        return { rowCount: 1, rows: [emptyAccounting] };
      }
      return { rowCount: 1, rows: [] };
    });
    const database = {
      query,
      transaction: async (work: (db: { query: typeof query }) => unknown) => {
        try {
          const result = await work({ query });
          committedTransactions += 1;
          return result;
        } catch (error) {
          rolledBackTransactions += 1;
          throw error;
        }
      },
    };
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(reapStaleSourceCrawls(database as never)).resolves.toEqual({
      timedOut: 1,
    });

    expect(rolledBackTransactions).toBe(1);
    expect(committedTransactions).toBe(1);
    expect(
      query.mock.calls.filter(
        ([sql, parameters]) =>
          sql.includes('WITH stale_crawls') &&
          parameters?.[0] === ambiguousCrawlId,
      ),
    ).toHaveLength(0);
    expect(
      query.mock.calls.filter(
        ([sql, parameters]) =>
          sql.includes('WITH stale_crawls') && parameters?.[0] === 'crawl-safe',
      ),
    ).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining('left the crawl unchanged'),
      expect.objectContaining({
        crawlId: expect.stringMatching(/^crawl-/),
        error: expect.stringContaining('no unambiguous persistence intent'),
        phase: 'timeout',
      }),
    );
    const [, context] = diagnostic.mock.calls[0] ?? [];
    expect(String((context as { error?: unknown }).error ?? '')).toHaveLength(
      240,
    );
    diagnostic.mockRestore();
  });

  it('reaps only exact manual bindings or exact running and terminal job owners', async () => {
    const database = transactionalDatabase(
      vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('ORDER BY crawl.started_at ASC, crawl.id ASC')) {
          return { rowCount: 1, rows: [{ id: 'crawl-1' }] };
        }
        if (sql.includes('WHERE CAST(crawl.id AS TEXT) = ?')) {
          return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
        }
        if (sql.includes('WITH stale_crawls')) {
          return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
        }
        if (sql.includes('SELECT id FROM source_crawls WHERE id = ?')) {
          return { rowCount: 1, rows: [{ id: parameters?.[0] }] };
        }
        if (sql.includes('COUNT(*)')) {
          return { rowCount: 1, rows: [emptyAccounting] };
        }
        return { rowCount: 0, rows: [] };
      }),
    );

    await expect(reapStaleSourceCrawls(database as never)).resolves.toEqual({
      timedOut: 0,
    });

    const [recoverySql] = queryCallContaining(
      database.query,
      'ORDER BY crawl.started_at ASC, crawl.id ASC',
    );
    expect(recoverySql).toContain(
      "crawl.job_id = '' AND crawl.job_attempt = 0",
    );
    expect(recoverySql).toContain(
      "NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(recoverySql).toContain(
      'CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))',
    );
    expect(recoverySql).toContain('OR EXISTS');
    expect(recoverySql).toContain(
      "NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(recoverySql).toContain(
      'CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))',
    );
    expect(recoverySql).toContain('job.attempts = crawl.job_attempt');
    expect(recoverySql).toContain(
      "job.status IN ('running', 'completed', 'failed', 'cancelled')",
    );

    const [timeoutSql] = queryCallContaining(
      database.query,
      'WITH stale_crawls AS',
    );
    const ownerQualifiedSet = timeoutSql.slice(
      timeoutSql.indexOf('WITH stale_crawls AS'),
      timeoutSql.indexOf('), failed_jobs AS'),
    );
    expect(ownerQualifiedSet).toContain("job_id = '' AND job_attempt = 0");
    expect(ownerQualifiedSet).toContain(
      "NULLIF(CAST(source_crawls.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(ownerQualifiedSet).toContain(
      'CAST(source_crawls.source_id AS TEXT) = BTRIM(CAST(source_crawls.source_id AS TEXT))',
    );
    expect(ownerQualifiedSet).toContain('OR EXISTS');
    expect(ownerQualifiedSet).toContain(
      "NULLIF(CAST(source_crawls.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(ownerQualifiedSet).toContain(
      'CAST(source_crawls.source_id AS TEXT) = BTRIM(CAST(source_crawls.source_id AS TEXT))',
    );
    expect(ownerQualifiedSet).toContain(
      'owner.attempts = source_crawls.job_attempt',
    );
    expect(ownerQualifiedSet).toContain(
      "owner.status IN ('running', 'completed', 'failed', 'cancelled')",
    );
    const runningJobUpdate = timeoutSql.slice(
      timeoutSql.indexOf('), failed_jobs AS'),
      timeoutSql.indexOf('), failed_attempts AS'),
    );
    expect(runningJobUpdate).toContain("job.status = 'running'");
  });

  it('durably recovers a queued crawl after failed event reconciliation is lost', async () => {
    let queuedSweep = 0;
    const database = transactionalDatabase(
      vi.fn(async (sql: string) => {
        if (sql.includes('ORDER BY crawl.created_at ASC, crawl.id ASC')) {
          return { rowCount: 1, rows: [{ id: 'crawl-queued' }] };
        }
        if (
          sql.includes('UPDATE source_crawls AS crawl') &&
          sql.includes("crawl.status = 'queued'")
        ) {
          queuedSweep += 1;
          return {
            rowCount: queuedSweep === 1 ? 1 : 0,
            rows: queuedSweep === 1 ? [{ id: 'crawl-queued' }] : [],
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { rowCount: 1, rows: [emptyAccounting] };
        }
        if (sql.includes('SELECT id FROM source_crawls WHERE id = ?')) {
          return { rowCount: 1, rows: [{ id: 'crawl-queued' }] };
        }
        if (sql.includes('WITH stale_crawls')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('UPDATE source_crawls')) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
    );

    await expect(reapStaleSourceCrawls(database as never)).resolves.toEqual({
      timedOut: 0,
    });
    await expect(reapStaleSourceCrawls(database as never)).resolves.toEqual({
      timedOut: 0,
    });

    const [candidateSql, candidateParameters] = queryCallContaining(
      database.query,
      "crawl.status = 'queued'",
    );
    const [sql, parameters] = queryCallContaining(
      database.query,
      'WITH interrupted_queued AS',
    );
    expect(sql).toContain("crawl.status = 'queued'");
    expect(sql).toContain("job.status IN ('completed', 'failed', 'cancelled')");
    expect(sql).toContain(
      'CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)',
    );
    expect(sql).toContain(
      "NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(sql).toContain(
      'CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))',
    );
    expect(sql).toContain('COALESCE(crawl.job_attempt, 0) = 0');
    expect(sql).toContain('job.attempts = crawl.job_attempt');
    expect(sql).toContain('job.queue IN (?, ?)');
    expect(sql).toContain('FOR UPDATE OF crawl SKIP LOCKED');
    expect(parameters).toContain('crawl-queued');
    expect(candidateSql).toContain(
      'ORDER BY crawl.created_at ASC, crawl.id ASC',
    );
    expect(candidateSql).toContain('LIMIT ?');
    expect(candidateParameters).toContain('source-crawls');
    expect(candidateParameters).toContain('agents');
    expect(candidateParameters).toContain(
      SOURCE_CRAWL_RECONCILIATION_BATCH_SIZE,
    );
    expect(
      database.query.mock.calls.filter(([query]) =>
        query.includes('WITH interrupted_queued'),
      ),
    ).toHaveLength(2);
  });

  it('does not let a late completion overwrite a watchdog terminal state', async () => {
    const crawl = {
      db: { query: vi.fn(async () => ({ rowCount: 0 })) },
      error: SOURCE_CRAWL_TIMEOUT_ERROR,
      finishedAt: new Date('2026-08-31T00:00:00.000Z'),
      id: 'crawl-1',
      status: 'timed_out',
    };

    await expect(
      finalizeSourceCrawl(crawl as never, {
        error: '',
        fields: { resultCount: 12 },
        status: 'completed',
      }),
    ).resolves.toBe(false);
    expect(crawl.error).toBe(SOURCE_CRAWL_TIMEOUT_ERROR);
    expect(crawl.status).toBe('timed_out');
    expect(crawl).not.toHaveProperty('resultCount');
  });

  it('refreshes the actual watchdog-owned state when completion loses its fence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT status')) {
        return {
          rowCount: 1,
          rows: [
            {
              error: SOURCE_CRAWL_TIMEOUT_ERROR,
              finishedAt: new Date('2026-08-31T00:00:00.000Z'),
              status: 'timed_out',
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const crawl = {
      finishedAt: null,
      id: 'crawl-1',
      jobAttempt: 1,
      jobId: 'job-1',
      status: 'running',
    };

    await expect(
      completeSourceCrawl(
        crawl as never,
        { error: '', status: 'completed' },
        transactionalDatabase(query) as never,
      ),
    ).resolves.toBe(false);
    expect(crawl).toMatchObject({
      error: SOURCE_CRAWL_TIMEOUT_ERROR,
      finishedAt: expect.any(Date),
      status: 'timed_out',
    });
  });

  it('terminalizes pending attempts when a crawl fails before completion', async () => {
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => ({
      rowCount: 1,
      rows: sql.includes('COUNT(*)')
        ? [
            {
              attemptCount: 1,
              createdCount: 0,
              duplicateCount: 0,
              failedPersistenceCount: 1,
              pendingCount: 0,
              relistedCount: 0,
              reusedCount: 0,
              skippedCount: 0,
              terminalCount: 1,
            },
          ]
        : [{ id: 'crawl-1' }],
    }));
    const database = transactionalDatabase(query);
    const crawl = {
      db: { query },
      finishedAt: null,
      id: 'crawl-1',
      jobAttempt: 1,
      jobId: 'job-1',
      status: 'running',
    };

    await expect(
      failSourceCrawl(
        crawl as never,
        'provider persistence stopped',
        database as never,
      ),
    ).resolves.toBe(true);

    expect(queryCallContaining(query, 'FOR UPDATE')[0]).toContain(
      "status = 'running'",
    );
    const [terminalizeSql] = queryCallContaining(
      query,
      "outcome = 'failed_persistence'",
    );
    expect(terminalizeSql).toContain("outcome = 'failed_persistence'");
    expect(terminalizeSql).toContain("outcome = 'pending'");
    expect(query.mock.calls.at(-1)?.[0]).toContain('UPDATE source_crawls');
  });

  it('refuses terminal transitions for a production-backed crawl without an exact durable owner', async () => {
    const finalizeQuery = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const crawl = {
      db: { query: finalizeQuery },
      finishedAt: null,
      id: 'crawl-1',
      jobAttempt: 1,
      jobId: ' job-1 ',
      status: 'running',
    };

    await expect(
      finalizeSourceCrawl(crawl as never, {
        error: '',
        status: 'completed',
      }),
    ).resolves.toBe(false);
    await expect(
      completeSourceCrawl(
        crawl as never,
        { error: '', status: 'completed' },
        transactionalDatabase(
          vi.fn(async () => ({ rowCount: 1, rows: [] })),
        ) as never,
      ),
    ).resolves.toBe(false);
    await expect(
      failSourceCrawl(
        crawl as never,
        'provider failed',
        transactionalDatabase(
          vi.fn(async () => ({ rowCount: 1, rows: [] })),
        ) as never,
      ),
    ).resolves.toBe(false);

    expect(finalizeQuery).not.toHaveBeenCalled();
    expect(crawl).toMatchObject({ finishedAt: null, status: 'running' });
  });

  it('reconciles an interrupted source job while its crawl is queued or running', async () => {
    const database = transactionalDatabase(
      vi.fn(async (sql: string) => {
        if (sql.includes('WITH failed_crawls')) {
          return { rowCount: 1, rows: [{ id: 'crawl-1' }] };
        }
        if (sql.includes('COUNT(*)')) {
          return { rowCount: 1, rows: [emptyAccounting] };
        }
        if (sql.includes('SELECT id FROM source_crawls')) {
          return { rowCount: 1, rows: [{ id: 'crawl-1' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    );

    await expect(
      reconcileFailedSourceCrawlJob('job-1', database as never),
    ).resolves.toEqual({ markedFailed: 1 });
    const [sql] = queryCallContaining(database.query, 'WITH failed_crawls');
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("outcome = 'failed_persistence'");
    expect(sql).toContain("job.status IN ('failed', 'cancelled')");
    expect(sql).toContain(
      'CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)',
    );
    expect(sql).toContain(
      "NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL",
    );
    expect(sql).toContain(
      'CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))',
    );
    expect(sql).toContain(
      "NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL",
    );
    expect(sql).toContain(
      'CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))',
    );
    expect(sql).toContain("status IN ('queued', 'running')");
  });

  it.each([
    '',
    ' job-1 ',
  ])('rejects a non-exact failed-job event before any mutation query', async (jobId) => {
    const query = vi.fn();

    await expect(
      reconcileFailedSourceCrawlJob(
        jobId,
        transactionalDatabase(query) as never,
      ),
    ).resolves.toEqual({ markedFailed: 0 });

    expect(query).not.toHaveBeenCalled();
  });

  it('reports terminal, active, and stale-running states without mutating rows', async () => {
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              active: '3',
              completed: '8',
              failed: '2',
              queued: '1',
              stale_running: '4',
              timed_out: '5',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              error: `Authorization: Bearer not-for-logs ${'x'.repeat(300)}`,
              finished_at: '2026-08-31T00:00:00.000Z',
              id: 'crawl-1',
              status: 'timed_out',
            },
          ],
        }),
    };

    const status = await getSourceCrawlWatchdogStatus(database as never);
    expect(status).toMatchObject({
      active: 3,
      completed: 8,
      failed: 2,
      queued: 1,
      staleRunning: 4,
      timedOut: 5,
    });
    expect(status.recentTerminalErrors).toEqual([
      expect.objectContaining({
        finishedAt: '2026-08-31T00:00:00.000Z',
        id: 'crawl-1',
        status: 'timed_out',
      }),
    ]);
    expect(status.recentTerminalErrors[0]?.error).not.toContain('not-for-logs');
    expect(status.recentTerminalErrors[0]?.error).toHaveLength(240);
    const [sql] = firstQueryCall(database.query);
    expect(sql).toContain('COUNT(*) FILTER');
    expect(database.query.mock.calls[1]?.[0]).toContain('LIMIT 10');
  });
});
