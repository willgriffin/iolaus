import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbConfig = vi.hoisted(() => ({
  type: 'postgres' as 'postgres' | 'sqlite',
}));

vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => ({ type: dbConfig.type, url: ':memory:' })),
}));

import { SOURCE_CRAWL_ACTIVE_JOB_INDEX } from './source-crawl-job-schema';
import {
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules';
import {
  createRootSourceFromWebMcp,
  enqueueRootSourceCrawl,
  listRootSourceHealth,
  listSourceCrawlStatus,
  setRootSourceActive,
} from './source-webmcp';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';

function record(values: Record<string, unknown>) {
  return Object.assign(values, { save: vi.fn(async () => values) });
}

function collection(initial: Array<Record<string, unknown>> = []) {
  const records = initial.map(record);
  return {
    records,
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({ ...payload });
      records.push(created);
      return created;
    }),
    get: vi.fn(
      async (id: string) =>
        records.find((candidate) => candidate.id === id) ?? null,
    ),
    list: vi.fn(async (options: Record<string, unknown> = {}) => {
      const where = (options.where ?? {}) as Record<string, unknown>;
      return records.filter((candidate) =>
        Object.entries(where).every(([key, value]) => {
          const actual = candidate[key];
          return Array.isArray(value)
            ? value.includes(actual)
            : actual === value;
        }),
      );
    }),
  };
}

function database() {
  const query = vi.fn(async () => ({ rows: [] }));
  const release = vi.fn(async () => {});
  const result = {
    acquireSession: vi.fn(async () => ({ query, release })),
    query,
    release,
    transaction: vi.fn(),
  };
  result.transaction.mockImplementation(
    async (work: (database: typeof result) => Promise<unknown>) =>
      await work(result),
  );
  return result;
}

function serializedSourceLock() {
  let tail = Promise.resolve();
  return async <T>(_sourceId: string, work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

describe('source WebMCP service', () => {
  const root = record({
    id: SOURCE_ID,
    sourceRole: 'root',
    parentSourceId: null,
    name: 'Greenhouse',
    provider: 'greenhouse',
    type: 'job_board',
    isActive: true,
    refreshCadence: 'daily',
    loginIdentity: 'private@example.com',
    wardenReference: 'secret-item',
  });

  beforeEach(() => {
    dbConfig.type = 'postgres';
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('creates an active OpenAI Ashby root without scheduling or crawling it', async () => {
    const sources = collection();
    sources.create.mockImplementation(
      async (payload: Record<string, unknown>) => {
        const created = record({ ...payload, id: SOURCE_ID });
        sources.records.push(created);
        return created;
      },
    );
    const crawls = collection();
    const jobs = collection();
    const audit = vi.fn(async () => ({}));

    const result = await createRootSourceFromWebMcp(
      {
        name: 'OpenAI Careers',
        provider: 'ashby',
        url: 'https://jobs.ashbyhq.com/openai#openings',
      },
      { id: 'user-1' },
      {
        audit,
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: jobs as never,
        sourceCollection: sources as never,
      },
    );

    expect(result).toMatchObject({
      active: true,
      name: 'OpenAI Careers',
      provider: 'ashby',
      sourceRole: 'root',
      type: 'company_careers',
      url: 'https://jobs.ashbyhq.com/openai',
    });
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      isActive: true,
      parentSourceId: null,
      provider: 'ashby',
      refreshCadence: 'ad_hoc',
      sourceRole: 'root',
      url: 'https://jobs.ashbyhq.com/openai',
    });
    expect(crawls.create).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: 'webmcp_source_create',
        sourceId: result.id,
        user: { id: 'user-1' },
      }),
    );
  });

  it('ranks provider health from terminal durable counts without sensitive fields', async () => {
    const sources = collection([
      root,
      {
        id: CHILD_ID,
        sourceRole: 'root',
        parentSourceId: SOURCE_ID,
        name: 'Corrupt root lineage',
        type: 'job_board',
        isActive: false,
      },
    ]);
    const crawls = collection([
      {
        id: 'crawl-terminal',
        sourceId: SOURCE_ID,
        status: 'completed_with_errors',
        attemptCount: 10,
        newOpportunityCount: 4,
        duplicateCount: 3,
        skippedCount: 2,
        failedPersistenceCount: 1,
      },
      {
        id: 'crawl-running',
        sourceId: SOURCE_ID,
        status: 'running',
        attemptCount: 99,
        newOpportunityCount: 99,
      },
    ]);

    const result = await listRootSourceHealth(
      { historyLimit: 5, limit: 5 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: sources as never,
      },
    );

    expect(result.items[0]).toMatchObject({
      id: SOURCE_ID,
      type: 'job_board',
      health: {
        candidates: 10,
        created: 4,
        duplicates: 3,
        errors: 1,
        runs: 1,
        skipped: 2,
      },
    });
    expect(result.providers[0]).toMatchObject({
      provider: 'greenhouse',
      created: 4,
    });
    expect(result.scan).toMatchObject({
      candidateLimit: 500,
      providerProvenance: 'persisted_adapter_identity',
    });
    expect(result.items[0]).not.toHaveProperty('loginIdentity');
    expect(result.items[0]).not.toHaveProperty('wardenReference');
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('Corrupt root lineage');
  });

  it('aggregates concrete persisted providers before applying response caps', async () => {
    const ashbyId = '55555555-5555-4555-8555-555555555555';
    const sources = collection([
      root,
      {
        id: ashbyId,
        isActive: true,
        name: 'Ashby board',
        parentSourceId: null,
        provider: 'ashby',
        sourceRole: 'root',
        type: 'job_board',
      },
    ]);
    const crawls = collection([
      {
        id: 'greenhouse-terminal',
        newOpportunityCount: 2,
        sourceId: SOURCE_ID,
        status: 'completed',
      },
      {
        id: 'ashby-terminal',
        newOpportunityCount: 7,
        sourceId: ashbyId,
        status: 'completed',
      },
    ]);

    const result = await listRootSourceHealth(
      { historyLimit: 5, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: sources as never,
      },
    );

    expect(result.items).toHaveLength(1);
    expect(result.providers).toEqual([
      expect.objectContaining({ created: 7, provider: 'ashby' }),
      expect.objectContaining({ created: 2, provider: 'greenhouse' }),
    ]);
    expect(result.scan.truncated).toBe(true);
    expect(sources.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 501 }),
    );
  });

  it('caps every source health text field', async () => {
    const result = await listRootSourceHealth(
      { limit: 1 },
      {
        crawlCollection: collection() as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([
          {
            ...root,
            name: 'n'.repeat(500),
            refreshCadence: 'c'.repeat(500),
            type: 't'.repeat(500),
          },
        ]) as never,
      },
    );
    expect(result.items[0]?.name).toHaveLength(200);
    expect(result.items[0]?.type).toHaveLength(64);
    expect(result.items[0]?.cadence).toHaveLength(64);
  });

  it('refuses activation and crawl for posting-derived or ambiguous sources', async () => {
    const child = record({
      id: CHILD_ID,
      sourceRole: 'posting_derived',
      parentSourceId: SOURCE_ID,
      isActive: false,
    });
    const sources = collection([child]);
    const dependencies = {
      audit: vi.fn(),
      crawlCollection: collection() as never,
      database: database() as never,
      jobCollection: collection() as never,
      sourceLock: serializedSourceLock(),
      sourceCollection: sources as never,
      syncSchedule: vi.fn(),
    };

    await expect(
      setRootSourceActive(
        { active: true, reason: 'QA', sourceId: CHILD_ID },
        { id: 'user-1' },
        dependencies as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'request-child-1',
          reason: 'QA',
          sourceId: CHILD_ID,
        },
        { id: 'user-1' },
        dependencies as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(dependencies.audit).not.toHaveBeenCalled();
  });

  it.each([
    false,
    null,
    undefined,
  ])('refuses durable crawl enqueue when root activation is %s', async (isActive) => {
    const sources = collection([{ ...root, isActive }]);
    const crawls = collection();
    const jobs = collection();
    const audit = vi.fn();
    const dependencies = {
      audit,
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceLock: serializedSourceLock(),
      sourceCollection: sources as never,
    };

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'inactive-request',
          reason: 'QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        dependencies as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(audit).not.toHaveBeenCalled();
    expect(crawls.records).toHaveLength(0);
    expect(jobs.records).toHaveLength(0);
  });

  it('reuses the same active operation and stable job/crawl ids', async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT', '4');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT', '4000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS', '40000');
    const sources = collection([root]);
    const crawls = collection();
    const jobs = collection();
    const audit = vi.fn(async () => ({}));
    const dependencies = {
      audit,
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      now: () => new Date('2026-08-31T12:00:00Z'),
      sourceCollection: sources as never,
      sourceLock: serializedSourceLock(),
    };
    const input = {
      idempotencyKey: 'provider-run-2026-08-31',
      limit: 25,
      reason: 'Bounded WebMCP QA',
      sourceId: SOURCE_ID,
    };

    const first = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );
    const second = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );

    expect(first).toMatchObject({ reused: false, sourceId: SOURCE_ID });
    expect(second).toMatchObject({
      crawlId: first.crawlId,
      jobId: first.jobId,
      reused: true,
    });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
    expect(crawls.records[0]).toMatchObject({
      intelligenceCallLimit: expect.any(Number),
      intelligenceInputTokenLimit: expect.any(Number),
      intelligenceSpendLimitMicros: expect.any(Number),
    });
    expect(Number(crawls.records[0].intelligenceCallLimit)).toBeGreaterThan(0);
    expect(first.crawlId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses another crawl while an ownerless nonterminal crawl needs reconciliation', async () => {
    const jobs = collection();
    const crawls = collection([
      {
        id: '33333333-3333-4333-8333-333333333333',
        jobId: '44444444-4444-4444-8444-444444444444',
        requestKey: 'orphaned-provider-run',
        sourceId: SOURCE_ID,
        status: 'queued',
      },
    ]);
    const audit = vi.fn(async () => ({}));

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'replacement-provider-run',
          reason: 'Do not duplicate an orphaned crawl',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit,
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(jobs.create).not.toHaveBeenCalled();
    expect(crawls.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses an ownerless crawl that conflicts with a matching active job', async () => {
    const jobs = collection([
      {
        args: {
          idempotencyKey: 'matching-active-job',
          sourceCrawlId: '55555555-5555-4555-8555-555555555555',
        },
        id: '66666666-6666-4666-8666-666666666666',
        method: SOURCE_CRAWL_METHOD,
        objectId: SOURCE_ID,
        objectType: SOURCE_JOB_OBJECT_TYPE,
        queue: SOURCE_CRAWL_QUEUE,
        status: 'pending',
      },
    ]);
    const crawls = collection([
      {
        id: '77777777-7777-4777-8777-777777777777',
        jobId: '88888888-8888-4888-8888-888888888888',
        requestKey: 'orphaned-provider-run',
        sourceId: SOURCE_ID,
        status: 'running',
      },
    ]);
    const audit = vi.fn(async () => ({}));

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'matching-active-job',
          reason: 'Do not duplicate an orphaned crawl',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit,
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(jobs.create).not.toHaveBeenCalled();
    expect(crawls.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses an active job with no exact durable crawl binding', async () => {
    const jobs = collection([
      {
        args: { idempotencyKey: 'missing-active-crawl-id' },
        id: '99999999-9999-4999-8999-999999999999',
        method: SOURCE_CRAWL_METHOD,
        objectId: SOURCE_ID,
        objectType: SOURCE_JOB_OBJECT_TYPE,
        queue: SOURCE_CRAWL_QUEUE,
        status: 'pending',
      },
    ]);
    const crawls = collection();
    const audit = vi.fn(async () => ({}));

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'missing-active-crawl-id',
          reason: 'Do not infer a missing durable binding',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit,
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(jobs.create).not.toHaveBeenCalled();
    expect(crawls.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a terminal-job and queued-crawl mismatch until durable reconciliation completes', async () => {
    const jobs = collection();
    const crawls = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };
    const input = {
      idempotencyKey: 'completed-provider-run',
      reason: 'Retry completed request',
      sourceId: SOURCE_ID,
    };

    const first = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );
    jobs.records[0].status = 'completed';
    await expect(
      enqueueRootSourceCrawl(
        { ...input, limit: 1, reason: 'Changed retry input' },
        { id: 'user-1' },
        dependencies,
      ),
    ).rejects.toMatchObject({ status: 409 });

    crawls.records[0].status = 'failed';
    crawls.records[0].finishedAt = new Date('2026-08-31T12:00:00Z');
    const second = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );

    expect(second).toMatchObject({
      crawlId: first.crawlId,
      jobId: first.jobId,
      reused: true,
      status: 'completed',
    });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
    expect(jobs.records[0].args).toMatchObject({
      limit: 50,
      reason: 'Retry completed request',
    });
  });

  it.each([
    ['id', (job: Record<string, unknown>) => ({ ...job, id: ` ${job.id} ` })],
    [
      'idempotency key',
      (job: Record<string, unknown>) => {
        (job.args as Record<string, unknown>).idempotencyKey =
          ' malformed-completed-provider-run ';
        return job;
      },
    ],
    [
      'source crawl id',
      (job: Record<string, unknown>) => {
        const args = job.args as Record<string, unknown>;
        args.sourceCrawlId = ` ${args.sourceCrawlId} `;
        return job;
      },
    ],
    [
      'source object id',
      (job: Record<string, unknown>) => ({
        ...job,
        objectId: ` ${job.objectId} `,
      }),
    ],
    [
      'queue',
      (job: Record<string, unknown>) => ({
        ...job,
        queue: ` ${job.queue} `,
      }),
    ],
    [
      'object type',
      (job: Record<string, unknown>) => ({
        ...job,
        objectType: ` ${job.objectType} `,
      }),
    ],
    [
      'method',
      (job: Record<string, unknown>) => ({
        ...job,
        method: ` ${job.method} `,
      }),
    ],
    [
      'terminal status',
      (job: Record<string, unknown>) => ({
        ...job,
        status: ` ${job.status} `,
      }),
    ],
  ] as const)('rejects deterministic recovery with a malformed stored %s binding', async (_field, corruptJob) => {
    const jobs = collection();
    const crawls = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };
    const input = {
      idempotencyKey: 'malformed-completed-provider-run',
      reason: 'Retry malformed completed request',
      sourceId: SOURCE_ID,
    };

    await enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies);
    crawls.records[0].status = 'failed';
    crawls.records[0].finishedAt = new Date('2026-08-31T12:00:00Z');
    jobs.records[0].status = 'completed';
    const malformedJob = corruptJob(jobs.records[0]);
    jobs.get.mockResolvedValueOnce(malformedJob as never);

    await expect(
      enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies),
    ).rejects.toMatchObject({ status: 409 });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
  });

  it('rejects a manual crawl while a scheduled crawl job is active', async () => {
    const scheduledJob = {
      args: { reason: 'scheduled' },
      id: 'scheduled-job-1',
      method: 'crawl',
      objectId: SOURCE_ID,
      objectType: '@willgriffin/iolaus-site:Source',
      queue: 'agents',
      status: 'pending',
    };
    const jobs = collection([scheduledJob]);
    const crawls = collection();

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'manual-during-schedule',
          reason: 'Manual overlap QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => ({})),
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(jobs.create).not.toHaveBeenCalled();
    expect(crawls.create).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of overwriting another active request', async () => {
    const sources = collection([root]);
    const crawls = collection();
    const jobs = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: sources as never,
      sourceLock: serializedSourceLock(),
    };
    await enqueueRootSourceCrawl(
      {
        idempotencyKey: 'provider-run-a',
        reason: 'First request',
        sourceId: SOURCE_ID,
      },
      { id: 'user-1' },
      dependencies,
    );

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'provider-run-b',
          reason: 'Second request',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        dependencies,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
  });

  it('maps an eager database active-job conflict and rolls back its prepared crawl', async () => {
    const requestDatabase = database();
    const crawls = collection();
    const jobs = collection();
    jobs.create.mockRejectedValueOnce({
      code: '23505',
      constraint: SOURCE_CRAWL_ACTIVE_JOB_INDEX,
    });
    requestDatabase.transaction.mockImplementation(
      async (work: (database: typeof requestDatabase) => Promise<unknown>) => {
        try {
          return await work(requestDatabase);
        } catch (cause) {
          crawls.records.splice(0);
          throw cause;
        }
      },
    );

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'eager-conflict-request',
          reason: 'Conflict QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => ({})),
          crawlCollection: crawls as never,
          database: requestDatabase as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(crawls.records).toHaveLength(0);
  });

  it('recovers deterministic ids when same-key callers race', async () => {
    const crawls = collection();
    const jobs = collection();
    const input = {
      idempotencyKey: 'provider-race-one',
      reason: 'Concurrent QA',
      sourceId: SOURCE_ID,
    };
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };

    const [left, right] = await Promise.all([
      enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies),
      enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies),
    ]);

    expect(left.crawlId).toBe(right.crawlId);
    expect(left.jobId).toBe(right.jobId);
    expect(crawls.records).toHaveLength(1);
    expect(jobs.records).toHaveLength(1);
  });

  it('serializes different-key callers and keeps one active operation', async () => {
    const crawls = collection();
    const jobs = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };

    const results = await Promise.allSettled([
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'provider-race-first',
          reason: 'Concurrent QA first',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        dependencies,
      ),
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'provider-race-second',
          reason: 'Concurrent QA second',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        dependencies,
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(jobs.records).toHaveLength(1);
    expect(crawls.records).toHaveLength(1);
  });

  it('holds a database advisory lock around production enqueue', async () => {
    const requestDatabase = database();
    await enqueueRootSourceCrawl(
      {
        idempotencyKey: 'database-lock-request',
        reason: 'Lock QA',
        sourceId: SOURCE_ID,
      },
      { id: 'user-1' },
      {
        audit: vi.fn(async () => ({})),
        crawlCollection: collection() as never,
        database: requestDatabase as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );

    expect(requestDatabase.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock(hashtext(?))',
      [`webmcp-source-crawl:${SOURCE_ID}`],
    );
    expect(requestDatabase.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext(?))',
      [`webmcp-source-crawl:${SOURCE_ID}`],
    );
    expect(requestDatabase.release).toHaveBeenCalledOnce();
  });

  it('uses the local serialization path without probing PostgreSQL indexes', async () => {
    dbConfig.type = 'sqlite';
    const jobs = collection();
    const sourceLockCalls: string[] = [];
    const sourceLock = async <T>(
      id: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      sourceLockCalls.push(id);
      return await work();
    };
    const localCrawlWorker = vi.fn(async () => {});
    const jobDedupeStatus = vi.fn(async () => {
      throw new Error('PostgreSQL index probes are unavailable locally.');
    });

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'sqlite-openai-provider-run',
          reason: 'Local OpenAI Ashby demo',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => ({})),
          crawlCollection: collection() as never,
          database: database() as never,
          jobCollectionFactory: vi.fn(async () => jobs as never),
          jobDedupeStatus,
          localCrawlWorker,
          sourceCollection: collection([root]) as never,
          sourceLock,
        },
      ),
    ).resolves.toMatchObject({ sourceId: SOURCE_ID, status: 'pending' });

    expect(jobDedupeStatus).not.toHaveBeenCalled();
    expect(sourceLockCalls).toEqual([SOURCE_ID]);
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(localCrawlWorker).toHaveBeenCalledOnce();
  });

  it('propagates one request database through job and schedule writes', async () => {
    const requestDatabase = database();
    const jobs = collection();
    const jobCollectionFactory = vi.fn(async () => jobs as never);
    const jobDedupeStatus = vi.fn(async () => ({
      activeIndexNamed: true,
      activeIndexPresent: true,
    }));
    const syncSchedule = vi.fn(async () => ({
      agentId: SOURCE_ID,
      agentType: '@willgriffin/iolaus-site:Source',
      cron: '0 0 * * *',
      enabled: true,
      id: 'schedule-1',
      method: 'crawl',
      methodArgs: {},
      nextRun: new Date('2026-08-31T12:00:00Z'),
      status: 'active' as const,
    }));
    const sources = collection([root]);
    const base = {
      audit: vi.fn(async (_input: Record<string, unknown>) => ({})),
      crawlCollection: collection() as never,
      database: requestDatabase as never,
      jobDedupeStatus,
      jobCollectionFactory,
      sourceCollection: sources as never,
      sourceLock: serializedSourceLock(),
      syncSchedule: syncSchedule as never,
    };

    await enqueueRootSourceCrawl(
      {
        idempotencyKey: 'tenant-scoped-request',
        reason: 'Tenant QA',
        sourceId: SOURCE_ID,
      },
      { id: 'user-1' },
      base,
    );
    await setRootSourceActive(
      { active: true, reason: 'Tenant QA', sourceId: SOURCE_ID },
      { id: 'user-1' },
      base,
    );

    expect(jobCollectionFactory).toHaveBeenCalledWith(requestDatabase);
    expect(jobDedupeStatus).toHaveBeenCalledWith(requestDatabase);
    expect(syncSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: SOURCE_ID }),
      { db: requestDatabase },
    );
    expect(base.audit).toHaveBeenCalledTimes(2);
    for (const [auditInput] of base.audit.mock.calls) {
      expect(auditInput).toEqual(
        expect.objectContaining({ database: requestDatabase }),
      );
    }
  });

  it('rolls activation back when its audit record cannot be written', async () => {
    const requestDatabase = database();
    const source = record({ ...root, isActive: false });
    requestDatabase.transaction.mockImplementation(
      async (work: (database: typeof requestDatabase) => Promise<unknown>) => {
        const previous = source.isActive;
        try {
          return await work(requestDatabase);
        } catch (cause) {
          source.isActive = previous;
          throw cause;
        }
      },
    );

    await expect(
      setRootSourceActive(
        { active: true, reason: 'Enable', sourceId: SOURCE_ID },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => {
            throw new Error('audit unavailable');
          }),
          database: requestDatabase as never,
          sourceCollection: collection([source]) as never,
          sourceLock: serializedSourceLock(),
          syncSchedule: vi.fn(async () => ({ enabled: true }) as never),
        },
      ),
    ).rejects.toThrow('audit unavailable');
    expect(source.isActive).toBe(false);
  });

  it('rolls crawl and job creation back when enqueue audit fails', async () => {
    const requestDatabase = database();
    const jobs = collection();
    const crawls = collection();
    requestDatabase.transaction.mockImplementation(
      async (work: (database: typeof requestDatabase) => Promise<unknown>) => {
        try {
          return await work(requestDatabase);
        } catch (cause) {
          jobs.records.splice(0);
          crawls.records.splice(0);
          throw cause;
        }
      },
    );

    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'audit-failure-request',
          reason: 'Audit rollback QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => {
            throw new Error('audit unavailable');
          }),
          crawlCollection: crawls as never,
          database: requestDatabase as never,
          jobCollection: jobs as never,
          sourceCollection: collection([root]) as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toThrow('audit unavailable');
    expect(jobs.records).toHaveLength(0);
    expect(crawls.records).toHaveLength(0);
  });

  it('serializes opposing activation updates in one database transaction', async () => {
    const requestDatabase = database();
    const source = record({ ...root, isActive: false });
    const seen: boolean[] = [];
    const syncSchedule = vi.fn(async (candidate: Record<string, unknown>) => {
      seen.push(candidate.isActive === true);
      return { enabled: candidate.isActive === true } as never;
    });
    const dependencies = {
      audit: vi.fn(async () => ({})),
      database: requestDatabase as never,
      sourceCollection: collection([source]) as never,
      sourceLock: serializedSourceLock(),
      syncSchedule: syncSchedule as never,
    };

    await Promise.all([
      setRootSourceActive(
        { active: true, reason: 'Enable', sourceId: SOURCE_ID },
        { id: 'user-1' },
        dependencies,
      ),
      setRootSourceActive(
        { active: false, reason: 'Disable', sourceId: SOURCE_ID },
        { id: 'user-1' },
        dependencies,
      ),
    ]);

    expect(seen).toEqual([true, false]);
    expect(source.isActive).toBe(false);
    expect(requestDatabase.transaction).toHaveBeenCalledTimes(2);
  });

  it('rolls source activation back when schedule synchronization fails', async () => {
    const requestDatabase = database();
    const source = record({ ...root, isActive: false });
    requestDatabase.transaction.mockImplementation(
      async (work: (database: typeof requestDatabase) => Promise<unknown>) => {
        const previous = source.isActive;
        try {
          return await work(requestDatabase);
        } catch (cause) {
          source.isActive = previous;
          throw cause;
        }
      },
    );

    await expect(
      setRootSourceActive(
        { active: true, reason: 'Enable', sourceId: SOURCE_ID },
        { id: 'user-1' },
        {
          audit: vi.fn(async () => ({})),
          database: requestDatabase as never,
          sourceCollection: collection([source]) as never,
          sourceLock: serializedSourceLock(),
          syncSchedule: vi.fn(async () => {
            throw new Error('schedule unavailable');
          }),
        },
      ),
    ).rejects.toThrow('schedule unavailable');
    expect(source.isActive).toBe(false);
  });

  it('caps and sanitizes operational errors', async () => {
    const crawlId = '33333333-3333-4333-8333-333333333333';
    const crawls = collection([
      {
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
        error:
          'Authorization: Bearer abc123\nCookie: session=supersecret\npassword=hunter2\ncredentials=plural-secret\nhttps://user:pass@example.com/jobs?api_key=secret\nfifth\nsixth',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );

    expect(result.items[0].errors).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('supersecret');
    expect(JSON.stringify(result)).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('plural-secret');
    expect(JSON.stringify(result)).not.toContain('user:pass');
    expect(JSON.stringify(result)).not.toContain('api_key=secret');
  });

  it('redacts quoted and nested structured credentials', async () => {
    const crawlId = '44444444-4444-4444-8444-444444444444';
    const crawls = collection([
      {
        error: JSON.stringify({
          api_key: 'secret456',
          credentials: 'plural-credential',
          headers: {
            Authorization: 'Bearer nested-token',
            Cookie: 'session=xyz',
          },
          oauth: {
            access_token: 'oauth-access',
            client_secret: 'oauth-client-secret',
            refresh_token: 'oauth-refresh',
            'x-api-key': 'provider-key',
          },
        }),
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    expect(response).not.toContain('secret456');
    expect(response).not.toContain('plural-credential');
    expect(response).not.toContain('nested-token');
    expect(response).not.toContain('oauth-access');
    expect(response).not.toContain('oauth-client-secret');
    expect(response).not.toContain('oauth-refresh');
    expect(response).not.toContain('provider-key');
    expect(response).not.toContain('session=xyz');
    expect(response).toContain('[redacted]');
  });

  it('redacts every authorization scheme and plain OAuth credential keys', async () => {
    const crawlId = '55555555-5555-4555-8555-555555555555';
    const crawls = collection([
      {
        error:
          'Authorization: Basic dXNlcjpwYXNz\nProxy-Authorization: Digest digest-secret\nAuthorization=Bearer equals-secret\nCookie=session=equals-cookie\naccess_token=oauth-access\nclient_secret=oauth-secret\nx-api-key=provider-key',
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    for (const credential of [
      'dXNlcjpwYXNz',
      'digest-secret',
      'equals-secret',
      'equals-cookie',
      'oauth-access',
      'oauth-secret',
      'provider-key',
    ]) {
      expect(response).not.toContain(credential);
    }
  });

  it('redacts structured camelCase credential keys', async () => {
    const crawlId = '66666666-6666-4666-8666-666666666666';
    const secretValues = [
      'api-key-value',
      'client-secret-value',
      'access-token-value',
      'refresh-token-value',
      'oauth-token-value',
      'auth-token-value',
      'session-token-value',
      'private-key-value',
      'lower-access-token-value',
      'lower-api-key-value',
      'lower-client-secret-value',
      'lower-session-key-value',
    ];
    const crawls = collection([
      {
        error: JSON.stringify({
          apiKey: secretValues[0],
          clientSecret: secretValues[1],
          accessToken: secretValues[2],
          refreshToken: secretValues[3],
          oauthToken: secretValues[4],
          authToken: secretValues[5],
          sessionToken: secretValues[6],
          privateKey: secretValues[7],
          accesstoken: secretValues[8],
          apikey: secretValues[9],
          clientsecret: secretValues[10],
          sessionkey: secretValues[11],
        }),
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    for (const credential of secretValues) {
      expect(response).not.toContain(credential);
    }
  });

  it('redacts normalized structured authorization and cookie keys recursively', async () => {
    const crawlId = '67676767-6767-4676-8676-676767676767';
    const secretValues = [
      'set-cookie-secret',
      'proxy-authorization-secret',
      'compact-auth-token-secret',
      'compact-private-key-secret',
      'compact-db-password-secret',
    ];
    const crawls = collection([
      {
        error: JSON.stringify({
          nested: {
            authtoken: secretValues[2],
            dbpassword: secretValues[4],
            privatekey: secretValues[3],
            proxyAuthorization: secretValues[1],
            setCookie: secretValues[0],
          },
        }),
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    for (const credential of secretValues) {
      expect(response).not.toContain(credential);
    }
    expect(response).toContain('[redacted]');
  });

  it('redacts compact lowercase credential keys in plain errors', async () => {
    const crawlId = '68686868-6868-4686-8686-686868686868';
    const crawls = collection([
      {
        error:
          'provider failed: privatekey=plain-private-secret; dbpassword="plain-db-secret"; retry denied',
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    expect(response).not.toContain('plain-private-secret');
    expect(response).not.toContain('plain-db-secret');
    expect(response).toContain('[redacted]');
  });

  it('redacts plain camelCase credential keys and bare authorization schemes', async () => {
    const crawlId = '77777777-7777-4777-8777-777777777777';
    const crawls = collection([
      {
        error:
          'provider request failed: apiKey="plain camel secret"; authToken=auth-token-secret; privateKey="private key secret"; sessionToken session-token-secret; retry denied\npassphrase=correct horse battery staple\napi key: spaced alpha beta; retry retained\nupstream rejected Bearer "bare bearer secret"; then Bearer bare-token suffix prose retained\nprovider rejected Authorization: Bearer alpha beta; Cookie: session=multi word cookie; request denied',
        id: crawlId,
        sourceId: SOURCE_ID,
        status: 'failed',
      },
    ]);

    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: crawls as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    expect(response).not.toContain('plain camel secret');
    expect(response).not.toContain('auth-token-secret');
    expect(response).not.toContain('private key secret');
    expect(response).not.toContain('session-token-secret');
    expect(response).not.toContain('correct horse battery staple');
    expect(response).not.toContain('bare bearer secret');
    expect(response).not.toContain('spaced alpha beta');
    expect(response).not.toContain('bare-token');
    expect(response).not.toContain('alpha beta');
    expect(response).not.toContain('multi word cookie');
    expect(response).toContain('provider request failed');
    expect(response).toContain('upstream rejected');
    expect(response).toContain('retry denied');
    expect(response).toContain('retry retained');
    expect(response).toContain('suffix prose retained');
    expect(response).toContain('request denied');
    expect(response).toContain('provider rejected Authorization');
    expect(response).toContain('Cookie=[redacted]');
  });

  it('redacts whitespace-delimited credential prose without losing suffixes', async () => {
    const crawlId = '88888888-8888-4888-8888-888888888888';
    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: collection([
          {
            crawlType: 'x'.repeat(500),
            error:
              'request rejected: API key sk-live-123 expired; access token abc123 was rejected; API token was sk-after-connector denied',
            id: crawlId,
            sourceId: SOURCE_ID,
            status: 's'.repeat(500),
          },
        ]) as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    expect(response).not.toContain('sk-live-123');
    expect(response).not.toContain('abc123');
    expect(response).not.toContain('sk-after-connector');
    expect(response).toContain('request rejected');
    expect(response).toContain('expired');
    expect(response).toContain('was rejected');
    expect(response).toContain('denied');
    expect(result.items[0]?.status).toHaveLength(64);
    expect(result.items[0]?.crawlType).toHaveLength(64);
  });

  it('redacts userinfo and query secrets from every hierarchical URI scheme', async () => {
    const crawlId = '99999999-9999-4999-8999-999999999999';
    const result = await listSourceCrawlStatus(
      { crawlId, limit: 1 },
      {
        crawlCollection: collection([
          {
            error:
              'database failed postgresql://dbuser:dbpass@db.example/jobs?token=query-secret#fragment-secret\nproxy failed socks5://proxyuser:proxypass@proxy.example:1080',
            id: crawlId,
            sourceId: SOURCE_ID,
            status: 'failed',
          },
        ]) as never,
        database: database() as never,
        jobCollection: collection() as never,
        sourceCollection: collection([root]) as never,
      },
    );
    const response = JSON.stringify(result);
    for (const credential of [
      'dbuser',
      'dbpass',
      'query-secret',
      'fragment-secret',
      'proxyuser',
      'proxypass',
    ]) {
      expect(response).not.toContain(credential);
    }
    expect(response).toContain('postgresql://db.example/jobs');
    expect(response).toContain('socks5://proxy.example:1080');
  });

  it('refuses crawl status for a posting-derived source', async () => {
    const crawlId = '88888888-8888-4888-8888-888888888888';
    const child = {
      id: CHILD_ID,
      isActive: false,
      parentSourceId: SOURCE_ID,
      sourceRole: 'posting',
    };

    await expect(
      listSourceCrawlStatus(
        { crawlId },
        {
          crawlCollection: collection([
            { id: crawlId, sourceId: CHILD_ID, status: 'failed' },
          ]) as never,
          database: database() as never,
          jobCollection: collection() as never,
          sourceCollection: collection([root, child]) as never,
        },
      ),
    ).rejects.toThrow('not an explicitly classified root source');
  });

  it('refuses mismatched crawl and source status selectors', async () => {
    const crawlId = '99999999-9999-4999-8999-999999999999';

    await expect(
      listSourceCrawlStatus(
        { crawlId, sourceId: SOURCE_ID },
        {
          crawlCollection: collection([
            { id: crawlId, sourceId: CHILD_ID, status: 'failed' },
          ]) as never,
          database: database() as never,
          jobCollection: collection() as never,
          sourceCollection: collection([root]) as never,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('fails closed without global job reconciliation when the index is missing', async () => {
    const sources = collection([root]);
    const jobs = collection();
    const crawls = collection();
    const jobDedupeStatus = vi.fn(async () => ({
      activeIndexNamed: false,
      activeIndexPresent: false,
    }));
    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'missing-index-request',
          reason: 'QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollectionFactory: vi.fn(async () => jobs as never),
          jobDedupeStatus,
          sourceCollection: sources as never,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(jobDedupeStatus).toHaveBeenCalledOnce();
    expect(jobs.records).toHaveLength(0);
    expect(crawls.records).toHaveLength(0);
  });

  it('returns not found without mutating global jobs or crawls', async () => {
    const jobs = collection();
    const crawls = collection();
    const jobDedupeStatus = vi.fn(async () => ({
      activeIndexNamed: true,
      activeIndexPresent: true,
    }));
    await expect(
      enqueueRootSourceCrawl(
        {
          idempotencyKey: 'missing-source-request',
          reason: 'QA',
          sourceId: SOURCE_ID,
        },
        { id: 'user-1' },
        {
          crawlCollection: crawls as never,
          database: database() as never,
          jobCollectionFactory: vi.fn(async () => jobs as never),
          jobDedupeStatus,
          sourceCollection: collection() as never,
          sourceLock: serializedSourceLock(),
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(jobDedupeStatus).toHaveBeenCalledOnce();
    expect(jobs.records).toHaveLength(0);
    expect(crawls.records).toHaveLength(0);
  });

  it('returns a durable terminal crawl after its job has been pruned', async () => {
    const jobs = collection();
    const crawls = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };
    const input = {
      idempotencyKey: 'pruned-terminal-job',
      reason: 'Original durable request',
      sourceId: SOURCE_ID,
    };

    const first = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );
    crawls.records[0].status = 'completed';
    crawls.records[0].finishedAt = new Date('2026-08-31T12:00:00Z');
    jobs.records.splice(0);
    const second = await enqueueRootSourceCrawl(
      input,
      { id: 'user-1' },
      dependencies,
    );

    expect(second).toMatchObject({
      crawlId: first.crawlId,
      jobId: first.jobId,
      reused: true,
      status: 'completed',
    });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'crawl id',
      (crawl: Record<string, unknown>) => ({ ...crawl, id: ` ${crawl.id} ` }),
    ],
    [
      'source id',
      (crawl: Record<string, unknown>) => ({
        ...crawl,
        sourceId: ` ${crawl.sourceId} `,
      }),
    ],
    [
      'request key',
      (crawl: Record<string, unknown>) => ({
        ...crawl,
        requestKey: ` ${crawl.requestKey} `,
      }),
    ],
    [
      'job id',
      (crawl: Record<string, unknown>) => ({
        ...crawl,
        jobId: ` ${crawl.jobId} `,
      }),
    ],
    [
      'blank job id',
      (crawl: Record<string, unknown>) => ({ ...crawl, jobId: '' }),
    ],
    [
      'wrong-typed job id',
      (crawl: Record<string, unknown>) => ({ ...crawl, jobId: 42 }),
    ],
  ] as const)('rejects pruned-job recovery with a malformed terminal crawl %s binding', async (_field, corruptCrawl) => {
    const jobs = collection();
    const crawls = collection();
    const dependencies = {
      audit: vi.fn(async () => ({})),
      crawlCollection: crawls as never,
      database: database() as never,
      jobCollection: jobs as never,
      sourceCollection: collection([root]) as never,
      sourceLock: serializedSourceLock(),
    };
    const input = {
      idempotencyKey: 'malformed-pruned-terminal-job',
      reason: 'Malformed durable request',
      sourceId: SOURCE_ID,
    };

    await enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies);
    crawls.records[0].status = 'completed';
    crawls.records[0].finishedAt = new Date('2026-08-31T12:00:00Z');
    jobs.records.splice(0);
    crawls.get.mockResolvedValueOnce(corruptCrawl(crawls.records[0]) as never);

    await expect(
      enqueueRootSourceCrawl(input, { id: 'user-1' }, dependencies),
    ).rejects.toMatchObject({ status: 409 });
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(crawls.create).toHaveBeenCalledOnce();
  });
});
