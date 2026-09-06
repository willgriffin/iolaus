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

const schedulesMock = vi.hoisted(() => ({
  deleted: [] as Array<{ delete: () => Promise<void> }>,
  get: vi.fn(),
  getOrUpsert: vi.fn(),
  list: vi.fn(),
}));

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@happyvertical/smrt-agents', () => ({
  AgentScheduleCollection: {
    create: vi.fn(async () => schedulesMock),
  },
}));

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

beforeEach(() => {
  smrtMock.listCalls.length = 0;
  smrtMock.sources.length = 0;
  schedulesMock.deleted.length = 0;
  databaseMock.query.mockReset();
  databaseMock.query.mockResolvedValue({ rows: [] });
  schedulesMock.get.mockReset();
  schedulesMock.getOrUpsert.mockReset();
  schedulesMock.list.mockReset();
  schedulesMock.get.mockResolvedValue(null);
  schedulesMock.getOrUpsert.mockResolvedValue({});
  schedulesMock.list.mockResolvedValue([]);
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
  it('uses the framework AgentSchedule collection instead of creating a table', async () => {
    await ensureSourceScheduleTable({} as never);

    expect(schedulesMock.getOrUpsert).not.toHaveBeenCalled();
  });

  it('upserts one active schedule by the framework-backfilled legacy slug', async () => {
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
      db: databaseMock as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    expect(schedulesMock.getOrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'source-1',
        agentType: SOURCE_JOB_OBJECT_TYPE,
        context: '',
        method: SOURCE_CRAWL_METHOD,
        slug: 'source-crawl-source-1',
        timezone: 'UTC',
      }),
    );
    expect(source.nextCheckAt).toBeInstanceOf(Date);
    expect(source.save).toHaveBeenCalledOnce();
  });

  it('is idempotent for repeated syncs of the same source', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      refreshCadence: 'weekly',
      sourceRole: 'root',
    };

    await syncSourceSchedule(source, {
      db: databaseMock as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    await syncSourceSchedule(source, {
      db: databaseMock as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    expect(schedulesMock.getOrUpsert).toHaveBeenCalledTimes(2);
    expect(schedulesMock.getOrUpsert.mock.calls[0]?.[0].slug).toBe(
      'source-crawl-source-1',
    );
    expect(schedulesMock.getOrUpsert.mock.calls[1]?.[0].slug).toBe(
      'source-crawl-source-1',
    );
  });

  it('refuses an unbackfilled legacy schedule before writing a duplicate', async () => {
    const sourceId = '11111111-1111-1111-1111-111111111111';
    databaseMock.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    schedulesMock.list.mockRejectedValue(
      new Error('slug is invalid, null given'),
    );
    const source = {
      id: sourceId,
      isActive: true,
      parentSourceId: null,
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      sourceRole: 'root',
    };

    await expect(
      syncSourceSchedule(source, { db: databaseMock as never }),
    ).rejects.toThrow(
      'requires SMRT schedule backfill; run smrt db:migrate-agent-schedule-slugs before synchronizing source schedules',
    );

    expect(databaseMock.query).toHaveBeenCalledWith(
      'SELECT 1 FROM _smrt_agent_schedules WHERE id = ? AND slug IS NULL LIMIT 1',
      [`source-crawl:${sourceId}`],
    );
    expect(schedulesMock.getOrUpsert).not.toHaveBeenCalled();
    expect(schedulesMock.list).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('updates the framework-backfilled legacy schedule by slug', async () => {
    const legacySchedule = {
      id: 'legacy-schedule-id',
      runCount: 7,
      successCount: 6,
    };
    schedulesMock.getOrUpsert.mockResolvedValue(legacySchedule);

    await syncSourceSchedule(
      {
        id: '11111111-1111-1111-1111-111111111111',
        isActive: true,
        parentSourceId: null,
        refreshCadence: 'daily',
        sourceRole: 'root',
      },
      { db: databaseMock as never, saveSource: false },
    );

    expect(schedulesMock.getOrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        context: '',
        slug: 'source-crawl-11111111-1111-1111-1111-111111111111',
      }),
    );
    expect(legacySchedule).toMatchObject({
      id: 'legacy-schedule-id',
      runCount: 7,
      successCount: 6,
    });
  });

  it('disables the schedule and clears nextCheckAt when inactive', async () => {
    const source = {
      id: 'source-1',
      isActive: false,
      nextCheckAt: new Date(),
      refreshCadence: 'daily',
    };

    await syncSourceSchedule(source, { db: databaseMock as never });

    expect(schedulesMock.getOrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: '* * * * *',
        enabled: false,
        status: 'disabled',
      }),
    );
    expect(source.nextCheckAt).toBeNull();
  });
});

describe('syncAllSourceSchedules', () => {
  it('syncs existing sources and deletes orphan schedule rows', async () => {
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
      db: databaseMock as never,
      now: new Date('2026-06-04T00:00:00.000Z'),
      saveSource: false,
    });

    expect(summary).toEqual({ disabled: 1, enabled: 1, total: 2 });
    expect(smrtMock.listCalls).toEqual([{ limit: 500, offset: 0 }]);
    expect(schedulesMock.list).toHaveBeenCalledWith({
      where: { agentType: SOURCE_JOB_OBJECT_TYPE, method: SOURCE_CRAWL_METHOD },
    });
  });

  it('deletes only orphaned source-crawl schedules through the collection', async () => {
    const staleSchedule = {
      agentId: 'source-gone',
      delete: vi.fn(async () => {}),
    };
    schedulesMock.list.mockResolvedValue([staleSchedule]);
    smrtMock.sources.push({
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      refreshCadence: 'daily',
      sourceRole: 'root',
    });

    await syncAllSourceSchedules({
      db: databaseMock as never,
      saveSource: false,
    });

    expect(staleSchedule.delete).toHaveBeenCalledOnce();
  });
});

describe('deleteSourceSchedule', () => {
  it('removes the recurring schedule for a deleted source', async () => {
    const schedule = {
      agentType: SOURCE_JOB_OBJECT_TYPE,
      delete: vi.fn(async () => {}),
      method: SOURCE_CRAWL_METHOD,
    };
    schedulesMock.get.mockResolvedValue(schedule);

    await deleteSourceSchedule(' source-1 ', { db: databaseMock as never });

    expect(schedulesMock.get).toHaveBeenCalledWith({
      context: '',
      slug: 'source-crawl-source-1',
    });
    expect(schedule.delete).toHaveBeenCalledOnce();
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
