import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceCrawlOwnershipError } from './opportunity-source-crawler';
import { runSourceCrawlJob } from './source-crawl-job';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-core')>();
  return {
    ...actual,
    resolveDatabase: vi.fn(async () => ({ query: mocks.query })),
  };
});

vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => ({})),
}));

const summary = {
  candidates: 3,
  created: 1,
  duplicates: 1,
  errors: [],
  failedPersistence: 0,
  intelligenceDuplicateSuppressed: 0,
  intelligenceEnqueued: 1,
  intelligenceSkipped: 0,
  relisted: 0,
  reused: 0,
  skipped: 1,
  sourceId: 'source-1',
  sourceName: 'Greenhouse',
};

describe('runSourceCrawlJob', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it.each([
    false,
    null,
    undefined,
  ])('refuses queued work when source activation is %s', async (isActive) => {
    const source = {
      id: 'source-1',
      isActive,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);

    await expect(
      runSourceCrawlJob(source, { reason: 'scheduled' }, undefined, {
        crawlSource,
        syncSchedule,
      }),
    ).rejects.toThrow('not explicitly active');

    expect(crawlSource).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('refuses a malformed active non-root before any runner mutation', async () => {
    const source = {
      id: 'source-child',
      isActive: true,
      lastCheckedAt: null,
      name: 'Derived posting',
      parentSourceId: 'source-root',
      save: vi.fn(async () => {}),
      sourceRole: 'posting',
      url: 'https://example.com/jobs/1',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);
    const logger = { error: vi.fn(), info: vi.fn() };

    await expect(
      runSourceCrawlJob(source, { reason: 'scheduled' }, { logger } as never, {
        crawlSource,
        syncSchedule,
      }),
    ).rejects.toThrow('not an explicitly classified root source');

    expect(source.lastCheckedAt).toBeNull();
    expect(crawlSource).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('refuses a valid inactive child before queued-crawl terminalization', async () => {
    const source = {
      id: 'source-child',
      isActive: false,
      lastCheckedAt: null,
      parentSourceId: 'source-root',
      save: vi.fn(async () => {}),
      sourceRole: 'posting',
    };
    const failRequestedCrawl = vi.fn(async () => true);
    const syncSchedule = vi.fn(async () => null);

    await expect(
      runSourceCrawlJob(
        source,
        { sourceCrawlId: 'crawl-child' },
        { job: { jobId: 'job-child' } } as never,
        { failRequestedCrawl, syncSchedule },
      ),
    ).rejects.toThrow('not an explicitly classified root source');

    expect(source.lastCheckedAt).toBeNull();
    expect(failRequestedCrawl).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('terminalizes a requested crawl when the source is deactivated before execution', async () => {
    const source = {
      id: 'source-1',
      isActive: false,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);
    const failRequestedCrawl = vi.fn(async () => true);

    await expect(
      runSourceCrawlJob(
        source,
        { reason: 'manual', sourceCrawlId: 'crawl-1' },
        { job: { jobId: 'job-1' } } as never,
        { crawlSource, failRequestedCrawl, syncSchedule },
      ),
    ).rejects.toThrow('not explicitly active');

    expect(failRequestedCrawl).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message:
          'Source crawl refused because the source is not explicitly active.',
      }),
      jobId: 'job-1',
      sourceCrawlId: 'crawl-1',
      sourceId: 'source-1',
    });
    expect(crawlSource).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '',
    '   ',
  ])('does not terminalize a requested crawl without exact job binding %j', async (jobId) => {
    const source = {
      id: 'source-1',
      isActive: false,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);
    const failRequestedCrawl = vi.fn(async () => true);

    await expect(
      runSourceCrawlJob(
        source,
        { reason: 'manual', sourceCrawlId: 'crawl-1' },
        jobId === undefined ? undefined : ({ job: { jobId } } as never),
        { crawlSource, failRequestedCrawl, syncSchedule },
      ),
    ).rejects.toThrow('without an exact worker job binding');

    expect(failRequestedCrawl).not.toHaveBeenCalled();
    expect(crawlSource).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('fails closed when the crawl, source, and job binding does not match queued state', async () => {
    const source = {
      id: 'source-1',
      isActive: false,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);
    const failRequestedCrawl = vi.fn(async () => false);

    await expect(
      runSourceCrawlJob(
        source,
        { reason: 'manual', sourceCrawlId: 'crawl-mismatch' },
        { job: { jobId: 'job-mismatch' } } as never,
        { crawlSource, failRequestedCrawl, syncSchedule },
      ),
    ).rejects.toThrow('could not terminalize the exact queued crawl');

    expect(failRequestedCrawl).toHaveBeenCalledWith({
      error: expect.any(Error),
      jobId: 'job-mismatch',
      sourceCrawlId: 'crawl-mismatch',
      sourceId: 'source-1',
    });
    expect(crawlSource).not.toHaveBeenCalled();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('uses exact crawl, source, and worker job binding in the durable terminalization query', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'crawl-1' }] });
    const source = {
      id: 'source-1',
      isActive: false,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      url: 'https://boards.greenhouse.io/example',
    };

    await expect(
      runSourceCrawlJob(
        source,
        { reason: 'manual', sourceCrawlId: 'crawl-1' },
        { job: { jobId: 'job-1' } } as never,
      ),
    ).rejects.toThrow('not explicitly active');

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('WHERE id = ?');
    expect(sql).toContain('AND source_id = ?');
    expect(sql).toContain("AND status = 'queued'");
    expect(sql).toContain('AND finished_at IS NULL');
    expect(sql).toContain('AND job_id = ?');
    expect(sql).not.toContain("? = ''");
    expect(params).toEqual([
      'Source crawl refused because the source is not explicitly active.',
      'crawl-1',
      'source-1',
      'job-1',
    ]);
  });

  it('keeps mismatched and repeated durable terminalization attempts fail closed', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'crawl-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const source = {
      id: 'source-1',
      isActive: false,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      url: 'https://boards.greenhouse.io/example',
    };
    const execute = (sourceCrawlId: string, jobId: string) =>
      runSourceCrawlJob(source, { reason: 'manual', sourceCrawlId }, {
        job: { jobId },
      } as never);

    await expect(execute('crawl-mismatch', 'job-mismatch')).rejects.toThrow(
      'could not terminalize the exact queued crawl',
    );
    await expect(execute('crawl-1', 'job-1')).rejects.toThrow(
      'not explicitly active',
    );
    await expect(execute('crawl-1', 'job-1')).rejects.toThrow(
      'could not terminalize the exact queued crawl',
    );

    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'Source crawl refused because the source is not explicitly active.',
      'crawl-mismatch',
      'source-1',
      'job-mismatch',
    ]);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual(
      mocks.query.mock.calls[1]?.[1],
    );
  });

  it('runs the crawler, updates lastCheckedAt, syncs schedule, and saves the source', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      lastCheckedAt: null,
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);

    await expect(
      runSourceCrawlJob(source, { reason: 'manual' }, undefined, {
        crawlSource,
        syncSchedule,
      }),
    ).resolves.toEqual(summary);

    expect(crawlSource).toHaveBeenCalledWith(source, {
      includeGeneric: true,
      limit: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(source.lastCheckedAt).toBeInstanceOf(Date);
    expect(syncSchedule).toHaveBeenCalledWith(source, { saveSource: false });
    expect(source.save).toHaveBeenCalledOnce();
  });

  it('updates source state and rethrows failed crawls', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      lastCheckedAt: null,
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const error = new Error('crawler failed');
    const crawlSource = vi.fn(async () => {
      throw error;
    });
    const syncSchedule = vi.fn(async () => null);

    await expect(
      runSourceCrawlJob(source, { reason: 'scheduled' }, undefined, {
        crawlSource,
        syncSchedule,
      }),
    ).rejects.toThrow('crawler failed');

    expect(source.lastCheckedAt).toBeInstanceOf(Date);
    expect(syncSchedule).toHaveBeenCalledWith(source, { saveSource: false });
    expect(source.save).toHaveBeenCalledOnce();
  });

  it('reports watchdog-owned terminal state as failure rather than success', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      lastCheckedAt: null,
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const error = new Error(
      'Source crawl crawl-1 completion is owned by terminal state timed_out.',
    );
    const logger = { error: vi.fn(), info: vi.fn() };

    await expect(
      runSourceCrawlJob(
        source,
        { reason: 'scheduled' },
        { job: {} as never, logger } as never,
        {
          crawlSource: vi.fn(async () => {
            throw error;
          }),
          syncSchedule: vi.fn(async () => null),
        },
      ),
    ).rejects.toThrow('terminal state timed_out');
    expect(logger.error).toHaveBeenCalledWith('Source crawl failed.', {
      error: error.message,
      sourceId: 'source-1',
    });
    expect(logger.info).not.toHaveBeenCalledWith(
      'Source crawl completed.',
      expect.anything(),
    );
  });

  it('honors an explicit generic-crawling opt-out', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      lastCheckedAt: null,
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);
    const syncSchedule = vi.fn(async () => null);

    await runSourceCrawlJob(
      source,
      { includeGeneric: false, reason: 'manual' },
      undefined,
      {
        crawlSource,
        syncSchedule,
      },
    );

    expect(crawlSource).toHaveBeenCalledWith(source, {
      includeGeneric: false,
      limit: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it('correlates a worker execution with the source crawl it creates', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const crawlSource = vi.fn(async () => summary);

    await runSourceCrawlJob(
      source,
      {},
      {
        job: {
          attempt: 1,
          jobId: 'job-1',
          method: 'crawl',
          objectType: '@willgriffin/iolaus-site:Source',
          queue: 'source-crawls',
        },
      } as never,
      { crawlSource, syncSchedule: vi.fn(async () => null) },
    );

    expect(crawlSource).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ jobAttempt: 1, jobId: 'job-1' }),
    );
  });

  it('does not complete or mutate source state after an ownership fence refusal', async () => {
    const source = {
      id: 'source-1',
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      lastCheckedAt: null,
      name: 'Greenhouse',
      refreshCadence: 'daily',
      save: vi.fn(async () => {}),
      url: 'https://boards.greenhouse.io/example',
    };
    const ownershipError = new SourceCrawlOwnershipError(
      'Source crawl crawl-1 is owned by another active attempt.',
    );
    const crawlSource = vi.fn(async () => {
      throw ownershipError;
    });
    const syncSchedule = vi.fn(async () => null);
    const logger = { error: vi.fn(), info: vi.fn() };

    await expect(
      runSourceCrawlJob(
        source,
        { sourceCrawlId: 'crawl-1' },
        {
          job: {
            attempt: 2,
            jobId: 'job-1',
            method: 'crawl',
            objectType: '@willgriffin/iolaus-site:Source',
            queue: 'source-crawls',
          },
          logger,
        } as never,
        { crawlSource, syncSchedule },
      ),
    ).rejects.toBe(ownershipError);

    expect(source.lastCheckedAt).toBeNull();
    expect(syncSchedule).not.toHaveBeenCalled();
    expect(source.save).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      'Source crawl completed.',
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Source crawl ownership refused.',
      expect.objectContaining({ sourceId: 'source-1' }),
    );
  });
});
