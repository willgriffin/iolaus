import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSourceSchedule,
  cronForSourceCadence,
  deleteSourceSchedule,
  enqueueSourceCrawl,
  ensureSourceScheduleTable,
  isSourceCrawlEnqueueError,
  nextRunForCron,
  normalizeRefreshCadence,
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_JOB_OBJECT_TYPE,
  syncAllSourceSchedules,
  syncSourceSchedule,
} from './source-schedules';

const smrtMock = vi.hoisted(() => ({
  listCalls: [] as Array<{ limit: number; offset?: number }>,
  sources: [] as Array<Record<string, unknown>>,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    if (className !== 'Source')
      throw new Error(`Unexpected collection: ${className}`);
    return {
      get: vi.fn(
        async (id: string) =>
          smrtMock.sources.find((source) => source.id === id) ?? null,
      ),
      list: vi.fn(async (options: { limit: number; offset?: number }) => {
        smrtMock.listCalls.push(options);
        const offset = options.offset ?? 0;
        return smrtMock.sources.slice(offset, offset + options.limit);
      }),
    };
  }),
}));

function captureDb() {
  const queries: Array<{ params: unknown[]; sql: string }> = [];
  return {
    db: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ params, sql });
        return [];
      }),
    },
    queries,
  };
}

beforeEach(() => {
  smrtMock.listCalls.length = 0;
  smrtMock.sources.length = 0;
});

describe('source schedule cadence mapping', () => {
  it('normalizes blank and invalid cadences to ad_hoc', () => {
    expect(normalizeRefreshCadence('daily')).toBe('daily');
    expect(normalizeRefreshCadence(' weekly ')).toBe('weekly');
    expect(normalizeRefreshCadence('')).toBe('ad_hoc');
    expect(normalizeRefreshCadence('hourly')).toBe('ad_hoc');
  });

  it('maps active cadences to deterministic UTC cron expressions', () => {
    const source = { id: 'source-1', name: 'Source 1' };

    expect(cronForSourceCadence('daily', source)).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(cronForSourceCadence('weekly', source)).toMatch(
      /^\d+ \d+ \* \* \d+$/,
    );
    expect(cronForSourceCadence('monthly', source)).toMatch(
      /^\d+ \d+ \d+ \* \*$/,
    );
    expect(cronForSourceCadence('ad_hoc', source)).toBeNull();
    expect(cronForSourceCadence('unknown', source)).toBeNull();
  });

  it('computes next runs from generated cron expressions', () => {
    expect(
      nextRunForCron('0 0 * * *', new Date('2026-06-04T00:00:00.000Z')),
    ).toEqual(new Date('2026-06-05T00:00:00.000Z'));
    expect(
      nextRunForCron('30 12 * * 5', new Date('2026-06-04T13:00:00.000Z')),
    ).toEqual(new Date('2026-06-05T12:30:00.000Z'));
    expect(
      nextRunForCron('15 8 1 * *', new Date('2026-06-04T13:00:00.000Z')),
    ).toEqual(new Date('2026-07-01T08:15:00.000Z'));
  });

  it('disables schedules for inactive or ad hoc sources', () => {
    const now = new Date('2026-06-04T00:00:00.000Z');

    expect(
      buildSourceSchedule(
        { id: 'source-1', isActive: false, refreshCadence: 'daily' },
        now,
      ),
    ).toMatchObject({
      enabled: false,
      nextRun: null,
      status: 'inactive',
    });
    expect(
      buildSourceSchedule({ id: 'source-1', refreshCadence: 'ad_hoc' }, now),
    ).toMatchObject({
      enabled: false,
      nextRun: null,
      status: 'inactive',
    });
    for (const isActive of [null, undefined]) {
      expect(
        buildSourceSchedule(
          {
            id: 'legacy-root',
            isActive,
            parentSourceId: null,
            refreshCadence: 'daily',
            sourceRole: 'root',
          },
          now,
        ),
      ).toMatchObject({
        enabled: false,
        nextRun: null,
        status: 'inactive',
      });
    }
  });
});

describe('syncSourceSchedule', () => {
  it('creates timezone-aware schedule timestamps for fresh databases', async () => {
    const { db, queries } = captureDb();

    await ensureSourceScheduleTable(db as never);

    const createTable = queries[0]?.sql;
    expect(createTable).toMatch(/next_run\s+TIMESTAMPTZ/u);
    expect(createTable).toMatch(/last_run\s+TIMESTAMPTZ/u);
    expect(createTable).toMatch(/created_at\s+TIMESTAMPTZ/u);
    expect(createTable).toMatch(/updated_at\s+TIMESTAMPTZ/u);
    expect(createTable).not.toMatch(
      /(?:next_run|last_run|created_at|updated_at)\s+TIMESTAMP(?:\s|,)/u,
    );
  });

  it('upserts one active schedule row and updates nextCheckAt', async () => {
    const { db, queries } = captureDb();
    const source = {
      id: 'source-1',
      isActive: true,
      name: 'Greenhouse',
      nextCheckAt: null as Date | null,
      parentSourceId: null,
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      sourceRole: 'root',
    };

    await syncSourceSchedule(source, {
      db: db as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    const upsert = queries.at(-1);
    expect(upsert?.sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(upsert?.params[0]).toBe('source-crawl:source-1');
    expect(upsert?.params[1]).toBe(SOURCE_JOB_OBJECT_TYPE);
    expect(upsert?.params[2]).toBe('source-1');
    expect(upsert?.params[4]).toBe(SOURCE_CRAWL_METHOD);
    expect(upsert?.params[5]).toBe(
      JSON.stringify({ includeGeneric: true, reason: 'scheduled' }),
    );
    expect(source.nextCheckAt).toBeInstanceOf(Date);
    expect(source.save).toHaveBeenCalledOnce();
  });

  it('is idempotent for repeated syncs of the same source', async () => {
    const { db, queries } = captureDb();
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      refreshCadence: 'weekly',
      sourceRole: 'root',
    };

    await syncSourceSchedule(source, {
      db: db as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    await syncSourceSchedule(source, {
      db: db as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    const upserts = queries.filter((query) =>
      query.sql.includes('ON CONFLICT (id) DO UPDATE'),
    );
    expect(upserts).toHaveLength(2);
    expect(upserts[0].params[0]).toBe('source-crawl:source-1');
    expect(upserts[1].params[0]).toBe('source-crawl:source-1');
  });

  it('disables the schedule and clears nextCheckAt when inactive', async () => {
    const { db, queries } = captureDb();
    const source = {
      id: 'source-1',
      isActive: false,
      nextCheckAt: new Date(),
      refreshCadence: 'daily',
    };

    await syncSourceSchedule(source, { db: db as never });

    const upsert = queries.at(-1);
    expect(upsert?.sql).toContain("status = 'inactive'");
    expect(upsert?.params[3]).toBe('* * * * *');
    expect(source.nextCheckAt).toBeNull();
  });
});

describe('syncAllSourceSchedules', () => {
  it('syncs existing sources and deletes orphan schedule rows', async () => {
    const { db, queries } = captureDb();
    smrtMock.sources.push(
      {
        id: 'source-1',
        isActive: true,
        name: 'Greenhouse',
        parentSourceId: null,
        refreshCadence: 'daily',
        sourceRole: 'root',
      },
      {
        id: 'source-2',
        isActive: false,
        name: 'Ashby',
        refreshCadence: 'weekly',
      },
    );

    const summary = await syncAllSourceSchedules({
      db: db as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
      saveSource: false,
    });

    expect(summary).toEqual({ disabled: 1, enabled: 1, total: 2 });
    expect(smrtMock.listCalls).toEqual([{ limit: 500, offset: 0 }]);
    const deleteQuery = queries.at(-1);
    expect(deleteQuery?.sql).toContain('agent_id NOT IN (?, ?)');
    expect(deleteQuery?.params).toEqual([
      SOURCE_JOB_OBJECT_TYPE,
      SOURCE_CRAWL_METHOD,
      'source-1',
      'source-2',
    ]);
  });
});

describe('deleteSourceSchedule', () => {
  it('removes the recurring schedule for a deleted source', async () => {
    const { db, queries } = captureDb();

    await deleteSourceSchedule(' source-1 ', { db: db as never });

    const deleteQuery = queries.find((query) =>
      query.sql.includes('DELETE FROM _smrt_agent_schedules'),
    );
    expect(deleteQuery?.params).toEqual([
      'source-crawl:source-1',
      SOURCE_JOB_OBJECT_TYPE,
      SOURCE_CRAWL_METHOD,
    ]);
  });
});

describe('enqueueSourceCrawl', () => {
  it('classifies bounded expected manual refusal errors', () => {
    expect(
      isSourceCrawlEnqueueError(
        new Error('Source is not explicitly active. Enable it.'),
      ),
    ).toBe(true);
    expect(
      isSourceCrawlEnqueueError(
        new Error('Source is not an explicitly classified root source.'),
      ),
    ).toBe(true);
    expect(isSourceCrawlEnqueueError(new Error('database offline'))).toBe(
      false,
    );
  });
  it('creates one pending manual crawl job on source-crawls', async () => {
    const job = {
      id: 'job-1',
      save: vi.fn(async () => job),
    };
    const collection = {
      create: vi.fn(async (payload: Record<string, unknown>) =>
        Object.assign(job, payload),
      ),
    };
    const sourceCollection = {
      get: vi.fn(async () => ({
        id: 'source-1',
        isActive: true,
        parentSourceId: null,
        sourceRole: 'root',
      })),
    };

    await enqueueSourceCrawl(
      'source-1',
      { reason: 'manual' },
      {
        collection: collection as never,
        sourceCollection,
      },
    );

    expect(sourceCollection.get).toHaveBeenCalledWith('source-1');
    expect(collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { includeGeneric: true, reason: 'manual' },
        maxAttempts: 1,
        method: SOURCE_CRAWL_METHOD,
        objectId: 'source-1',
        objectType: SOURCE_JOB_OBJECT_TYPE,
        priority: 75,
        queue: SOURCE_CRAWL_QUEUE,
      }),
    );
    expect(job.save).toHaveBeenCalledOnce();
  });

  it('does not enqueue a manual crawl for a missing source', async () => {
    const collection = {
      create: vi.fn(),
    };
    const sourceCollection = {
      get: vi.fn(async () => null),
    };

    await expect(
      enqueueSourceCrawl(
        'source-missing',
        {},
        {
          collection: collection as never,
          sourceCollection,
        },
      ),
    ).rejects.toThrow('Source not found.');

    expect(collection.create).not.toHaveBeenCalled();
  });

  it.each([
    false,
    null,
    undefined,
  ])('does not enqueue a manual crawl when activation is %s', async (isActive) => {
    const collection = { create: vi.fn() };
    const sourceCollection = {
      get: vi.fn(async () => ({
        id: 'source-1',
        isActive,
        parentSourceId: null,
        sourceRole: 'root',
      })),
    };

    await expect(
      enqueueSourceCrawl(
        'source-1',
        { reason: 'manual' },
        {
          collection: collection as never,
          sourceCollection,
        },
      ),
    ).rejects.toThrow('not explicitly active');
    expect(collection.create).not.toHaveBeenCalled();
  });
});
