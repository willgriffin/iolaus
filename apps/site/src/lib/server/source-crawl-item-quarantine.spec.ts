import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accounting, reconcile } = vi.hoisted(() => {
  const value = {
    attemptCount: 2,
    createdCount: 0,
    duplicateCount: 0,
    failedPersistenceCount: 1,
    pendingCount: 1,
    relistedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    terminalCount: 1,
  };
  return { accounting: value, reconcile: vi.fn(async () => value) };
});

vi.mock('./source-crawl-accounting.js', () => ({
  reconcileSourceCrawlAccountingTransaction: reconcile,
}));
vi.mock('./source-schedules.js', () => ({
  SOURCE_CRAWL_TIMEOUT_MS: 3 * 60 * 1000,
}));

import {
  applySourceCrawlItemQuarantine,
  inspectSourceCrawlItemQuarantine,
} from './source-crawl-item-quarantine.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const crawlBefore = {
  finished_at: null,
  id: 'crawl-1',
  pending_count: 2,
  source_id: 'source-1',
  started_at: '2026-08-31T11:00:00.000Z',
  status: 'running',
};
const itemBefore = {
  attempt_key: 'attempt-1',
  id: 'item-1',
  opportunity_id: null,
  outcome: 'pending',
  raw_json: { title: 'Ambiguous candidate' },
  source_crawl_id: 'crawl-1',
  status: 'pending',
  terminal_at: null,
};

beforeEach(() => {
  reconcile.mockClear();
});

describe('source crawl item quarantine', () => {
  it('builds a deterministic, bounded plan for one exact pending item', async () => {
    const first = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawlBefore, itemBefore) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    const second = await inspectSourceCrawlItemQuarantine(
      inspectionDb(
        {
          status: 'running',
          source_id: 'source-1',
          pending_count: 2,
          id: 'crawl-1',
          started_at: '2026-08-31T11:00:00.000Z',
          finished_at: null,
        },
        {
          terminal_at: null,
          status: 'pending',
          source_crawl_id: 'crawl-1',
          raw_json: { title: 'Ambiguous candidate' },
          outcome: 'pending',
          opportunity_id: null,
          id: 'item-1',
          attempt_key: 'attempt-1',
        },
      ) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );

    expect(first).toMatchObject({
      crawlId: 'crawl-1',
      eligible: true,
      itemId: 'item-1',
      itemOutcome: 'pending',
      itemStatus: 'pending',
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first).not.toHaveProperty('crawlBefore');
    expect(first).not.toHaveProperty('itemBefore');
  });

  it('rejects normalized or mismatched selectors', async () => {
    const db = inspectionDb(crawlBefore, itemBefore);
    await expect(
      inspectSourceCrawlItemQuarantine(db as never, {
        crawlId: ' crawl-1',
        itemId: 'item-1',
        now: NOW,
      }),
    ).rejects.toThrow('exact non-empty');
    expect(db.query).not.toHaveBeenCalled();

    await expect(
      inspectSourceCrawlItemQuarantine(db as never, {
        crawlId: 'c'.repeat(201),
        itemId: 'item-1',
        now: NOW,
      }),
    ).rejects.toThrow('exact non-empty');

    await expect(
      inspectSourceCrawlItemQuarantine(
        inspectionDb(undefined, undefined) as never,
        { crawlId: 'crawl-1', itemId: 'item-other', now: NOW },
      ),
    ).rejects.toThrow('does not belong');
  });

  it.each([
    [{ ...itemBefore, outcome: 'created' }, 'not pending'],
    [{ ...itemBefore, opportunity_id: 'opportunity-1' }, 'already attributed'],
    [
      { ...itemBefore, status: 'pending_created:opportunity-1' },
      'recoverable terminal intent',
    ],
    [{ ...itemBefore, terminal_at: '2026-08-31T12:00:00Z' }, 'already set'],
  ])('fails closed for an ineligible before state', async (item, reason) => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawlBefore, item) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toContain(reason);
  });

  it.each([
    [{ ...crawlBefore, status: 'queued' }, 'not exactly running'],
    [{ ...crawlBefore, status: undefined }, 'not exactly running'],
    [
      { ...crawlBefore, started_at: '2026-08-31T11:59:00.000Z' },
      'has not exceeded',
    ],
    [{ ...crawlBefore, started_at: undefined }, 'missing or malformed'],
    [{ ...crawlBefore, started_at: 'not-a-date' }, 'missing or malformed'],
    [{ ...crawlBefore, finished_at: undefined }, 'missing or already set'],
  ])('rejects active or malformed parent state', async (crawl, reason) => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawl, itemBefore) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toContain(reason);
  });

  it('accepts the watchdog timeout boundary exactly', async () => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(
        { ...crawlBefore, started_at: '2026-08-31T11:57:00.000Z' },
        itemBefore,
      ) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    expect(plan.eligible).toBe(true);
  });

  it('uses the SQL epoch for a timezone-less started_at value', async () => {
    const timezoneLessStartedAt = '2026-08-31 11:57:00';
    const db = inspectionDb(
      { ...crawlBefore, started_at: timezoneLessStartedAt },
      itemBefore,
      { startedAtEpochMs: Date.parse('2026-08-31T11:57:00.000Z') },
    );

    const plan = await inspectSourceCrawlItemQuarantine(db as never, {
      crawlId: 'crawl-1',
      itemId: 'item-1',
      now: NOW,
    });

    expect(plan.eligible).toBe(true);
    expect(db.query.mock.calls[0]?.[0]).toContain(
      'EXTRACT(EPOCH FROM crawl.started_at) * 1000',
    );
  });

  it.each([
    undefined,
    '',
    ' ',
    'not-a-number',
    'Infinity',
    Infinity,
    NaN,
  ])('fails closed when the SQL epoch is unavailable or invalid: %j', async (startedAtEpochMs) => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawlBefore, itemBefore, { startedAtEpochMs }) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toContain('started_at is missing or malformed');
  });

  it('archives both full before rows and reconciles after conservative quarantine', async () => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawlBefore, itemBefore) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    const db = applyingDb(crawlBefore, itemBefore);

    const result = await applySourceCrawlItemQuarantine(db as never, {
      backupSha256: 'b'.repeat(64),
      crawlId: 'crawl-1',
      expectedFingerprint: plan.fingerprint,
      itemId: 'item-1',
      now: NOW,
      reason: 'No persisted terminal intent after operator investigation.',
    });

    expect(result).toMatchObject({
      accounting,
      crawlId: 'crawl-1',
      fingerprint: plan.fingerprint,
      itemId: 'item-1',
      quarantinedRows: 1,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    const calls = db.query.mock.calls as [string, unknown[] | undefined][];
    expect(calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(
      true,
    );
    expect(
      calls.some(([sql]) =>
        sql.includes('source_crawls WHERE id::text = ? FOR UPDATE'),
      ),
    ).toBe(true);
    const archives = calls.filter(([sql]) =>
      sql.includes('INSERT INTO data_repair_audit'),
    );
    expect(archives).toHaveLength(2);
    expect(archives.map(([, params]) => params?.[2])).toEqual([
      'source_crawls',
      'source_crawl_items',
    ]);
    expect(archives[0]?.[1]?.[5]).toBe(JSON.stringify(crawlBefore));
    expect(archives[1]?.[1]?.[5]).toBe(JSON.stringify(itemBefore));
    const mutation = calls.find(([sql]) =>
      sql.includes("SET outcome = 'failed_persistence'"),
    );
    expect(mutation?.[0]).toContain('opportunity_id = NULL');
    expect(mutation?.[0]).toContain("status = 'persistence_error'");
    expect(mutation?.[0]).toContain("outcome = 'pending'");
  });

  it('rechecks parent staleness under the apply locks before mutation', async () => {
    const plan = await inspectSourceCrawlItemQuarantine(
      inspectionDb(crawlBefore, itemBefore) as never,
      { crawlId: 'crawl-1', itemId: 'item-1', now: NOW },
    );
    const db = applyingDb(crawlBefore, itemBefore);

    await expect(
      applySourceCrawlItemQuarantine(db as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: plan.fingerprint,
        itemId: 'item-1',
        now: new Date('2026-08-31T11:01:00.000Z'),
        reason: 'Operator confirmed ambiguity.',
      }),
    ).rejects.toThrow('has not exceeded the application timeout');
    const calls = db.query.mock.calls as [string][];
    expect(
      calls.some(([sql]) =>
        String(sql).includes("SET outcome = 'failed_persistence'"),
      ),
    ).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects stale before-state fingerprints without mutating', async () => {
    const db = applyingDb(crawlBefore, itemBefore);
    await expect(
      applySourceCrawlItemQuarantine(db as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: 'a'.repeat(64),
        itemId: 'item-1',
        now: NOW,
        reason: 'Operator confirmed ambiguity.',
      }),
    ).rejects.toThrow('plan changed');
    const calls = db.query.mock.calls as [string][];
    expect(
      calls.some(([sql]) =>
        String(sql).includes("SET outcome = 'failed_persistence'"),
      ),
    ).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('returns the recorded result for an exact retry without another mutation', async () => {
    const recorded = {
      accounting,
      crawlId: 'crawl-1',
      fingerprint: 'a'.repeat(64),
      itemId: 'item-1',
      quarantinedRows: 1,
      repairId: `repair:${'a'.repeat(64)}`,
    };
    const db = applyingDb(crawlBefore, itemBefore, recorded);
    await expect(
      applySourceCrawlItemQuarantine(db as never, {
        backupSha256: 'b'.repeat(64),
        crawlId: 'crawl-1',
        expectedFingerprint: 'a'.repeat(64),
        itemId: 'item-1',
        now: NOW,
        reason: 'Operator confirmed ambiguity.',
      }),
    ).resolves.toEqual(recorded);
    const calls = db.query.mock.calls as [string][];
    expect(
      calls.some(([sql]) =>
        String(sql).includes("SET outcome = 'failed_persistence'"),
      ),
    ).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

function inspectionDb(
  crawl: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
  options: { startedAtEpochMs?: unknown } = {},
) {
  const startedAtEpochMs = Object.hasOwn(options, 'startedAtEpochMs')
    ? options.startedAtEpochMs
    : epochMilliseconds(crawl?.started_at);
  return {
    query: vi.fn(async (_sql: string) => ({
      rows:
        crawl && item
          ? [{ crawlBefore: crawl, itemBefore: item, startedAtEpochMs }]
          : [],
    })),
  };
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : undefined;
}

function applyingDb(
  crawl: Record<string, unknown>,
  item: Record<string, unknown>,
  previous?: Record<string, unknown>,
) {
  type FakeDb = {
    query: ReturnType<typeof vi.fn>;
    transaction: <T>(
      callback: (transaction: FakeDb) => Promise<T>,
    ) => Promise<T>;
  };
  const db: FakeDb = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM source_crawls WHERE id::text')) {
        return { rowCount: 1, rows: [{ id: crawl.id }] };
      }
      if (
        sql.includes('FROM source_crawl_items') &&
        sql.includes('FOR UPDATE')
      ) {
        return { rowCount: 1, rows: [{ id: item.id }] };
      }
      if (sql.includes('FROM data_repair_runs')) {
        return { rows: previous ? [{ summary: previous }] : [] };
      }
      if (sql.includes('to_jsonb(crawl)')) {
        return {
          rows: [
            {
              crawlBefore: crawl,
              itemBefore: item,
              startedAtEpochMs: epochMilliseconds(crawl.started_at),
            },
          ],
        };
      }
      if (sql.includes("SET outcome = 'failed_persistence'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
    transaction: async <T>(callback: (transaction: typeof db) => Promise<T>) =>
      await callback(db),
  };
  return db;
}
