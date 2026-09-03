import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_ABSENCE_ARCHIVE_REASON,
  BOARD_ABSENCE_ARCHIVE_THRESHOLD,
  type ReconciliationDatabase,
  reconcileSourceBoard,
  refreshSeenOpportunities,
} from './opportunity-board-reconciliation';

const getCollection = vi.hoisted(() => vi.fn());
const recordAgentAudit = vi.hoisted(() => vi.fn(async () => ({})));
const closeReviewTasksForArchivedOpportunities = vi.hoisted(() =>
  vi.fn(async () => 0),
);
const bumpOpportunityChangeFeed = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed,
}));

vi.mock('./smrt.js', () => ({ getCollection }));
vi.mock('./application-workflow.js', () => ({
  closeReviewTasksForArchivedOpportunities,
  recordAgentAudit,
}));

const RECONCILABLE = ['found', 'recommended'];

interface Row extends Record<string, unknown> {
  archiveReason?: string;
  freshness: string;
  humanReviewStatus?: string;
  id: string;
  lastMissedAt: Date | null;
  lastSeenAt: Date | null;
  missedCrawls: number;
  sourceId: string;
  status: string;
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    freshness: 'fresh',
    lastMissedAt: null,
    lastSeenAt: null,
    missedCrawls: 0,
    sourceId: 'source-1',
    status: 'found',
    ...overrides,
  };
}

/**
 * Interprets the two reconciliation statements against in-memory rows so the
 * specs exercise the real SQL parameter contract rather than a canned result.
 */
function fakeDatabase(rows: Row[]): ReconciliationDatabase & {
  rows: Row[];
  statements: string[];
} {
  const statements: string[] = [];
  const database: ReconciliationDatabase & {
    rows: Row[];
    statements: string[];
  } = {
    rows,
    statements,
    /**
     * Snapshot/restore stands in for a real rollback so the atomicity specs
     * can assert that a failure leaves no mutation behind (issue #433).
     */
    transaction: vi.fn(async (run) => {
      const before = rows.map((record) => ({ ...record }));
      try {
        return await run(database);
      } catch (failure) {
        rows.forEach((record, index) => {
          for (const key of Object.keys(record)) delete record[key];
          Object.assign(record, before[index]);
        });
        throw failure;
      }
    }),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (sql.includes("status = 'archived'")) {
        const now = params[0] as Date;
        const reason = params[params.length - 1] as string;
        const ids = params.slice(1, -1) as string[];
        const matched = rows.filter(
          (record) =>
            ids.includes(record.id) &&
            record.status === 'archived' &&
            record.archiveReason === reason,
        );
        for (const record of matched) {
          record.archiveReason = '';
          record.freshness = 'fresh';
          record.humanReviewStatus = 'needs_input';
          record.lastMissedAt = null;
          record.lastSeenAt = now;
          record.missedCrawls = 0;
          record.status = 'found';
        }
        return { rows: matched.map((record) => ({ id: record.id })) };
      }
      if (sql.includes("freshness = 'fresh'")) {
        const now = params[0] as Date;
        const statuses = params.slice(-RECONCILABLE.length) as string[];
        const ids = params.slice(1, -RECONCILABLE.length) as string[];
        const matched = rows.filter(
          (record) =>
            ids.includes(record.id) && statuses.includes(record.status),
        );
        for (const record of matched) {
          record.freshness = 'fresh';
          record.lastSeenAt = now;
          record.lastMissedAt = null;
          record.missedCrawls = 0;
        }
        return { rows: matched.map((record) => ({ id: record.id })) };
      }
      const now = params[0] as Date;
      const sourceId = params[1] as string;
      const statuses = params.slice(2, 2 + RECONCILABLE.length) as string[];
      const seen = params.slice(2 + RECONCILABLE.length) as string[];
      const absent = rows.filter(
        (record) =>
          record.sourceId === sourceId &&
          statuses.includes(record.status) &&
          !seen.includes(record.id),
      );
      for (const record of absent) {
        record.freshness = 'stale';
        record.lastMissedAt = now;
        record.missedCrawls += 1;
      }
      return {
        rows: absent.map((record) => ({
          id: record.id,
          missedCrawls: record.missedCrawls,
        })),
      };
    }),
  };
  return database;
}

function opportunityCollection(rows: Row[]) {
  return {
    get: vi.fn(async (id: string) => {
      const record = rows.find((candidate) => candidate.id === id);
      if (!record) return null;
      return Object.assign(record, { save: vi.fn(async () => {}) });
    }),
  };
}

beforeEach(() => {
  getCollection.mockReset();
  recordAgentAudit.mockReset();
  recordAgentAudit.mockResolvedValue({});
  closeReviewTasksForArchivedOpportunities.mockReset();
  closeReviewTasksForArchivedOpportunities.mockResolvedValue(0);
  bumpOpportunityChangeFeed.mockReset();
  bumpOpportunityChangeFeed.mockResolvedValue(0);
});

describe('refreshSeenOpportunities', () => {
  it('re-stamps lastSeenAt and freshness for every matched posting', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const rows = [
      row({ freshness: 'stale', id: 'opp-1', missedCrawls: 2 }),
      row({ id: 'opp-2' }),
    ];
    const database = fakeDatabase(rows);

    const refreshed = await refreshSeenOpportunities({
      database,
      now,
      opportunityIds: ['opp-1', 'opp-2', 'opp-1', ' '],
    });

    expect(refreshed).toBe(2);
    expect(rows[0]).toMatchObject({
      freshness: 'fresh',
      lastMissedAt: null,
      lastSeenAt: now,
      missedCrawls: 0,
    });
  });

  it('revives a posting this reconciler archived once the board lists it again', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const rows = [
      row({
        archiveReason: BOARD_ABSENCE_ARCHIVE_REASON,
        freshness: 'stale',
        humanReviewStatus: 'archived',
        id: 'opp-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD,
        status: 'archived',
      }),
    ];
    const database = fakeDatabase(rows);

    const refreshed = await refreshSeenOpportunities({
      database,
      now,
      opportunityIds: ['opp-1'],
    });

    expect(refreshed).toBe(1);
    expect(rows[0]).toMatchObject({
      archiveReason: '',
      freshness: 'fresh',
      humanReviewStatus: 'needs_input',
      lastMissedAt: null,
      lastSeenAt: now,
      missedCrawls: 0,
      status: 'found',
    });
  });

  it('never revives a posting the owner archived', async () => {
    const rows = [
      row({
        archiveReason: '',
        freshness: 'stale',
        humanReviewStatus: 'archived',
        id: 'opp-1',
        status: 'archived',
      }),
    ];
    const database = fakeDatabase(rows);

    const refreshed = await refreshSeenOpportunities({
      database,
      now: new Date('2026-09-02T00:00:00.000Z'),
      opportunityIds: ['opp-1'],
    });

    expect(refreshed).toBe(0);
    expect(rows[0]).toMatchObject({
      humanReviewStatus: 'archived',
      status: 'archived',
    });
  });

  it('never touches a posting outside the reconcilable statuses', async () => {
    const rows = [row({ id: 'opp-1', status: 'applied' })];
    const database = fakeDatabase(rows);

    const refreshed = await refreshSeenOpportunities({
      database,
      now: new Date('2026-09-02T00:00:00.000Z'),
      opportunityIds: ['opp-1'],
    });

    expect(refreshed).toBe(0);
    expect(rows[0].lastSeenAt).toBeNull();
  });

  it('bumps the change feed for every row it re-stamped', async () => {
    const rows = [row({ id: 'opp-1' }), row({ id: 'opp-2' })];

    await refreshSeenOpportunities({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      opportunityIds: ['opp-1', 'opp-2'],
    });

    expect(bumpOpportunityChangeFeed).toHaveBeenCalledWith(expect.anything(), [
      'opp-1',
      'opp-2',
    ]);
  });

  it('issues no statement when the crawl matched nothing', async () => {
    const database = fakeDatabase([]);
    const refreshed = await refreshSeenOpportunities({
      database,
      now: new Date(),
      opportunityIds: [],
    });
    expect(refreshed).toBe(0);
    expect(database.statements).toEqual([]);
  });
});

describe('reconcileSourceBoard', () => {
  it('marks board-absent postings stale and increments the miss counter', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const rows = [row({ id: 'seen-1' }), row({ id: 'absent-1' })];
    getCollection.mockResolvedValue(opportunityCollection(rows));

    const counts = await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now,
      recordAudit: false,
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(counts).toEqual({ archived: 0, missed: 1, refreshed: 1, seen: 1 });
    expect(rows[1]).toMatchObject({
      freshness: 'stale',
      lastMissedAt: now,
      missedCrawls: 1,
      status: 'found',
    });
  });

  it('archives a posting with reason not_listed on the third consecutive miss', async () => {
    const rows = [
      row({
        freshness: 'stale',
        id: 'absent-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      }),
    ];
    getCollection.mockResolvedValue(opportunityCollection(rows));

    const counts = await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      recordAudit: false,
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(counts).toMatchObject({ archived: 1, missed: 1 });
    expect(rows[0]).toMatchObject({
      archiveReason: 'not_listed',
      freshness: 'stale',
      humanReviewStatus: 'archived',
      missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD,
      status: 'archived',
    });
  });

  it('resets the miss counter when the board lists the posting again', async () => {
    const rows = [
      row({
        freshness: 'stale',
        id: 'opp-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      }),
    ];
    getCollection.mockResolvedValue(opportunityCollection(rows));

    const counts = await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      recordAudit: false,
      seenOpportunityIds: ['opp-1'],
      sourceId: 'source-1',
    });

    expect(counts).toEqual({ archived: 0, missed: 0, refreshed: 1, seen: 1 });
    expect(rows[0]).toMatchObject({ freshness: 'fresh', missedCrawls: 0 });
  });

  it('records the seen, refreshed, missed, and archived counts as an audit', async () => {
    const rows = [row({ id: 'seen-1' }), row({ id: 'absent-1' })];
    getCollection.mockResolvedValue(opportunityCollection(rows));

    await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      seenOpportunityIds: ['seen-1'],
      sourceCrawlId: 'crawl-1',
      sourceId: 'source-1',
    });

    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sourceCrawlId: 'crawl-1',
          sourceId: 'source-1',
        }),
        output: expect.objectContaining({
          archived: 0,
          missed: 1,
          refreshed: 1,
          seen: 1,
        }),
        runType: 'source_board_reconciliation',
        sourceId: 'source-1',
        status: 'completed',
      }),
    );
  });

  it('re-stamps but never counts absence when reconcileAbsence is false', async () => {
    const rows = [row({ id: 'seen-1' }), row({ id: 'absent-1' })];
    getCollection.mockResolvedValue(opportunityCollection(rows));
    const database = fakeDatabase(rows);

    const counts = await reconcileSourceBoard({
      database,
      now: new Date('2026-09-02T00:00:00.000Z'),
      reconcileAbsence: false,
      recordAudit: false,
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(counts).toEqual({ archived: 0, missed: 0, refreshed: 1, seen: 1 });
    expect(rows[1]).toMatchObject({
      freshness: 'fresh',
      missedCrawls: 0,
      status: 'found',
    });
  });

  it('still records the audit when a posting cannot be archived', async () => {
    const rows = [
      row({
        freshness: 'stale',
        id: 'absent-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      }),
    ];
    getCollection.mockResolvedValue({
      get: vi.fn(async () => {
        throw new Error('legacy row cannot persist');
      }),
    });

    const counts = await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(counts).toMatchObject({ archived: 0, missed: 1 });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ archiveFailed: 1, archived: 0 }),
        status: 'completed_with_errors',
      }),
    );
  });

  it('closes the open review task of a posting it archives', async () => {
    const rows = [
      row({
        freshness: 'stale',
        id: 'absent-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      }),
      row({ id: 'seen-1' }),
    ];
    getCollection.mockResolvedValue(opportunityCollection(rows));
    closeReviewTasksForArchivedOpportunities.mockResolvedValue(1);

    await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(closeReviewTasksForArchivedOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveReason: BOARD_ABSENCE_ARCHIVE_REASON,
        opportunityIds: ['absent-1'],
      }),
    );
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ archived: 1, reviewTasksClosed: 1 }),
      }),
    );
  });

  it('closes no review task for a posting it only marked stale', async () => {
    const rows = [row({ id: 'absent-1' }), row({ id: 'seen-1' })];
    getCollection.mockResolvedValue(opportunityCollection(rows));

    await reconcileSourceBoard({
      database: fakeDatabase(rows),
      now: new Date('2026-09-02T00:00:00.000Z'),
      recordAudit: false,
      seenOpportunityIds: ['seen-1'],
      sourceId: 'source-1',
    });

    expect(closeReviewTasksForArchivedOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityIds: [] }),
    );
  });

  it('rolls the archive back when the audit write fails', async () => {
    const rows = [
      row({
        freshness: 'stale',
        id: 'absent-1',
        missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      }),
    ];
    getCollection.mockResolvedValue(opportunityCollection(rows));
    // The in-transaction audit fails; the compensating out-of-transaction
    // `failed` audit is allowed to succeed.
    recordAgentAudit.mockRejectedValueOnce(new Error('audit write failed'));

    await expect(
      reconcileSourceBoard({
        database: fakeDatabase(rows),
        now: new Date('2026-09-02T00:00:00.000Z'),
        seenOpportunityIds: ['seen-1'],
        sourceId: 'source-1',
      }),
    ).rejects.toThrow('audit write failed');

    expect(rows[0]).toMatchObject({
      freshness: 'stale',
      missedCrawls: BOARD_ABSENCE_ARCHIVE_THRESHOLD - 1,
      status: 'found',
    });
    expect(rows[0].archiveReason).toBeUndefined();
    expect(recordAgentAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: 'audit write failed',
        output: expect.objectContaining({ archived: 0, rolledBack: true }),
        status: 'failed',
      }),
    );
  });

  it('leaves no completed audit when the absence accounting fails', async () => {
    const rows = [row({ id: 'absent-1' })];
    const database = fakeDatabase(rows);
    getCollection.mockResolvedValue(opportunityCollection(rows));
    const query = database.query as unknown as ReturnType<typeof vi.fn>;
    query.mockImplementationOnce(async () => {
      throw new Error('absence accounting failed');
    });

    await expect(
      reconcileSourceBoard({
        database,
        now: new Date('2026-09-02T00:00:00.000Z'),
        seenOpportunityIds: [],
        sourceId: 'source-1',
      }),
    ).rejects.toThrow('absence accounting failed');

    expect(rows[0]).toMatchObject({ missedCrawls: 0, status: 'found' });
    expect(recordAgentAudit).toHaveBeenCalledTimes(1);
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(recordAgentAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('refuses to reconcile without a transactional database', async () => {
    const rows = [row({ id: 'absent-1' })];
    const { transaction, ...database } = fakeDatabase(rows);
    void transaction;

    await expect(
      reconcileSourceBoard({
        database,
        now: new Date('2026-09-02T00:00:00.000Z'),
        recordAudit: false,
        seenOpportunityIds: [],
        sourceId: 'source-1',
      }),
    ).rejects.toThrow('Transactional reconciliation is required');
    expect(rows[0]).toMatchObject({ missedCrawls: 0, status: 'found' });
  });

  it('does nothing without a source binding', async () => {
    const database = fakeDatabase([]);
    const counts = await reconcileSourceBoard({
      database,
      now: new Date(),
      recordAudit: false,
      seenOpportunityIds: [],
      sourceId: '  ',
    });
    expect(counts).toEqual({ archived: 0, missed: 0, refreshed: 0, seen: 0 });
    expect(database.statements).toEqual([]);
  });
});
