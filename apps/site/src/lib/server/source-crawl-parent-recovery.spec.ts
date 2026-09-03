import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accounting, reconcile } = vi.hoisted(() => {
  const value = {
    attemptCount: 2,
    createdCount: 1,
    duplicateCount: 0,
    failedPersistenceCount: 1,
    pendingCount: 0,
    relistedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    terminalCount: 2,
  };
  return { accounting: value, reconcile: vi.fn(async () => value) };
});

vi.mock('./source-crawl-accounting.js', () => ({
  reconcileSourceCrawlAccountingTransaction: reconcile,
}));
vi.mock('./source-schedules.js', () => ({
  SCHEDULED_SOURCE_QUEUE: 'agents',
  SOURCE_CRAWL_METHOD: 'crawl',
  SOURCE_CRAWL_QUEUE: 'source-crawls',
  SOURCE_CRAWL_TIMEOUT_MS: 3 * 60 * 1000,
  SOURCE_JOB_OBJECT_TYPE: '@willgriffin/iolaus-site:Source',
}));

import {
  applySourceCrawlParentRecovery,
  inspectSourceCrawlParentRecovery,
} from './source-crawl-parent-recovery.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const crawlBefore = {
  finished_at: null,
  id: 'crawl-1',
  job_attempt: 0,
  job_id: 'job-1',
  source_id: 'source-1',
  started_at: '2026-09-01T11:00:00.000Z',
  status: 'running',
};
const jobBefore = {
  attempts: 3,
  id: 'job-1',
  method: 'crawl',
  object_id: 'source-1',
  object_type: '@willgriffin/iolaus-site:Source',
  queue: 'agents',
  status: 'failed',
};
const itemBefore = [
  {
    id: 'item-1',
    opportunity_id: 'opportunity-1',
    outcome: 'created',
    source_crawl_id: 'crawl-1',
    terminal_at: '2026-09-01T11:01:00.000Z',
  },
  {
    id: 'item-2',
    opportunity_id: null,
    outcome: 'failed_persistence',
    source_crawl_id: 'crawl-1',
    terminal_at: '2026-09-01T11:02:00.000Z',
  },
];

beforeEach(() => {
  reconcile.mockReset();
  reconcile.mockResolvedValue(accounting);
});

describe('stale source crawl parent recovery', () => {
  it('builds a deterministic bounded plan from the full parent, job, and item state', async () => {
    const first = await inspectSourceCrawlParentRecovery(
      inspectionDb(crawlBefore, jobBefore, itemBefore) as never,
      { crawlId: 'crawl-1', now: NOW },
    );
    const second = await inspectSourceCrawlParentRecovery(
      inspectionDb(
        { ...crawlBefore },
        { ...jobBefore },
        [...itemBefore].reverse(),
      ) as never,
      { crawlId: 'crawl-1', now: NOW },
    );
    expect(first).toMatchObject({
      crawlId: 'crawl-1',
      eligible: true,
      itemCount: 2,
      jobPresent: true,
      sourceId: 'source-1',
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first).not.toHaveProperty('crawlBefore');
    expect(first).not.toHaveProperty('jobBefore');
    expect(first).not.toHaveProperty('itemBefore');
  });

  it('allows an absent referenced job but requires an exact nonblank job id', async () => {
    await expect(expectPlan({ job: null })).resolves.toMatchObject({
      eligible: true,
    });
    await expect(
      expectPlan({ crawl: { ...crawlBefore, job_id: '' }, job: null }),
    ).resolves.toMatchObject({
      eligible: false,
      reason: expect.stringContaining('job_id'),
    });
    await expect(
      expectPlan({ crawl: { ...crawlBefore, job_id: ' job-1' }, job: null }),
    ).resolves.toMatchObject({ eligible: false });
  });

  it.each([
    [
      { ...crawlBefore, status: 'queued' },
      jobBefore,
      itemBefore,
      'not exactly running',
    ],
    [
      { ...crawlBefore, finished_at: '2026-09-01T11:05:00Z' },
      jobBefore,
      itemBefore,
      'already set',
    ],
    [
      { ...crawlBefore, started_at: '2026-09-01T11:59:00Z' },
      jobBefore,
      itemBefore,
      'has not exceeded',
    ],
    [
      { ...crawlBefore, started_at: 'invalid' },
      jobBefore,
      itemBefore,
      'malformed',
    ],
    [
      { ...crawlBefore, job_attempt: 3 },
      jobBefore,
      itemBefore,
      'blank or zero',
    ],
    [
      crawlBefore,
      { ...jobBefore, status: 'completed' },
      itemBefore,
      'not exactly failed',
    ],
    [
      crawlBefore,
      { ...jobBefore, object_id: 'source-other' },
      itemBefore,
      'source binding',
    ],
    [crawlBefore, { ...jobBefore, queue: 'other' }, itemBefore, 'queue'],
    [
      crawlBefore,
      { ...jobBefore, object_type: 'Other' },
      itemBefore,
      'object type',
    ],
    [crawlBefore, { ...jobBefore, method: 'other' }, itemBefore, 'method'],
    [
      crawlBefore,
      jobBefore,
      [{ ...itemBefore[0], outcome: 'pending' }],
      'outcome is pending',
    ],
    [
      crawlBefore,
      jobBefore,
      [{ ...itemBefore[0], terminal_at: null }],
      'terminal_at is null',
    ],
  ])('fails closed for ineligible state', async (crawl, job, items, reason) => {
    const plan = await inspectSourceCrawlParentRecovery(
      inspectionDb(crawl, job, items) as never,
      { crawlId: 'crawl-1', now: NOW },
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toContain(reason);
  });

  it('archives every full row, reconciles first, and terminalizes conservatively', async () => {
    const plan = await expectPlan({});
    const db = applyingDb();
    const result = await applySourceCrawlParentRecovery(db as never, {
      backupSha256: 'b'.repeat(64),
      crawlId: 'crawl-1',
      expectedFingerprint: plan.fingerprint,
      now: NOW,
      reason: 'Legacy job failed after all item accounting became terminal.',
    });
    expect(result).toMatchObject({
      accounting,
      archivedRows: 4,
      crawlId: 'crawl-1',
      status: 'timed_out',
    });
    const calls = db.query.mock.calls as [string, unknown[] | undefined][];
    expect(calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(
      true,
    );
    expect(
      calls.some(([sql]) =>
        sql.includes('_smrt_jobs WHERE id::text = ? FOR UPDATE'),
      ),
    ).toBe(true);
    expect(
      calls.some(([sql]) =>
        sql.includes('LOCK TABLE _smrt_jobs IN SHARE ROW EXCLUSIVE MODE'),
      ),
    ).toBe(true);
    expect(
      calls.some(([sql]) => sql.includes('ORDER BY id::text FOR UPDATE')),
    ).toBe(true);
    const archives = calls.filter(([sql]) =>
      sql.includes('INSERT INTO data_repair_audit'),
    );
    expect(archives).toHaveLength(4);
    expect(archives.map(([, params]) => params?.[2])).toEqual([
      'source_crawls',
      '_smrt_jobs',
      'source_crawl_items',
      'source_crawl_items',
    ]);
    const mutationIndex = calls.findIndex(([sql]) =>
      sql.includes("SET status = 'timed_out'"),
    );
    expect(reconcile).toHaveBeenCalledWith(db, 'crawl-1');
    const mutation = calls[mutationIndex]?.[0] ?? '';
    expect(mutation).toContain("status = 'running'");
    expect(mutation).toContain('finished_at IS NULL');
    expect(mutation).toContain('COALESCE(job_attempt, 0) = 0');
    expect(mutation).not.toMatch(
      /opportunity|completed_with_errors|completed'/u,
    );
  });

  it('rejects fingerprint and concurrent ownership changes without a completed audit run', async () => {
    const staleDb = applyingDb();
    await expect(
      applySourceCrawlParentRecovery(staleDb as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: 'a'.repeat(64),
        now: NOW,
        reason: 'Operator confirmed stale state.',
      }),
    ).rejects.toThrow('plan changed');
    expect(
      staleDb.query.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("SET status = 'timed_out'"),
      ),
    ).toBe(false);

    const plan = await expectPlan({});
    const changedDb = applyingDb({ mutationRows: 0 });
    await expect(
      applySourceCrawlParentRecovery(changedDb as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: plan.fingerprint,
        now: NOW,
        reason: 'Operator confirmed stale state.',
      }),
    ).rejects.toThrow('exact parent fence');
    expect(changedDb.committed).toBe(false);
    expect(
      changedDb.query.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO data_repair_runs'),
      ),
    ).toBe(false);
  });

  it('rolls back when canonical accounting rejects and returns exact recorded retries', async () => {
    const plan = await expectPlan({});
    reconcile.mockRejectedValueOnce(new Error('accounting invariant failed'));
    const rollbackDb = applyingDb();
    await expect(
      applySourceCrawlParentRecovery(rollbackDb as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: plan.fingerprint,
        now: NOW,
        reason: 'Operator confirmed stale state.',
      }),
    ).rejects.toThrow('accounting invariant failed');
    expect(rollbackDb.committed).toBe(false);

    const recorded = {
      accounting,
      archivedRows: 4,
      crawlId: 'crawl-1',
      fingerprint: plan.fingerprint,
      repairId: `recorded:${plan.fingerprint}`,
      status: 'timed_out',
    };
    const retryDb = applyingDb({ previous: recorded });
    await expect(
      applySourceCrawlParentRecovery(retryDb as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: plan.fingerprint,
        now: NOW,
        reason: 'Operator confirmed stale state.',
      }),
    ).resolves.toEqual(recorded);
    expect(
      retryDb.query.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("SET status = 'timed_out'"),
      ),
    ).toBe(false);
  });
});

function expectPlan(overrides: {
  crawl?: Record<string, unknown>;
  items?: Record<string, unknown>[];
  job?: Record<string, unknown> | null;
}) {
  return inspectSourceCrawlParentRecovery(
    inspectionDb(
      overrides.crawl ?? crawlBefore,
      overrides.job === undefined ? jobBefore : overrides.job,
      overrides.items ?? itemBefore,
    ) as never,
    { crawlId: 'crawl-1', now: NOW },
  );
}

function inspectionDb(
  crawl: Record<string, unknown> | undefined,
  job: Record<string, unknown> | null,
  items: Record<string, unknown>[],
) {
  return {
    query: vi.fn(async () => ({
      rows: crawl
        ? [{ crawlBefore: crawl, itemBefore: items, jobBefore: job }]
        : [],
    })),
  };
}

function applyingDb(
  options: { mutationRows?: number; previous?: Record<string, unknown> } = {},
) {
  type FakeDb = {
    committed: boolean;
    query: ReturnType<typeof vi.fn>;
    transaction: <T>(work: (transaction: FakeDb) => Promise<T>) => Promise<T>;
  };
  const db: FakeDb = {
    committed: false,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('source_crawls WHERE id::text = ? FOR UPDATE'))
        return { rows: [{ id: 'crawl-1' }] };
      if (sql.includes('job_id AS "jobId"'))
        return { rows: [{ jobId: 'job-1' }] };
      if (sql.includes('_smrt_jobs WHERE id::text = ? FOR UPDATE'))
        return { rows: [{ id: 'job-1' }] };
      if (sql.includes('FROM data_repair_runs'))
        return {
          rows: options.previous ? [{ summary: options.previous }] : [],
        };
      if (sql.includes('to_jsonb(crawl)'))
        return { rows: [{ crawlBefore, itemBefore, jobBefore }] };
      if (sql.includes("SET status = 'timed_out'")) {
        const count = options.mutationRows ?? 1;
        return { rowCount: count, rows: count ? [{ id: 'crawl-1' }] : [] };
      }
      return { rowCount: 0, rows: [] };
    }),
    transaction: async <T>(work: (transaction: typeof db) => Promise<T>) => {
      try {
        const value = await work(db);
        db.committed = true;
        return value;
      } catch (error) {
        db.committed = false;
        throw error;
      }
    },
  };
  return db;
}
