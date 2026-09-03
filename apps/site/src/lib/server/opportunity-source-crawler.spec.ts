import type { Link, SpiderAdapter } from '@happyvertical/spider';
import type { AdapterContext } from '@happyvertical/spider/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content';
import {
  candidateMatchesSource,
  crawlOpportunitySources,
  crawlOpportunitySource as crawlOpportunitySourceWithGuard,
  defaultOpportunitySpiderOptions,
  detectJobBoard,
  discoverA16zPortfolioCandidates,
  discoverAiJobsCandidates,
  discoverAmazonJobsCandidates,
  discoverAppleCareersCandidates,
  discoverAshbyCandidates,
  discoverAutomatticCandidates,
  discoverCanonicalCandidates,
  discoverFreelancerCandidates,
  discoverGeminiCareersCandidates,
  discoverGenericPostingLinks,
  discoverGenericProviderLinks,
  discoverGoogleCareersCandidates,
  discoverGreenhouseCandidates,
  discoverHackerNewsJobsCandidates,
  discoverLeverCandidates,
  discoverLinkedInCandidates,
  discoverMicrosoftCareersCandidates,
  discoverOpportunityCandidates,
  discoverOracleCareersCandidates,
  discoverPeoplePerHourCandidates,
  discoverRemoteComCandidates,
  discoverRemoteOkCandidates,
  discoverRemoteRocketshipCandidates,
  discoverRemotiveCandidates,
  discoverWellfoundCandidates,
  discoverWeWorkRemotelyCandidates,
  discoverWorkdayCandidates,
  discoverWorkingNomadsCandidates,
  discoverYcCandidates,
  keywordTokens,
  resolveRootPosting,
  sourceIsCrawlable,
} from './opportunity-source-crawler';

function crawlOpportunitySource(
  source: Parameters<typeof crawlOpportunitySourceWithGuard>[0],
  options: Parameters<typeof crawlOpportunitySourceWithGuard>[1] = {},
) {
  return crawlOpportunitySourceWithGuard(
    {
      isActive: true,
      parentSourceId: null,
      sourceRole: 'root',
      ...source,
    },
    options,
  );
}

const getCollection = vi.hoisted(() => vi.fn());
const databaseUpdate = vi.hoisted(() => vi.fn(async () => ({ affected: 1 })));
const databaseQuery = vi.hoisted(() =>
  vi.fn(async () => ({ rowCount: 1, rows: [{ id: 'scheduled-job' }] })),
);
const databaseSessionFactory = vi.hoisted(() => vi.fn(async () => null));
const syncRecommendedOpportunityDecisionTasks = vi.hoisted(() =>
  vi.fn(async () => ({})),
);
const cancelStaleOpportunityIntelligenceTasks = vi.hoisted(() =>
  vi.fn(async () => 0),
);

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: vi.fn(async () => {
    const session = await databaseSessionFactory();
    return {
      ...(session ? { acquireSession: vi.fn(async () => session) } : {}),
      query: databaseQuery,
      update: databaseUpdate,
    };
  }),
}));

vi.mock('./smrt.js', () => ({
  getCollection,
}));

vi.mock('./application-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./application-workflow.js')>()),
  cancelStaleOpportunityIntelligenceTasks,
  syncRecommendedOpportunityDecisionTasks,
}));

beforeEach(() => {
  databaseSessionFactory.mockReset();
  databaseSessionFactory.mockResolvedValue(null);
  databaseUpdate.mockReset();
  databaseUpdate.mockResolvedValue({ affected: 1 });
  databaseQuery.mockReset();
  databaseQuery.mockResolvedValue({
    rowCount: 1,
    rows: [{ id: 'scheduled-job' }],
  });
  syncRecommendedOpportunityDecisionTasks.mockReset();
  syncRecommendedOpportunityDecisionTasks.mockResolvedValue({});
  cancelStaleOpportunityIntelligenceTasks.mockReset();
  cancelStaleOpportunityIntelligenceTasks.mockResolvedValue(0);
});

afterEach(() => vi.unstubAllEnvs());

it('terminalizes a running crawl when accounting-writer setup fails before discovery', async () => {
  const sourceCrawls = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const setupFailure = new Error('accounting writer unavailable');
  const options = { jobAttempt: 2, jobId: 'scheduled-job' } as Record<
    string,
    unknown
  >;
  Object.defineProperty(options, 'sourceCrawlAccounting', {
    get: () => {
      throw setupFailure;
    },
  });

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      options,
    ),
  ).rejects.toThrow('accounting writer unavailable');

  expect(sourceCrawls.records).toEqual([
    expect.objectContaining({
      error: 'Error: accounting writer unavailable',
      finishedAt: expect.any(Date),
      jobAttempt: 2,
      jobId: 'scheduled-job',
      status: 'failed',
    }),
  ]);
});

it.each([
  { jobAttempt: undefined, jobId: 'scheduled-job' },
  { jobAttempt: 2, jobId: undefined },
])('rejects a partial scheduled job binding before creating a crawl or provider work', async ({
  jobAttempt,
  jobId,
}) => {
  const sourceCrawls = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      { fetchImpl, jobAttempt, jobId },
    ),
  ).rejects.toThrow('exact worker job and positive attempt binding');

  expect(sourceCrawls.create).not.toHaveBeenCalled();
  expect(databaseQuery).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects a new job-bound crawl without its exact active owner before provider work', async () => {
  const sourceCrawls = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  databaseQuery.mockResolvedValue({ rowCount: 0, rows: [] });
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      { fetchImpl, jobAttempt: 2, jobId: 'scheduled-job' },
    ),
  ).rejects.toThrow('no active owning job attempt');

  expect(sourceCrawls.create).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(databaseQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'running'"),
    expect.arrayContaining(['scheduled-job', 'source-1', 2]),
  );
});

it('rejects a queued crawl resume that omits the exact worker attempt', async () => {
  const existingCrawl = {
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: 'scheduled-job',
    save: vi.fn(async () => undefined),
    sourceId: 'source-1',
    status: 'queued',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const options = {
    jobId: 'scheduled-job',
    sourceCrawlId: 'crawl-existing',
  } as Record<string, unknown>;
  Object.defineProperty(options, 'sourceCrawlAccounting', {
    get: () => {
      throw new Error('accounting writer unavailable');
    },
  });

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      options,
    ),
  ).rejects.toThrow('exact worker job and positive attempt binding');

  expect(existingCrawl).toMatchObject({
    jobAttempt: 3,
    jobId: 'scheduled-job',
    status: 'queued',
  });
  expect(databaseQuery).not.toHaveBeenCalled();
  expect(existingCrawl.save).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])('rejects a missing requested crawl before provider work or durable mutation (dryRun=%s)', async (dryRun) => {
  const sourceCrawls = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const accounting = {
    createAttempt: vi.fn(),
    finalizeAttempt: vi.fn(),
  };
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      {
        dryRun,
        fetchImpl,
        jobAttempt: 1,
        jobId: 'scheduled-job',
        sourceCrawlAccounting: accounting as never,
        sourceCrawlId: 'missing-crawl',
      },
    ),
  ).rejects.toThrow('Requested source crawl missing-crawl does not exist');

  expect(sourceCrawls.create).not.toHaveBeenCalled();
  expect(databaseQuery).not.toHaveBeenCalled();
  expect(accounting.createAttempt).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([
  '   ',
  ' crawl-existing ',
])('rejects a non-exact requested crawl identifier before collection or provider work', async (sourceCrawlId) => {
  getCollection.mockClear();
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      { dryRun: true, fetchImpl, sourceCrawlId },
    ),
  ).rejects.toThrow('exact nonblank durable binding');

  expect(getCollection).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('fails closed before provider work when a running crawl replay lacks its exact active attempt', async () => {
  const existingCrawl = {
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: 'scheduled-job',
    save: vi.fn(async () => undefined),
    sourceId: 'source-1',
    status: 'running',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const accounting = {
    createAttempt: vi.fn(),
    finalizeAttempt: vi.fn(),
  };

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      {
        jobAttempt: 2,
        jobId: 'scheduled-job',
        sourceCrawlAccounting: accounting as never,
        sourceCrawlId: 'crawl-existing',
      },
    ),
  ).rejects.toThrow('is owned by another active attempt');

  expect(databaseQuery).not.toHaveBeenCalled();
  expect(existingCrawl.save).not.toHaveBeenCalled();
  expect(accounting.createAttempt).not.toHaveBeenCalled();
  expect(existingCrawl).toMatchObject({ jobAttempt: 3, status: 'running' });
});

it('fails closed when a running crawl has no durable source owner', async () => {
  const existingCrawl = {
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: 'scheduled-job',
    save: vi.fn(async () => undefined),
    sourceId: '',
    status: 'running',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const accounting = {
    createAttempt: vi.fn(),
    finalizeAttempt: vi.fn(),
  };

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      {
        jobAttempt: 3,
        jobId: 'scheduled-job',
        sourceCrawlAccounting: accounting as never,
        sourceCrawlId: 'crawl-existing',
      },
    ),
  ).rejects.toThrow('belongs to a different operation');

  expect(databaseQuery).not.toHaveBeenCalled();
  expect(existingCrawl.save).not.toHaveBeenCalled();
  expect(accounting.createAttempt).not.toHaveBeenCalled();
  expect(existingCrawl).toMatchObject({ sourceId: '', status: 'running' });
});

it('fails closed before provider work for a padded stored running job binding', async () => {
  const existingCrawl = {
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: ' scheduled-job ',
    save: vi.fn(async () => undefined),
    sourceId: 'source-1',
    status: 'running',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      {
        fetchImpl,
        jobAttempt: 3,
        jobId: 'scheduled-job',
        sourceCrawlId: 'crawl-existing',
      },
    ),
  ).rejects.toThrow('belongs to a different operation');

  expect(databaseQuery).not.toHaveBeenCalled();
  expect(existingCrawl.save).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(existingCrawl).toMatchObject({ status: 'running' });
});

it('fails closed before provider work for a padded stored crawl status', async () => {
  const existingCrawl = {
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: 'scheduled-job',
    save: vi.fn(async () => undefined),
    sourceId: 'source-1',
    status: ' running ',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      {
        fetchImpl,
        jobAttempt: 3,
        jobId: 'scheduled-job',
        sourceCrawlId: 'crawl-existing',
      },
    ),
  ).rejects.toThrow('invalid non-terminal status');

  expect(databaseQuery).not.toHaveBeenCalled();
  expect(existingCrawl.save).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(existingCrawl).toMatchObject({ status: ' running ' });
});

it('resumes rather than reports success for the exact running job attempt', async () => {
  const existingCrawl = {
    attemptCount: 99,
    finishedAt: null,
    id: 'crawl-existing',
    jobAttempt: 3,
    jobId: 'scheduled-job',
    save: vi.fn(async () => undefined),
    sourceId: 'source-1',
    status: 'running',
  };
  const sourceCrawls = recordCollection([existingCrawl]);
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'SourceCrawl') return sourceCrawls;
    throw new Error(`Unexpected collection ${name}`);
  });
  const setupFailure = new Error('runner reached provider setup');
  const options = {
    jobAttempt: 3,
    jobId: 'scheduled-job',
    sourceCrawlId: 'crawl-existing',
  } as Record<string, unknown>;
  Object.defineProperty(options, 'sourceCrawlAccounting', {
    get: () => {
      throw setupFailure;
    },
  });

  await expect(
    crawlOpportunitySource(
      { id: 'source-1', name: 'Source', url: 'https://example.com/jobs' },
      options,
    ),
  ).rejects.toThrow('runner reached provider setup');

  expect(databaseQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'running'"),
    expect.arrayContaining(['scheduled-job', 'source-1', 3]),
  );
  expect(existingCrawl).toMatchObject({
    attemptCount: 99,
    jobAttempt: 3,
    status: 'failed',
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function recordCollection(records: Array<Record<string, unknown>> = []) {
  const matchesWhere = (
    record: Record<string, unknown>,
    where?: Record<string, unknown>,
  ) =>
    !where ||
    Object.entries(where).every(([key, value]) => record[key] === value);
  return {
    create: vi.fn(async (values: Record<string, unknown>) => {
      const record = {
        id: values.id ?? `record-${records.length + 1}`,
        save: vi.fn(async () => {}),
        ...values,
      };
      records.push(record);
      return record;
    }),
    get: vi.fn(async (id: string) =>
      records.find((record) => record.id === id),
    ),
    list: vi.fn(async (options?: { where?: Record<string, unknown> }) =>
      records.filter((record) => matchesWhere(record, options?.where)),
    ),
    records,
  };
}

function spiderPage(
  content: string,
  links: Link[] = [],
  url = 'https://example.com',
) {
  return {
    content,
    links,
    raw: {},
    url,
  };
}

describe('opportunity source crawler discovery', () => {
  it('refuses posting-derived and ambiguous sources at the execution boundary', async () => {
    getCollection.mockClear();
    await expect(
      crawlOpportunitySourceWithGuard({
        id: 'child-1',
        parentSourceId: 'root-1',
        sourceRole: 'posting_derived',
      }),
    ).rejects.toThrow('durable provenance');
    await expect(
      crawlOpportunitySourceWithGuard({
        id: 'legacy-unknown',
        sourceRole: 'unknown',
      }),
    ).rejects.toThrow('durable provenance');
    expect(getCollection).not.toHaveBeenCalled();
  });

  it.each([
    false,
    null,
    undefined,
  ])('refuses direct execution when activation is %s', async (isActive) => {
    getCollection.mockClear();
    await expect(
      crawlOpportunitySourceWithGuard({
        id: 'inactive-root',
        isActive,
        parentSourceId: null,
        sourceRole: 'root',
      }),
    ).rejects.toThrow('not explicitly active');
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('refuses an explicit posting-derived source in the multi-source entrypoint', async () => {
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Source') {
        return {
          get: vi.fn(async () => ({
            id: 'child-1',
            parentSourceId: 'root-1',
            sourceRole: 'posting_derived',
          })),
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    });

    await expect(
      crawlOpportunitySources({ sourceId: 'child-1' }),
    ).rejects.toThrow('durable provenance');
  });

  it('returns a terminal requested crawl without rewriting it or repeating provider work', async () => {
    const finishedAt = new Date('2026-08-31T12:00:00Z');
    const sourceCrawls = recordCollection([
      {
        attemptCount: 7,
        duplicateCount: 2,
        finishedAt,
        id: 'terminal-crawl-1',
        intelligenceEnqueuedCount: 3,
        jobAttempt: 1,
        jobId: 'job-1',
        newOpportunityCount: 4,
        save: vi.fn(async () => {}),
        skippedCount: 1,
        sourceId: 'source-1',
        status: 'completed',
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'SourceCrawl') return sourceCrawls;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        fetchImpl,
        jobAttempt: 1,
        jobId: 'job-1',
        sourceCrawlId: 'terminal-crawl-1',
      },
    );

    expect(summary).toMatchObject({
      candidates: 7,
      created: 4,
      duplicates: 2,
      intelligenceEnqueued: 3,
      skipped: 1,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sourceCrawls.records[0]).toMatchObject({
      finishedAt,
      status: 'completed',
    });
    expect(sourceCrawls.records[0].save).not.toHaveBeenCalled();
  });

  it.each([
    {
      finishedAt: new Date('2026-08-31T12:00:00Z'),
      jobAttempt: 2,
      message: 'another terminal job attempt',
      status: 'completed',
    },
    {
      finishedAt: new Date('2026-08-31T12:00:00Z'),
      jobAttempt: 1,
      message: 'unreplayable terminal state',
      status: 'failed',
    },
    {
      finishedAt: new Date('2026-08-31T12:00:00Z'),
      jobAttempt: 1,
      message: 'unreplayable terminal state',
      status: 'timed_out',
    },
    {
      finishedAt: null,
      jobAttempt: 1,
      message: 'unreplayable terminal state',
      status: 'completed',
    },
  ])('rejects an incompatible terminal replay ($status)', async ({
    finishedAt,
    jobAttempt,
    message,
    status,
  }) => {
    const sourceCrawls = recordCollection([
      {
        finishedAt,
        id: 'terminal-crawl-1',
        jobAttempt,
        jobId: 'job-1',
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status,
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'SourceCrawl') return sourceCrawls;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

    await expect(
      crawlOpportunitySource(
        {
          id: 'source-1',
          name: 'Greenhouse',
          url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
        },
        {
          fetchImpl,
          jobAttempt: 1,
          jobId: 'job-1',
          sourceCrawlId: 'terminal-crawl-1',
        },
      ),
    ).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sourceCrawls.records[0]?.save).not.toHaveBeenCalled();
  });

  it('rejects a running crawl with an invalid finished-at binding before provider work', async () => {
    const sourceCrawls = recordCollection([
      {
        finishedAt: '2026-08-31T12:00:00Z',
        id: 'running-crawl-1',
        jobAttempt: 1,
        jobId: 'job-1',
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'running',
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'SourceCrawl') return sourceCrawls;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ jobs: [] }));

    await expect(
      crawlOpportunitySource(
        {
          id: 'source-1',
          name: 'Greenhouse',
          url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
        },
        {
          fetchImpl,
          jobAttempt: 1,
          jobId: 'job-1',
          sourceCrawlId: 'running-crawl-1',
        },
      ),
    ).rejects.toThrow('invalid finished-at binding');
    expect(databaseQuery).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sourceCrawls.records[0]?.save).not.toHaveBeenCalled();
  });

  it('discovers Remote Rocketship jobs from public listing cards', async () => {
    const html = `
      <article>
        <h3 class="text-lg"><a href="/company/acme/jobs/senior-ai-platform-engineer-remote/">Senior AI Platform Engineer</a></h3>
        <div><h4><a href="/company/acme/">Acme AI</a></h4></div>
        <span>Remote - Canada</span>
      </article>
      <article>
        <h3><a href="/company/acme/jobs/senior-ai-platform-engineer-remote/">Senior AI Platform Engineer</a></h3>
      </article>
    `;
    const fetchMock = vi.fn(
      async () =>
        new Response(html, {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
    );

    const candidates = await discoverRemoteRocketshipCandidates(
      { url: 'https://www.remoterocketship.com/' },
      fetchMock,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      canonicalUrl:
        'https://www.remoterocketship.com/company/acme/jobs/senior-ai-platform-engineer-remote/',
      companyName: 'Acme AI',
      externalId: 'company/acme/jobs/senior-ai-platform-engineer-remote',
      locationNotes: 'Remote - Canada',
      postingUrl:
        'https://www.remoterocketship.com/company/acme/jobs/senior-ai-platform-engineer-remote/',
      title: 'Senior AI Platform Engineer',
      workMode: 'remote',
    });
  });

  it('detects Remote Rocketship as a first-class job board', async () => {
    await expect(
      detectJobBoard('https://www.remoterocketship.com/'),
    ).resolves.toMatchObject({
      type: 'remoterocketship',
      platformName: 'Remote Rocketship',
    });
  });

  it('discovers Oracle Careers jobs through the recruiting CE API', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions',
      );
      expect(url.searchParams.get('onlyData')).toBe('true');
      expect(url.searchParams.get('finder')).toContain('siteNumber=CX_45001');
      expect(url.searchParams.get('finder')).toContain('AI Platform');
      return jsonResponse({
        items: [
          {
            requisitionList: [
              {
                Id: '334288',
                Title: 'Principal Software Developer, AI Infrastructure',
                PostedDate: '2026-07-01',
                PrimaryLocation: 'Austin, TX, United States',
                ShortDescriptionStr:
                  'Design software programs for GPU-based AI infrastructure',
                ExternalResponsibilitiesStr:
                  'Build cloud platform systems for AI workloads.',
                secondaryLocations: [{ Name: 'United States' }],
              },
              {
                Id: '334289',
                Title: 'Marketing Manager',
                ShortDescriptionStr: 'Lead demand generation campaigns.',
              },
            ],
          },
        ],
      });
    });

    const candidates = await discoverOracleCareersCandidates(
      {
        searchQuery:
          'OCI AI OR AI Platform OR Kubernetes OR Cloud Infrastructure OR Principal Engineer',
        url: 'https://careers.oracle.com/jobs/',
      },
      fetchMock,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      canonicalUrl: 'https://careers.oracle.com/en/sites/jobsearch/job/334288',
      companyName: 'Oracle',
      externalId: '334288',
      locationNotes: 'Austin, TX, United States; United States',
      postingUrl: 'https://careers.oracle.com/en/sites/jobsearch/job/334288',
      title: 'Principal Software Developer, AI Infrastructure',
    });
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('GPU-based AI infrastructure'),
      message: 'Loaded Oracle careers posting details.',
      provider: 'generic',
      status: 'resolved',
    });
  });

  it('detects Oracle Careers as a first-class job board', async () => {
    await expect(
      detectJobBoard('https://careers.oracle.com/jobs/'),
    ).resolves.toMatchObject({
      type: 'oracle-careers',
      platformName: 'Oracle Careers',
    });
    expect(
      sourceIsCrawlable({
        isActive: true,
        url: 'https://careers.oracle.com/jobs/',
      }),
    ).toBe(true);
  });

  it('discovers Microsoft Careers jobs through the PCSX search API', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (
        url.startsWith('https://apply.careers.microsoft.com/api/pcsx/search?')
      ) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('domain')).toBe('microsoft.com');
        expect(parsed.searchParams.get('query')).toBe('AI Platform');
        return jsonResponse({
          status: 200,
          data: {
            positions: [
              {
                id: 1970393556753319,
                displayJobId: '200026495',
                name: 'Software Engineer II - AI Engineering',
                locations: ['Canada, British Columbia, Vancouver'],
                standardizedLocations: ['Vancouver, BC, CA'],
                postedTs: 1782329450,
                department: 'Software Engineering',
                workLocationOption: 'onsite',
                positionUrl: '/careers/job/1970393556753319',
              },
              {
                id: 1970393556918213,
                displayJobId: '200041913',
                name: 'Legal Counsel',
                locations: ['Korea, Seoul, Seoul'],
                department: 'Legal',
                positionUrl: '/careers/job/1970393556918213',
              },
            ],
          },
        });
      }

      expect(url).toBe(
        'https://apply.careers.microsoft.com/api/pcsx/position_details?domain=microsoft.com&position_id=1970393556753319',
      );
      return jsonResponse({
        status: 200,
        data: {
          id: 1970393556753319,
          displayJobId: '200026495',
          name: 'Software Engineer II - AI Engineering',
          locations: ['Canada, British Columbia, Vancouver'],
          standardizedLocations: ['Vancouver, BC, CA'],
          jobDescription:
            '<p>Build the data platform for the age of AI.</p><p>Use distributed systems and reliable services.</p>',
        },
      });
    });

    const candidates = await discoverMicrosoftCareersCandidates(
      {
        searchQuery: 'AI Platform',
        url: 'https://jobs.careers.microsoft.com/global/en/search',
      },
      fetchMock,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      canonicalUrl:
        'https://apply.careers.microsoft.com/careers/job/1970393556753319',
      companyName: 'Microsoft',
      externalId: '200026495',
      locationNotes: 'Vancouver, BC, CA',
      postingUrl:
        'https://apply.careers.microsoft.com/careers/job/1970393556753319',
      resolvedDetail: {
        descriptionRaw: expect.stringContaining(
          'data platform for the age of AI',
        ),
        provider: 'generic',
        status: 'resolved',
      },
      title: 'Software Engineer II - AI Engineering',
    });
  });

  it('discovers Workday jobs through the public CXS API with details', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          limit: 20,
          offset: 0,
          searchText: 'AI Platform',
        });
        return jsonResponse({
          jobPostings: [
            {
              bulletFields: ['JR2014718'],
              externalPath:
                '/job/US-CA-Santa-Clara/AI-Platform-Engineer_JR2014718-1',
              locationsText: 'US, CA, Santa Clara',
              postedOn: 'Posted 6 Days Ago',
              title: 'Senior Staff AI Platform Engineer',
            },
          ],
        });
      }

      expect(url).toBe(
        'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AI-Platform-Engineer_JR2014718-1',
      );
      return jsonResponse({
        jobPostingInfo: {
          id: '786f21bca5de100815879c3f4ac30000',
          jobDescription:
            '<p>Build AI platform infrastructure.</p><p>What we need to see:</p><ul><li>Kubernetes</li><li>Distributed systems</li></ul>',
          location: 'US, CA, Santa Clara',
          title: 'Senior Staff AI Platform Engineer',
        },
      });
    });

    const result = await discoverWorkdayCandidates(
      {
        searchQuery: 'AI Platform',
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
      },
      fetchMock,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      canonicalUrl:
        'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AI-Platform-Engineer_JR2014718-1',
      externalId: '786f21bca5de100815879c3f4ac30000',
      locationNotes: 'US, CA, Santa Clara',
      postingUrl:
        'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AI-Platform-Engineer_JR2014718-1',
      resolvedDetail: {
        descriptionRaw: expect.stringContaining('Build AI platform'),
        provider: 'workday',
        status: 'resolved',
      },
      title: 'Senior Staff AI Platform Engineer',
    });
  });

  it('keeps NVIDIA Workday OR-query candidates from being filtered before detail load', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          searchText:
            'Agentic AI OR AI Platform OR Principal Software Engineer OR Kubernetes OR Infrastructure',
        });
        return jsonResponse({
          jobPostings: [
            {
              externalPath:
                '/job/US-CA-Santa-Clara/Lead-Principal-Engineer--Enterprise-Agentic-AI-Platform_JR2013809',
              locationsText: 'US, CA, Santa Clara',
              title: 'Lead Principal Engineer, Enterprise Agentic AI Platform',
            },
            {
              externalPath:
                '/job/Israel-Tel-Aviv/Principal-Software-Engineer---Kubernetes-AI-Scheduler_JR2019815',
              locationsText: 'Israel, Tel Aviv',
              title: 'Principal Software Engineer - Kubernetes AI Scheduler',
            },
          ],
        });
      }

      return jsonResponse({
        jobPostingInfo: {
          id: url.split('_').pop()?.replace(/\W/g, ''),
          jobDescription:
            '<p>Build agentic AI platform infrastructure with Kubernetes.</p>',
          title: url.includes('Kubernetes')
            ? 'Principal Software Engineer - Kubernetes AI Scheduler'
            : 'Lead Principal Engineer, Enterprise Agentic AI Platform',
        },
      });
    });

    const result = await discoverWorkdayCandidates(
      {
        searchQuery:
          'Agentic AI OR AI Platform OR Principal Software Engineer OR Kubernetes OR Infrastructure',
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
      },
      fetchMock,
    );

    expect(result).toHaveLength(2);
    expect(result.map((candidate) => candidate.title)).toEqual([
      'Lead Principal Engineer, Enterprise Agentic AI Platform',
      'Principal Software Engineer - Kubernetes AI Scheduler',
    ]);
    expect(
      result.every(
        (candidate) => candidate.resolvedDetail?.provider === 'workday',
      ),
    ).toBe(true);
  });

  it('discovers Greenhouse jobs as canonical posting candidates with details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://c3.ai/job-description/8365468002?gh_jid=8365468002',
            content:
              '<p>Build C3 AI platform services.</p><p>Own reliable backend systems.</p>',
            first_published: '2026-05-01T12:00:00-04:00',
            id: 8365468002,
            location: { name: 'Redwood City, CA' },
            title: 'Senior Software Engineer, Platform - Data + AI (Back-End)',
          },
        ],
      }),
    );

    const candidates = await discoverGreenhouseCandidates(
      {
        url: 'https://boards.greenhouse.io/embed/job_board?for=c3iot',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/c3iot/jobs?content=true',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      canonicalUrl:
        'https://c3.ai/job-description/8365468002?gh_jid=8365468002',
      externalId: '8365468002',
      postingUrl: 'https://c3.ai/job-description/8365468002?gh_jid=8365468002',
      title: 'Senior Software Engineer, Platform - Data + AI (Back-End)',
    });
    expect(candidates[0].resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Build C3 AI platform services.'),
      status: 'resolved',
    });
  });

  it('discovers Remote.com openings as Greenhouse posting candidates', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"departments":[{"children":[{"jobs":[{"id":7747671003,"title":"CX AI and Automation Lead","absolute_url":"https://job-boards.greenhouse.io/remotecom/jobs/7747671003","location":{"name":"Remote-UK&I"},"first_published":"2026-05-26T06:45:26-04:00"}]}]}]}}}</script>
        `),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverRemoteComCandidates(
      { url: 'https://remote.com/careers' },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith('https://remote.com/openings', {
      cache: true,
      cacheExpiry: 3600000,
      timeout: 60000,
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://job-boards.greenhouse.io/remotecom/jobs/7747671003',
        externalId: '7747671003',
        locationNotes: 'Remote-UK&I',
        postingUrl:
          'https://job-boards.greenhouse.io/remotecom/jobs/7747671003',
        title: 'CX AI and Automation Lead',
        workMode: 'remote',
      }),
    ]);
  });

  it('discovers Wellfound jobs from spider-rendered listing links', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('Wellfound jobs', [
          {
            href: '/jobs/123-staff-database-reliability-engineer-dbre',
            text: 'Staff Database Reliability Engineer, DBRE',
          },
          {
            href: '/jobs/456-account-executive',
            text: 'Account Executive',
          },
          {
            href: '/company/acme/jobs/789-senior-ai-platform-engineer',
            text: 'Senior AI Platform Engineer',
          },
        ]),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverWellfoundCandidates(
      {
        searchQuery: 'founding engineer, AI engineer, platform engineer',
        url: 'https://wellfound.com/jobs',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith('https://wellfound.com/jobs', {
      cache: true,
      cacheExpiry: 3600000,
      timeout: 60000,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      canonicalUrl:
        'https://wellfound.com/jobs/123-staff-database-reliability-engineer-dbre',
      postingUrl:
        'https://wellfound.com/jobs/123-staff-database-reliability-engineer-dbre',
      resolvedDetail: {
        provider: 'generic',
        status: 'resolved',
        title: 'Staff Database Reliability Engineer, DBRE',
      },
      title: 'Staff Database Reliability Engineer, DBRE',
    });
    expect(candidates[1]).toMatchObject({
      canonicalUrl:
        'https://wellfound.com/company/acme/jobs/789-senior-ai-platform-engineer',
      title: 'Senior AI Platform Engineer',
    });
  });

  it('discovers Ashby board jobs as direct job detail URLs', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <script>
            window.__DATA__ = {"jobPostings":[{"id":"479fd076-585f-4662-8a6e-ad8d2c2823a1","title":"Staff Software Engineer – Agentic AI Products","employmentType":"FullTime","locationName":"Waterloo","publishedDate":"2026-04-15","workplaceType":"Remote"}]};
          </script>
        `),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverAshbyCandidates(
      {
        url: 'https://jobs.ashbyhq.com/redcan',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith(
      'https://jobs.ashbyhq.com/redcan',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
        employmentType: 'full_time',
        externalId: '479fd076-585f-4662-8a6e-ad8d2c2823a1',
        postingUrl:
          'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
        title: 'Staff Software Engineer – Agentic AI Products',
        workMode: 'remote',
      }),
    ]);
  });

  it('discovers direct Ashby posting API sources without spider rendering', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('should not render direct API sources'),
      ),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            descriptionHtml:
              '<p>Build automation and AI platform infrastructure.</p>',
            employmentType: 'FullTime',
            id: '03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
            isRemote: true,
            location: 'NAMER',
            publishedAt: '2026-04-22T15:41:06.460+00:00',
            title: 'Sales Engineer, Enterprise',
          },
        ],
      }),
    );

    const candidates = await discoverAshbyCandidates(
      { url: 'https://api.ashbyhq.com/posting-api/job-board/zapier' },
      spider,
      fetchMock,
    );

    expect(spider.fetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ashbyhq.com/posting-api/job-board/zapier',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/zapier/03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        employmentType: 'full_time',
        externalId: '03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        locationNotes: 'NAMER',
        postingUrl:
          'https://jobs.ashbyhq.com/zapier/03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        title: 'Sales Engineer, Enterprise',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('automation and AI platform'),
      provider: 'ashby',
      status: 'resolved',
    });
  });

  it('threads injected fetch through the Ashby registry adapter', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('should not render direct API sources'),
      ),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            id: '9f7c4102-a0e8-4a2a-9cff-cdd6f57a3c2a',
            isRemote: true,
            title: 'Staff Software Engineer, Automation Platform',
          },
        ],
      }),
    );

    const candidates = await discoverOpportunityCandidates(
      {
        searchQuery: 'AI OR automation OR platform engineer',
        url: 'https://api.ashbyhq.com/posting-api/job-board/zapier',
      },
      { fetchImpl: fetchMock, spider },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ashbyhq.com/posting-api/job-board/zapier',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      externalId: '9f7c4102-a0e8-4a2a-9cff-cdd6f57a3c2a',
      title: 'Staff Software Engineer, Automation Platform',
    });
  });

  it('falls back to direct Ashby board HTML when spider content omits the SSR payload', async () => {
    const spider = {
      fetch: vi.fn(async () => spiderPage('Rendered board without app data')),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '<script>window.__DATA__ = {"jobPostings":[{"id":"6ee07995-2738-4cee-b16d-fc8967674346","title":"Senior Growth Engineer","employmentType":"FullTime","locationName":"Remote","publishedDate":"2026-05-26","workplaceType":"Remote"}]};</script>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        ),
    );

    const candidates = await discoverAshbyCandidates(
      { url: 'https://jobs.ashbyhq.com/buffer' },
      spider,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://jobs.ashbyhq.com/buffer',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'text/html,application/xhtml+xml',
        }),
      }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/buffer/6ee07995-2738-4cee-b16d-fc8967674346',
        locationNotes: 'Remote',
        postingUrl:
          'https://jobs.ashbyhq.com/buffer/6ee07995-2738-4cee-b16d-fc8967674346',
        title: 'Senior Growth Engineer',
        workMode: 'remote',
      }),
    ]);
  });

  it('falls back to direct Ashby board HTML when spider rendering fails', async () => {
    const spider = {
      fetch: vi.fn(async () => {
        throw new Error('crawl4ai unavailable');
      }),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '<script>window.__DATA__ = {"jobPostings":[{"id":"1767482d-de23-460c-80eb-6d0a3caa72ab","title":"Staff Engineer, Backend, Revenue","employmentType":"FullTime","locationName":"NAMER","publishedDate":"2026-06-25","workplaceType":"Remote"}]};</script>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        ),
    );

    const candidates = await discoverAshbyCandidates(
      { url: 'https://jobs.ashbyhq.com/Deel' },
      spider,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://jobs.ashbyhq.com/Deel',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'text/html,application/xhtml+xml',
        }),
      }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/Deel/1767482d-de23-460c-80eb-6d0a3caa72ab',
        employmentType: 'full_time',
        postingUrl:
          'https://jobs.ashbyhq.com/Deel/1767482d-de23-460c-80eb-6d0a3caa72ab',
        title: 'Staff Engineer, Backend, Revenue',
        workMode: 'remote',
      }),
    ]);
  });

  it('discovers Gemini careers jobs from the embedded Next payload', async () => {
    const html = String.raw`<script>self.__next_f.push([1,"{\"departments\":[{\"name\":\"Software Engineering\",\"jobs\":[{\"jobId\":7985650,\"jobBaseUrl\":\"/jobs/staff-software-engineer-trading-systems-posttrade-data\",\"jobUrl\":\"/jobs/staff-software-engineer-trading-systems-posttrade-data?gh_jid=7985650\",\"jobTitle\":\"Staff Software Engineer, Trading Systems (Post-Trade Data)\",\"jobLocation\":\"Singapore, Singapore\"},{\"jobId\":7905022,\"jobBaseUrl\":\"/jobs/head-of-compliance\",\"jobUrl\":\"/jobs/head-of-compliance?gh_jid=7905022\",\"jobTitle\":\"Head of Compliance\",\"jobLocation\":\"New York, New York\"}]}]}"])</script>`;
    const fetchMock = vi.fn(
      async () =>
        new Response(html, {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
    );

    const candidates = await discoverGeminiCareersCandidates(
      {
        searchQuery: 'backend OR platform OR security OR infrastructure OR AI',
        url: 'https://www.gemini.com/careers',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.gemini.com/careers',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'text/html,application/xhtml+xml',
        }),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      canonicalUrl:
        'https://www.gemini.com/jobs/staff-software-engineer-trading-systems-posttrade-data?gh_jid=7985650',
      companyName: 'Gemini',
      externalId: '7985650',
      locationNotes: 'Singapore, Singapore',
      postingUrl:
        'https://www.gemini.com/jobs/staff-software-engineer-trading-systems-posttrade-data?gh_jid=7985650',
      title: 'Staff Software Engineer, Trading Systems (Post-Trade Data)',
    });
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      message: 'Loaded Gemini careers posting from embedded careers payload.',
      status: 'resolved',
    });
  });

  it('discovers Canonical careers vacancies from the embedded vacancies payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `
        <script>
          const vacancies = [{"date":"2026-04-01T05:51:31-04:00","departments":["Engineering"],"description":"Help partners architect and implement Ubuntu solutions, maintaining awareness of Kubernetes, storage, AI and MLOps.","employment":"Full-time","id":3433732,"location":"Home based - Worldwide","skills":["Technologist","Problem Solver"],"title":"Alliances Field Engineer","url":"https://job-boards.greenhouse.io/canonical/jobs/3433732"}];
        </script>
      `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        ),
    );

    const candidates = await discoverCanonicalCandidates(
      { url: 'https://canonical.com/careers/all' },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://canonical.com/careers/all',
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl: 'https://job-boards.greenhouse.io/canonical/jobs/3433732',
        companyName: 'Canonical',
        employmentType: 'full_time',
        externalId: '3433732',
        locationNotes: 'Home based - Worldwide',
        postingUrl: 'https://job-boards.greenhouse.io/canonical/jobs/3433732',
        title: 'Alliances Field Engineer',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Kubernetes'),
      provider: 'generic',
      qualifications: 'Technologist\nProblem Solver',
      status: 'resolved',
    });
  });

  it('discovers Amazon Jobs postings from the public search API with resolved details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            basic_qualifications:
              '- 5+ years building distributed systems<br/>- Experience with Kubernetes',
            company_name: 'Amazon Web Services, Inc.',
            description:
              'Build AI infrastructure platforms for Bedrock and agentic workloads.',
            id: '3013377',
            id_icims: '10378845',
            job_path:
              '/en/jobs/3013377/sr-software-dev-engineer-redshift-distributed-systems',
            job_schedule_type: 'Full-Time',
            normalized_location: 'East Palo Alto, California, USA',
            posted_date: '2026-06-26',
            preferred_qualifications: '- Experience with platform engineering',
            title: 'Sr. Software Dev Engineer, Redshift Distributed Systems',
          },
        ],
      }),
    );

    const candidates = await discoverAmazonJobsCandidates(
      {
        searchQuery:
          'AI Platform OR Bedrock OR Principal Engineer OR Kubernetes OR DevOps OR distributed systems',
        url: 'https://www.amazon.jobs/en/search',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.amazon.jobs/en/search.json?base_query=AI+Platform+OR+Bedrock+OR+Principal+Engineer+OR+Kubernetes+OR+DevOps+OR+distributed+systems&offset=0&result_limit=50&sort=relevant',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://www.amazon.jobs/en/jobs/3013377/sr-software-dev-engineer-redshift-distributed-systems',
        companyName: 'Amazon Web Services, Inc.',
        externalId: '10378845',
        locationNotes: 'East Palo Alto, California, USA',
        postingUrl:
          'https://www.amazon.jobs/en/jobs/3013377/sr-software-dev-engineer-redshift-distributed-systems',
        title: 'Sr. Software Dev Engineer, Redshift Distributed Systems',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Build AI infrastructure'),
      provider: 'generic',
      qualifications: expect.stringContaining('Kubernetes'),
      status: 'resolved',
    });
  });

  it('discovers AI Jobs.net postings from the public index', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `
        <div class="job">
          <a href="/job/ai-platform-engineer-remote-200475/" target="_blank">
            <span>Featured</span>
            AI Platform Engineer
          </a>
          <span>USD 120K-180K</span> | <span>Remote</span>
        </div>
        <div class="job">
          <a href="/job/payroll-coordinator-200476/" target="_blank">
            Payroll Coordinator
          </a>
          <span>Policy Org</span> | <span>Washington, DC</span>
        </div>
      `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        ),
    );

    const candidates = await discoverAiJobsCandidates(
      {
        searchQuery: 'AI Platform',
        url: 'https://ai-jobs.net/',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://ai-jobs.net/', {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://ai-jobs.net/job/ai-platform-engineer-remote-200475/',
        companyName: '',
        postingUrl:
          'https://ai-jobs.net/job/ai-platform-engineer-remote-200475/',
        title: 'AI Platform Engineer',
      }),
    ]);
  });

  it('discovers Remote OK postings from the public API with resolved details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { last_updated: 1782518404 },
        {
          company: 'Platform Labs',
          date: '2026-06-26T12:00:00+00:00',
          description:
            '<p>Build Kubernetes automation for AI infrastructure.</p><ul><li>TypeScript</li><li>Kubernetes</li></ul>',
          id: '1134001',
          location: 'Worldwide',
          position: 'Senior Platform Engineer, AI Infrastructure',
          salary_max: 220000,
          salary_min: 160000,
          slug: 'remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
          tags: ['devops', 'kubernetes', 'ai'],
          url: 'https://remoteok.com/remote-jobs/remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
        },
        {
          company: 'Ops Co',
          description:
            '<p>Keep office data synchronized with automation workflows.</p>',
          id: '1134002',
          position: 'Data Entry Clerk',
          slug: 'remote-data-entry-clerk-ops-co-1134002',
          tags: ['data'],
        },
      ]),
    );

    const candidates = await discoverRemoteOkCandidates(
      {
        searchQuery:
          'AI engineer, platform engineer, devops, Kubernetes, full-stack, remote',
        url: 'https://remoteok.com/remote-dev+ai+devops-jobs',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://remoteok.com/remote-dev+ai+devops-jobs.json',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://remoteok.com/remote-jobs/remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
        companyName: 'Platform Labs',
        externalId: '1134001',
        locationNotes: 'Worldwide',
        postingUrl:
          'https://remoteok.com/remote-jobs/remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
        title: 'Senior Platform Engineer, AI Infrastructure',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      currency: 'USD',
      descriptionRaw: expect.stringContaining('Build Kubernetes automation'),
      provider: 'generic',
      salaryMax: 220000,
      salaryMin: 160000,
      status: 'resolved',
    });
  });

  it('falls back to the global Remote OK API for bare Remote OK sources', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ last_updated: 1782518404 }]),
    );

    await discoverRemoteOkCandidates(
      {
        searchQuery: 'AI engineer, platform engineer, devops, Kubernetes',
        url: 'https://remoteok.com/',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://remoteok.com/api', {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Iolaus source crawler',
      },
    });
  });

  it('discovers LinkedIn public job cards', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `
        <ul>
          <li>
            <div class="base-card job-search-card">
              <a href="https://www.linkedin.com/jobs/view/senior-ai-platform-engineer-at-agentic-systems-inc-4242424242?trk=public_jobs_jserp-result_search-card"></a>
              <h3 class="base-search-card__title">Senior AI Platform Engineer</h3>
              <h4 class="base-search-card__subtitle">
                <a href="https://www.linkedin.com/company/agentic-systems/">Agentic Systems Inc</a>
              </h4>
              <span class="job-search-card__location">Canada Remote</span>
              <time datetime="2026-06-29"></time>
            </div>
          </li>
          <li>
            <div class="base-card job-search-card">
              <a href="https://www.linkedin.com/jobs/view/5252525252/"></a>
              <h3 class="base-search-card__title">Account Executive</h3>
              <h4 class="base-search-card__subtitle">Sales Co</h4>
            </div>
          </li>
        </ul>
      `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        ),
    );

    const candidates = await discoverLinkedInCandidates(
      {
        searchQuery: 'AI platform engineer agentic remote Canada',
        url: 'https://www.linkedin.com/jobs/',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.linkedin.com/jobs/search/?keywords=AI+platform+engineer+agentic+remote+Canada',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/html,application/xhtml+xml',
        }),
      }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl: 'https://www.linkedin.com/jobs/view/4242424242/',
        companyLinkedinUrl: 'https://www.linkedin.com/company/agentic-systems/',
        companyName: 'Agentic Systems Inc',
        externalId: '4242424242',
        locationNotes: 'Canada Remote',
        postingUrl:
          'https://www.linkedin.com/jobs/view/senior-ai-platform-engineer-at-agentic-systems-inc-4242424242?trk=public_jobs_jserp-result_search-card',
        title: 'Senior AI Platform Engineer',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      canonicalUrl: 'https://www.linkedin.com/jobs/view/4242424242/',
      descriptionRaw: expect.stringContaining('Agentic Systems Inc'),
      externalId: '4242424242',
      locationNotes: 'Canada Remote',
      provider: 'generic',
      status: 'resolved',
      title: 'Senior AI Platform Engineer',
      workMode: 'remote',
    });
  });

  it('saves relisted LinkedIn opportunities against the company root posting', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const companies = recordCollection();
    const sources = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Company') return companies;
      if (name === 'Opportunity') return opportunities;
      if (name === 'Source') return sources;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const linkedinPostingUrl =
      'https://www.linkedin.com/jobs/view/senior-ai-platform-engineer-at-agentic-systems-inc-4242424242?trk=public_jobs_jserp-result_search-card';
    const rootPostingUrl =
      'https://agentic.example/careers/staff-ai-platform-engineer';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://www.linkedin.com/jobs/search/')) {
        return new Response(
          `
            <ul>
              <li>
                <div class="base-card job-search-card">
                  <a href="${linkedinPostingUrl}"></a>
                  <h3 class="base-search-card__title">Senior AI Platform Engineer</h3>
                  <h4 class="base-search-card__subtitle">
                    <a href="https://www.linkedin.com/company/agentic-systems/">Agentic Systems Inc</a>
                  </h4>
                  <span class="job-search-card__location">Canada Remote</span>
                </div>
              </li>
            </ul>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url.startsWith('https://www.linkedin.com/jobs/view/')) {
        return new Response(
          `
            <a href="${rootPostingUrl}">Apply on company site</a>
            <a href="https://www.linkedin.com/company/agentic-systems/">Agentic Systems Inc</a>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === rootPostingUrl) {
        return new Response(
          `
            <html>
              <head>
                <link rel="canonical" href="${rootPostingUrl}">
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "JobPosting",
                    "title": "Senior AI Platform Engineer",
                    "description": "Build agentic AI platform systems for remote infrastructure teams.",
                    "datePosted": "2026-06-29",
                    "employmentType": "FULL_TIME",
                    "jobLocationType": "TELECOMMUTE",
                    "hiringOrganization": {"name": "Agentic Systems Inc"}
                  }
                </script>
              </head>
              <body><main>Senior AI Platform Engineer</main></body>
            </html>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === 'https://www.linkedin.com/company/agentic-systems/') {
        return new Response(
          '<a href="https://agentic.example/">Company website</a>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === 'https://agentic.example/') {
        return new Response('<a href="/careers">Careers</a>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });
      }
      if (url === 'https://agentic.example/careers') {
        return new Response(
          '<main><h1>Careers</h1><p>Open positions for platform engineers.</p></main>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'LinkedIn public search',
        searchQuery: 'AI platform engineer agentic remote Canada',
        url: 'https://www.linkedin.com/jobs/',
      },
      { fetchImpl: fetchMock, intelligenceEnqueueCap: 0 },
    );

    expect(summary).toMatchObject({
      candidates: 1,
      created: 1,
      errors: [],
      skipped: 0,
    });
    expect(companies.records).toHaveLength(1);
    expect(companies.records[0]).toMatchObject({
      careersUrl: 'https://agentic.example/careers',
      companyKey: 'agentic-systems-inc',
      linkedinUrl: 'https://www.linkedin.com/company/agentic-systems/',
      name: 'Agentic Systems Inc',
      researchStatus: 'partial',
      websiteUrl: 'https://agentic.example/',
    });
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      accountNotes: 'Auto-added from opportunity root posting discovery.',
      accountStatus: 'none_needed',
      isActive: false,
      name: 'Agentic Systems Inc careers',
      parentSourceId: 'source-1',
      sourceRole: 'posting_derived',
      type: 'company_careers',
      url: 'https://agentic.example/careers',
    });
    expect(opportunities.records[0]).toMatchObject({
      applyMethod: 'company_site',
      applyUrl: rootPostingUrl,
      canonicalUrl: rootPostingUrl,
      companyId: companies.records[0].id,
      postingUrl: rootPostingUrl,
      sourceId: 'source-1',
      title: 'Senior AI Platform Engineer',
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      canonicalUrl: rootPostingUrl,
      opportunityId: opportunities.records[0].id,
      postingUrl: linkedinPostingUrl,
      status: 'created_opportunity',
    });
  });

  it('dedupes relisting aliases by the resolved root posting URL', async () => {
    getCollection.mockReset();
    const rootPostingUrl =
      'https://agentic.example/careers/staff-ai-platform-engineer';
    const opportunities = recordCollection([
      {
        canonicalUrl: rootPostingUrl,
        id: 'existing-opportunity',
        postingUrl: rootPostingUrl,
        save: vi.fn(async () => {}),
        sourceId: 'company-careers-source',
      },
    ]);
    const companies = recordCollection();
    const sources = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Company') return companies;
      if (name === 'Opportunity') return opportunities;
      if (name === 'Source') return sources;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const linkedinPostingUrl =
      'https://www.linkedin.com/jobs/view/senior-ai-platform-engineer-at-agentic-systems-inc-4242424242';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://www.linkedin.com/jobs/search/')) {
        return new Response(
          `
            <ul>
              <li>
                <div class="base-card job-search-card">
                  <a href="${linkedinPostingUrl}"></a>
                  <h3 class="base-search-card__title">Senior AI Platform Engineer</h3>
                  <h4 class="base-search-card__subtitle">Agentic Systems Inc</h4>
                  <span class="job-search-card__location">Canada Remote</span>
                </div>
              </li>
            </ul>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url.startsWith('https://www.linkedin.com/jobs/view/')) {
        return new Response(
          `<a href="${rootPostingUrl}">Apply on company site</a>`,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === rootPostingUrl) {
        return new Response(
          `
            <link rel="canonical" href="${rootPostingUrl}">
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "JobPosting",
                "title": "Senior AI Platform Engineer",
                "description": "Build agentic AI platform systems.",
                "jobLocationType": "TELECOMMUTE"
              }
            </script>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === 'https://agentic.example/') {
        return new Response('<a href="/careers">Careers</a>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });
      }
      if (url === 'https://agentic.example/careers') {
        return new Response('<main>Careers and open roles</main>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'LinkedIn public search',
        searchQuery: 'AI platform engineer remote Canada',
        url: 'https://www.linkedin.com/jobs/',
      },
      { fetchImpl: fetchMock, intelligenceEnqueueCap: 0 },
    );

    expect(opportunities.create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      candidates: 1,
      created: 0,
      duplicates: 0,
      relisted: 1,
      skipped: 0,
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      canonicalUrl: rootPostingUrl,
      opportunityId: 'existing-opportunity',
      postingUrl: linkedinPostingUrl,
      status: 'updated_opportunity',
    });
  });

  it('serializes concurrent global identity decisions into one created and one reused opportunity', async () => {
    getCollection.mockReset();
    const locked = new Set<string>();
    const waiters = new Map<string, Array<() => void>>();
    databaseSessionFactory.mockImplementation(
      async () =>
        ({
          query: vi.fn(async (sql: string, parameters?: unknown[]) => {
            const key = String(parameters?.[0] ?? '');
            if (sql.includes('pg_advisory_lock')) {
              if (locked.has(key)) {
                await new Promise<void>((resolve) => {
                  const pending = waiters.get(key) ?? [];
                  pending.push(resolve);
                  waiters.set(key, pending);
                });
              }
              locked.add(key);
            } else if (sql.includes('pg_advisory_unlock')) {
              locked.delete(key);
              waiters.get(key)?.shift()?.();
            }
            return { rows: [] };
          }),
          release: vi.fn(async () => {}),
        }) as never,
    );
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/global-dedupe',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Global Dedupe Engineer',
          },
        ],
      }),
    );
    const source = {
      id: 'source-1',
      name: 'Greenhouse',
      searchQuery: 'agentic platform',
      url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
    };

    const summaries = await Promise.all([
      crawlOpportunitySource(source, {
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 0,
      }),
      crawlOpportunitySource(source, {
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 0,
      }),
    ]);

    expect(opportunities.records).toHaveLength(1);
    expect(
      summaries.map(({ created, reused }) => ({ created, reused })),
    ).toEqual(
      expect.arrayContaining([
        { created: 1, reused: 0 },
        { created: 0, reused: 1 },
      ]),
    );
    expect(sourceCrawlItems.records).toHaveLength(2);
    expect(sourceCrawlItems.records.map((item) => item.outcome).sort()).toEqual(
      ['created', 'reused'],
    );
  });

  it('inserts distinct opportunities for distinct URLs that share a title', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/platform-engineer-1',
            content: '<p>Build agentic platform systems.</p>',
            id: 101,
            location: { name: 'Remote' },
            title: 'Platform Engineer',
          },
          {
            absolute_url: 'https://example.com/jobs/platform-engineer-2',
            content: '<p>Build a second agentic platform.</p>',
            id: 102,
            location: { name: 'Remote' },
            title: 'Platform Engineer',
          },
        ],
      }),
    );

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      { fetchImpl: fetchMock, intelligenceEnqueueCap: 0 },
    );

    expect(summary.created).toBe(2);
    expect(opportunities.records).toHaveLength(2);
    expect(opportunities.records.map((record) => record.id)).toHaveLength(2);
    expect(new Set(opportunities.records.map((record) => record.id)).size).toBe(
      2,
    );
    expect(
      opportunities.records.every(
        (record) =>
          record._insertOnly === true &&
          record.slug === `crawl-opportunity-${record.id}`,
      ),
    ).toBe(true);
  });

  it('records unresolved relistings without creating opportunities', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const companies = recordCollection();
    const sources = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Company') return companies;
      if (name === 'Opportunity') return opportunities;
      if (name === 'Source') return sources;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const linkedinPostingUrl =
      'https://www.linkedin.com/jobs/view/staff-platform-engineer-at-agentic-systems-inc-4343434343';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://www.linkedin.com/jobs/search/')) {
        return new Response(
          `
            <ul>
              <li>
                <div class="base-card job-search-card">
                  <a href="${linkedinPostingUrl}"></a>
                  <h3 class="base-search-card__title">Staff Platform Engineer</h3>
                  <h4 class="base-search-card__subtitle">
                    <a href="https://www.linkedin.com/company/agentic-systems/">Agentic Systems Inc</a>
                  </h4>
                  <span class="job-search-card__location">Canada Remote</span>
                </div>
              </li>
            </ul>
          `,
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url.startsWith('https://www.linkedin.com/jobs/view/')) {
        return new Response(
          '<a href="https://www.linkedin.com/company/agentic-systems/">Agentic Systems Inc</a>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === 'https://www.linkedin.com/company/agentic-systems/') {
        return new Response(
          '<a href="https://agentic.example/">Company website</a>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      if (url === 'https://agentic.example/') {
        return new Response('<a href="/careers">Careers</a>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });
      }
      if (url === 'https://agentic.example/careers') {
        return new Response(
          '<main><h1>Careers</h1><p>Open roles for platform engineers.</p></main>',
          { headers: { 'content-type': 'text/html' }, status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'LinkedIn public search',
        searchQuery: 'platform engineer remote Canada',
        url: 'https://www.linkedin.com/jobs/',
      },
      { fetchImpl: fetchMock, intelligenceEnqueueCap: 0 },
    );

    expect(summary).toMatchObject({
      candidates: 1,
      created: 0,
      skipped: 1,
    });
    expect(opportunities.records).toHaveLength(0);
    expect(companies.records[0]).toMatchObject({
      careersUrl: 'https://agentic.example/careers',
      companyKey: 'agentic-systems-inc',
    });
    expect(sources.records[0]).toMatchObject({
      type: 'company_careers',
      url: 'https://agentic.example/careers',
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      canonicalUrl: 'https://www.linkedin.com/jobs/view/4343434343/',
      postingUrl: linkedinPostingUrl,
      reconciliationStatus: 'unmatched',
      status: 'skipped_relist_unresolved',
    });
  });

  it('resolves non-LinkedIn relisting apply URLs to employer root postings', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '{"thirdPartyApplyUrl":"https:\\/\\/agentic.example\\/careers\\/staff-ai-platform-engineer"}',
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
    );

    const resolution = await resolveRootPosting(
      {
        companyName: 'Agentic Systems Inc',
        postingUrl: 'https://www.indeed.com/viewjob?jk=424242',
        title: 'Staff AI Platform Engineer',
      },
      fetchMock,
    );

    expect(resolution).toMatchObject({
      aliasKind: 'relist',
      discoveredUrl: 'https://www.indeed.com/viewjob?jk=424242',
      resolutionStatus: 'resolved_root',
      rootPostingUrl:
        'https://agentic.example/careers/staff-ai-platform-engineer',
    });
    expect(resolution.candidate).toMatchObject({
      canonicalUrl:
        'https://agentic.example/careers/staff-ai-platform-engineer',
      postingUrl: 'https://agentic.example/careers/staff-ai-platform-engineer',
      rootPostingUrl:
        'https://agentic.example/careers/staff-ai-platform-engineer',
    });
  });

  it('discovers Freelancer projects from the public API with resolved details', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          result: {
            projects: [
              {
                description: 'Edit a short social media video.',
                id: 40540002,
                jobs: [{ name: 'Video Editing' }],
                seo_url: 'video-editing/Edit-short-social-video',
                title: 'Edit short social video',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          result: {
            projects: [
              {
                budget: { maximum: 7500, minimum: 3000 },
                currency: { code: 'USD' },
                description:
                  'Build a Kubernetes automation platform for AI deployment workflows.',
                id: 40540001,
                jobs: [
                  { name: 'Kubernetes' },
                  { name: 'Python' },
                  { name: 'Artificial Intelligence' },
                ],
                seo_url: 'python/Build-Kubernetes-AI-automation-platform',
                submitdate: 1782763756,
                title: 'Build Kubernetes AI automation platform',
                type: 'fixed',
              },
            ],
          },
        }),
      )
      .mockImplementation(() =>
        jsonResponse({ status: 'success', result: { projects: [] } }),
      );

    const candidates = await discoverFreelancerCandidates(
      {
        searchQuery:
          'AI engineer OR Kubernetes OR platform engineer OR automation OR full stack',
        url: 'https://www.freelancer.com/jobs/',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://www.freelancer.com/api/projects/0.1/projects/active/?limit=10&full_description=true&job_details=true&query=AI+engineer',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://www.freelancer.com/api/projects/0.1/projects/active/?limit=10&full_description=true&job_details=true&query=Kubernetes',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://www.freelancer.com/projects/python/Build-Kubernetes-AI-automation-platform',
        employmentType: 'contract',
        externalId: '40540001',
        locationNotes: 'Remote',
        postingUrl:
          'https://www.freelancer.com/projects/python/Build-Kubernetes-AI-automation-platform',
        title: 'Build Kubernetes AI automation platform',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      currency: 'USD',
      descriptionRaw: expect.stringContaining('Kubernetes automation platform'),
      provider: 'freelancer',
      requiredSkills: 'Kubernetes, Python, Artificial Intelligence',
      salaryMax: 7500,
      salaryMin: 3000,
      status: 'resolved',
    });
  });

  it('caps Freelancer OR-query discovery to a small global batch', async () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({
      description:
        'Build a Kubernetes automation platform for AI deployment workflows.',
      id: 40550000 + index,
      jobs: [{ name: 'Kubernetes' }, { name: 'Artificial Intelligence' }],
      seo_url: `python/freelancer-platform-${index}`,
      title: `Build Kubernetes AI platform ${index}`,
    }));
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'success', result: { projects } }),
    );

    const candidates = await discoverFreelancerCandidates(
      {
        searchQuery:
          'AI engineer OR Kubernetes OR platform engineer OR automation OR full stack',
        url: 'https://www.freelancer.com/jobs/',
      },
      fetchMock,
    );

    expect(candidates).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(candidates.at(-1)?.postingUrl).toBe(
      'https://www.freelancer.com/projects/python/freelancer-platform-9',
    );
  });

  it('discovers Remotive postings from the public API with resolved details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            candidate_required_location: 'USA, Canada',
            category: 'Software Development',
            company_name: 'Platform Labs',
            description:
              '<p>Build AI platform automation and Kubernetes workflows.</p><ul><li>TypeScript</li><li>Kubernetes</li></ul>',
            id: 2092001,
            job_type: 'full_time',
            publication_date: '2026-06-26T14:55:18',
            tags: ['ai', 'kubernetes', 'typescript'],
            title: 'Senior Platform Engineer, AI Infrastructure',
            url: 'https://remotive.com/remote-jobs/software-dev/senior-platform-engineer-ai-infrastructure-2092001',
          },
          {
            candidate_required_location: 'USA',
            category: 'Sales',
            company_name: 'Ops Co',
            description: '<p>Update CRM records and coordinate onboarding.</p>',
            id: 2092002,
            tags: ['crm'],
            title: 'Sales Assistant',
            url: 'https://remotive.com/remote-jobs/sales/sales-assistant-2092002',
          },
        ],
      }),
    );

    const candidates = await discoverRemotiveCandidates(
      {
        searchQuery:
          'AI engineer, platform engineer, devops, Kubernetes, remote',
        url: 'https://remotive.com/remote-jobs/software-dev',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://remotive.com/api/remote-jobs',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://remotive.com/remote-jobs/software-dev/senior-platform-engineer-ai-infrastructure-2092001',
        companyName: 'Platform Labs',
        externalId: '2092001',
        locationNotes: 'USA, Canada',
        postingUrl:
          'https://remotive.com/remote-jobs/software-dev/senior-platform-engineer-ai-infrastructure-2092001',
        title: 'Senior Platform Engineer, AI Infrastructure',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Build AI platform automation'),
      employmentType: 'full_time',
      provider: 'generic',
      status: 'resolved',
    });
  });

  it('discovers Working Nomads postings from the public API with resolved details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          category_name: 'Development',
          company_name: 'Nomad AI',
          description:
            '<p>Build AI platform automation and Kubernetes workflows.</p><ul><li>TypeScript</li><li>Kubernetes</li></ul>',
          location: 'Europe, North America, Latin America, APAC',
          pub_date: '2026-06-25T11:03:18-04:00',
          tags: 'ai,kubernetes,typescript,software engineering',
          title: 'Senior Platform Engineer, AI Infrastructure',
          url: 'https://www.workingnomads.com/job/go/1691057/',
        },
        {
          category_name: 'Marketing',
          company_name: 'Growth Co',
          description: '<p>Run paid acquisition experiments.</p>',
          location: 'Worldwide',
          tags: 'marketing,advertising',
          title: 'Performance Marketer',
          url: 'https://www.workingnomads.com/job/go/1691058/',
        },
      ]),
    );

    const candidates = await discoverWorkingNomadsCandidates(
      {
        searchQuery:
          'software development, AI, devops, sysadmin, platform, Kubernetes',
        url: 'https://www.workingnomads.com/jobs',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.workingnomads.com/api/exposed_jobs/',
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl: 'https://www.workingnomads.com/job/go/1691057/',
        companyName: 'Nomad AI',
        externalId: '1691057',
        locationNotes: 'Europe, North America, Latin America, APAC',
        postingUrl: 'https://www.workingnomads.com/job/go/1691057/',
        title: 'Senior Platform Engineer, AI Infrastructure',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Build AI platform automation'),
      provider: 'generic',
      requiredSkills: 'ai,kubernetes,typescript,software engineering',
      status: 'resolved',
    });
  });

  it('discovers We Work Remotely postings from the category RSS feed with resolved details', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(`
        <rss><channel>
          <item>
            <title>Platform Labs: Senior Platform Engineer</title>
            <region>Anywhere in the World</region>
            <category>Full-Stack Programming</category>
            <link>https://weworkremotely.com/remote-jobs/platform-labs-senior-platform-engineer</link>
            <description>&amp;lt;p&amp;gt;Build AI platform tooling and Kubernetes automation.&amp;lt;/p&amp;gt;&amp;lt;strong&amp;gt;Requirements&amp;lt;/strong&amp;gt;&amp;lt;p&amp;gt;Kubernetes experience.&amp;lt;/p&amp;gt;</description>
          </item>
          <item>
            <title>Ops Co: Data Entry Clerk</title>
            <region>USA Only</region>
            <category>Customer Support</category>
            <link>https://weworkremotely.com/remote-jobs/ops-co-data-entry-clerk</link>
            <description>&amp;lt;p&amp;gt;Keep office records updated.&amp;lt;/p&amp;gt;</description>
          </item>
        </channel></rss>
      `),
    );

    const candidates = await discoverWeWorkRemotelyCandidates(
      {
        searchQuery:
          'AI engineer, platform engineer, devops, Kubernetes, remote',
        url: 'https://weworkremotely.com/categories/remote-programming-jobs',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://weworkremotely.com/categories/remote-programming-jobs',
      {
        headers: {
          Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
          'User-Agent': 'Iolaus source crawler',
        },
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://weworkremotely.com/remote-jobs/platform-labs-senior-platform-engineer',
        companyName: 'Platform Labs',
        locationNotes: 'Anywhere in the World',
        postingUrl:
          'https://weworkremotely.com/remote-jobs/platform-labs-senior-platform-engineer',
        title: 'Senior Platform Engineer',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('Build AI platform tooling'),
      provider: 'generic',
      status: 'resolved',
    });
  });

  it('discovers Hacker News Jobs provider links without YC board navigation noise', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('', [
          {
            href: 'https://www.ycombinator.com/jobs',
            text: 'ycombinator.com/jobs',
          },
          {
            href: 'https://www.ycombinator.com/companies/reflex/jobs',
            text: 'Reflex (YC W23) Is Hiring SWEs, Growth, and GTM Roles',
          },
          {
            href: 'https://www.ycombinator.com/companies/proliferate/jobs/L3copvK-founding-engineer',
            text: 'Proliferate (YC S25) is hiring to build open source Codex',
          },
          {
            href: 'https://jobs.ashbyhq.com/charge-robotics',
            rel: 'nofollow',
            text: 'Charge Robotics (YC S21) Is Hiring Software and Hardware Engineers',
          },
          {
            href: 'https://www.ycombinator.com/apply/',
            text: 'Apply to YC',
          },
        ]),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverHackerNewsJobsCandidates(
      { url: 'https://news.ycombinator.com/jobs' },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith(
      'https://news.ycombinator.com/jobs',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://www.ycombinator.com/companies/proliferate/jobs/L3copvK-founding-engineer',
        title: 'Proliferate (YC S25) is hiring to build open source Codex',
      }),
      expect.objectContaining({
        postingUrl: 'https://jobs.ashbyhq.com/charge-robotics',
        title:
          'Charge Robotics (YC S21) Is Hiring Software and Hardware Engineers',
      }),
    ]);
  });

  it('falls back to the current Hacker News Who is Hiring thread when the jobs page has no provider links', async () => {
    const spider = {
      fetch: vi.fn(async () => ({
        content: '',
        finalUrl: 'https://news.ycombinator.com/jobs',
        links: [],
      })),
    } as unknown as SpiderAdapter;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [
            {
              objectID: '48357775',
              title: 'Ask HN: Who is hiring? (June 2026)',
            },
          ],
        });
      }
      if (url.includes('/api/v1/items/48357775')) {
        return jsonResponse({
          children: [
            {
              id: 48357775,
              text: 'Atom Computing | Senior Infrastructure Engineer | Remote / Hybrid | Build distributed platform systems and cloud infrastructure. Apply: <a href="https://jobs.lever.co/atomcomputing">https://jobs.lever.co/atomcomputing</a>',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const candidates = await discoverHackerNewsJobsCandidates(
      {
        searchQuery: 'remote platform engineer',
        url: 'https://news.ycombinator.com/jobs',
      },
      spider,
      fetchImpl,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        companyName: 'Atom Computing',
        postingUrl: 'https://jobs.lever.co/atomcomputing',
        title: 'Atom Computing',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      canonicalUrl: 'https://jobs.lever.co/atomcomputing',
      descriptionRaw: expect.stringContaining(
        'Build distributed platform systems',
      ),
      provider: 'generic',
      status: 'resolved',
    });
  });

  it('keeps Hacker News Who is Hiring board links importable from listing text', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [{ objectID: '48357775', title: 'Ask HN: Who is hiring?' }],
        });
      }
      if (url.includes('/api/v1/items/48357775')) {
        return jsonResponse({
          children: [
            {
              id: 48357775,
              text: 'Atom Computing | Senior Infrastructure Engineer | Remote / Hybrid | Build distributed platform systems and cloud infrastructure. Apply: <a href="https://jobs.lever.co/atomcomputing">https://jobs.lever.co/atomcomputing</a>',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const candidates = await discoverHackerNewsJobsCandidates(
      {
        searchQuery: 'remote platform engineer',
        url: 'https://news.ycombinator.com/submitted?id=whoishiring',
      },
      undefined,
      fetchImpl,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        companyName: 'Atom Computing',
        postingUrl: 'https://jobs.lever.co/atomcomputing',
        title: 'Atom Computing',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      canonicalUrl: 'https://jobs.lever.co/atomcomputing',
      descriptionRaw: expect.stringContaining(
        'Build distributed platform systems',
      ),
      provider: 'generic',
      status: 'resolved',
      title: 'Atom Computing',
      workMode: 'remote',
    });
  });

  it('keeps the complete Hacker News posting URL when its display text is truncated', async () => {
    const postingUrl =
      'https://jobs.lever.co/atomcomputing?source=hacker-news&role=senior-platform-engineer';
    const displayUrl = `${postingUrl.slice(0, 60)}...`;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [{ objectID: '48357775', title: 'Ask HN: Who is hiring?' }],
        });
      }
      if (url.includes('/api/v1/items/48357775')) {
        return jsonResponse({
          children: [
            {
              id: 48357776,
              text: `Atom Computing | Senior Platform Engineer | Remote | Apply: <a href="${postingUrl}">${displayUrl}</a>`,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const candidates = await discoverHackerNewsJobsCandidates(
      {
        searchQuery: 'remote platform engineer',
        url: 'https://news.ycombinator.com/submitted?id=whoishiring',
      },
      undefined,
      fetchImpl,
    );

    expect(postingUrl.length).toBeGreaterThan(63);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      diagnosticContext: 'hacker-news item 48357776',
      postingUrl,
      resolvedDetail: expect.objectContaining({ canonicalUrl: postingUrl }),
    });
    expect(candidates[0]?.postingUrl).not.toMatch(/\.\.\.$/);
  });

  it('creates Hacker News board-link opportunities using the listing text as detail', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [{ objectID: '48357775', title: 'Ask HN: Who is hiring?' }],
        });
      }
      if (url.includes('/api/v1/items/48357775')) {
        return jsonResponse({
          children: [
            {
              id: 48357775,
              text: 'Atom Computing | Senior Infrastructure Engineer | Remote / Hybrid | Build distributed platform systems and cloud infrastructure. Apply: <a href="https://jobs.lever.co/atomcomputing">https://jobs.lever.co/atomcomputing</a>',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Hacker News Who is Hiring',
        searchQuery: 'remote platform engineer',
        url: 'https://news.ycombinator.com/submitted?id=whoishiring',
      },
      { fetchImpl, intelligenceEnqueueCap: 0 },
    );

    expect(opportunities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        postingUrl: 'https://jobs.lever.co/atomcomputing',
        sourceId: 'source-1',
        title: 'Atom Computing',
        workMode: 'remote',
      }),
    );
    expect(opportunities.records[0]).toMatchObject({
      descriptionRaw: expect.stringContaining(
        'Build distributed platform systems',
      ),
      freshness: 'fresh',
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      companyName: 'Atom Computing',
      status: 'created_opportunity',
    });
    expect(summary).toMatchObject({
      candidates: 1,
      created: 1,
      skipped: 0,
    });
  });

  it('persists complete HN provenance while isolating malformed sibling extraction JSON', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const postingUrl =
      'https://jobs.lever.co/atomcomputing?source=hacker-news&role=senior-platform-engineer';
    const displayUrl = `${postingUrl.slice(0, 60)}...`;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [{ objectID: '48357775', title: 'Ask HN: Who is hiring?' }],
        });
      }
      if (url.includes('/api/v1/items/48357775')) {
        return jsonResponse({
          children: [
            {
              id: 48357776,
              text: `Broken Systems | Platform Engineer | Remote | <a href="https://jobs.ashbyhq.com/broken/123">Apply</a>`,
            },
            {
              id: 48357777,
              text: `Atom Computing | Senior Platform Engineer | Remote | Apply: <a href="${postingUrl}">${displayUrl}</a>`,
            },
          ],
        });
      }
      if (url === 'https://jobs.ashbyhq.com/broken/123') {
        return new Response('<script>"posting": {not-valid-json}</script>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Hacker News Who is Hiring',
        searchQuery: 'remote platform engineer',
        url: 'https://news.ycombinator.com/submitted?id=whoishiring',
      },
      { fetchImpl, intelligenceEnqueueCap: 0 },
    );

    expect(summary).toMatchObject({
      candidates: 2,
      created: 1,
      failedPersistence: 1,
    });
    expect(summary.errors).toEqual([
      expect.stringMatching(
        /^hacker-news item 48357776: Broken Systems: Expected property name/,
      ),
    ]);
    expect(summary.errors[0]?.length).toBeLessThanOrEqual(600);
    expect(opportunities.records[0]).toMatchObject({
      canonicalUrl: postingUrl,
      postingUrl,
    });
    expect(sourceCrawlItems.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalUrl: postingUrl,
          postingUrl,
          status: 'created_opportunity',
        }),
      ]),
    );
    expect(
      sourceCrawlItems.records.some((item) =>
        String(item.postingUrl).endsWith('...'),
      ),
    ).toBe(false);
  });

  it('discovers Automattic careers jobs from embedded board data with resolved details', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `<script id="wwu-positions-wwu-positions-view-script-js-before">
          const ghJobsData = [{"id":7558576,"title":"Applied AI Engineer","type":"job","metadata":{"Category":["Engineering"],"Team":["Automattic"]},"content":"&lt;p&gt;Build AI systems for a fully distributed company.&lt;/p&gt;","href":"https://automattic.com/work-with-us/job/applied-ai-engineer/"}]
          //# sourceURL=wwu-positions-wwu-positions-view-script-js-before
        </script>`,
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    );

    const candidates = await discoverAutomatticCandidates(
      { url: 'https://automattic.com/work-with-us/' },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://automattic.com/work-with-us/jobs/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/html,application/xhtml+xml',
        }),
      }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://automattic.com/work-with-us/job/applied-ai-engineer/',
        companyName: 'Automattic',
        externalId: '7558576',
        locationNotes: 'Remote',
        postingUrl:
          'https://automattic.com/work-with-us/job/applied-ai-engineer/',
        title: 'Applied AI Engineer',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: 'Build AI systems for a fully distributed company.',
      provider: 'generic',
      requiredSkills: 'Engineering\nAutomattic',
      status: 'resolved',
    });
  });

  it('discovers YC Work at a Startup postings from embedded board data', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <div data-page="{&quot;jobPostings&quot;:[{&quot;id&quot;:95405,&quot;title&quot;:&quot;Founding Full-Stack Engineer - AI Agents for Pharma&quot;,&quot;url&quot;:&quot;/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma&quot;,&quot;location&quot;:&quot;San Francisco, CA, US / Remote (US)&quot;,&quot;type&quot;:&quot;Full-time&quot;,&quot;companyName&quot;:&quot;Quinn&quot;}]}"></div>
        `),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverYcCandidates(
      {
        url: 'https://www.ycombinator.com/jobs?remote=true',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith(
      'https://www.ycombinator.com/jobs?remote=true',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://www.ycombinator.com/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
        companyName: 'Quinn',
        employmentType: 'full_time',
        externalId: '95405',
        locationNotes: 'San Francisco, CA, US / Remote (US)',
        postingUrl:
          'https://www.ycombinator.com/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
        title: 'Founding Full-Stack Engineer - AI Agents for Pharma',
        workMode: 'remote',
      }),
    ]);
  });

  it('retries YC discovery without cache when the cached fetch fails', async () => {
    const spider = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error('corrupt cache'))
        .mockResolvedValueOnce(
          spiderPage(`
            <div data-page="{&quot;jobPostings&quot;:[{&quot;id&quot;:95405,&quot;title&quot;:&quot;Founding Full-Stack Engineer&quot;,&quot;url&quot;:&quot;/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma&quot;,&quot;location&quot;:&quot;Remote (US)&quot;,&quot;type&quot;:&quot;Full-time&quot;,&quot;companyName&quot;:&quot;Quinn&quot;}]}"></div>
          `),
        ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverYcCandidates(
      {
        url: 'https://www.ycombinator.com/jobs?remote=true',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenNthCalledWith(
      1,
      'https://www.ycombinator.com/jobs?remote=true',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(spider.fetch).toHaveBeenNthCalledWith(
      2,
      'https://www.ycombinator.com/jobs?remote=true',
      {
        cache: false,
        timeout: 60000,
      },
    );
    expect(candidates).toHaveLength(1);
  });

  it('discovers a16z portfolio jobs through the Consider board API', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://jobs.a16z.com/jobs') {
        return new Response(
          '<script>window.serverInitialData = {"board":{"id":"andreessen-horowitz","isParent":true},"csrfToken":"csrf-token"};</script>',
          {
            headers: {
              'content-type': 'text/html',
              'set-cookie': 'a16z_session=session-token; Path=/; HttpOnly',
            },
            status: 200,
          },
        );
      }

      expect(url).toBe('https://jobs.a16z.com/api-boards/search-jobs');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Cookie: 'a16z_session=session-token',
        'X-CSRF-Token': 'csrf-token',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        board: { id: 'andreessen-horowitz', isParent: true },
        grouped: false,
        meta: { size: 50 },
        query: { keywords: 'agentic platform' },
      });
      return jsonResponse({
        jobs: [
          {
            applyUrl:
              'https://jobs.ashbyhq.com/mirage/7c8c5438-030d-447a-a360-1fd54344cc9b?utm_source=jobs.a16z.com',
            companyName: 'Mirage',
            jobTypes: [{ label: 'Software Engineer' }],
            locations: ['New York, NY, USA', 'Remote'],
            publishedAt: '2026-06-28T00:00:00.000Z',
            title: 'Software Engineer, Agents',
            url: 'https://jobs.ashbyhq.com/mirage/7c8c5438-030d-447a-a360-1fd54344cc9b',
          },
        ],
      });
    });

    const candidates = await discoverA16zPortfolioCandidates(
      {
        searchQuery: 'agentic platform',
        url: 'https://a16z.com/jobs/',
      },
      fetchMock,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/mirage/7c8c5438-030d-447a-a360-1fd54344cc9b',
        companyName: 'Mirage',
        locationNotes: 'New York, NY, USA / Remote',
        postedAt: new Date('2026-06-28T00:00:00.000Z'),
        postingUrl:
          'https://jobs.ashbyhq.com/mirage/7c8c5438-030d-447a-a360-1fd54344cc9b',
        title: 'Software Engineer, Agents',
        workMode: 'remote',
      }),
    ]);
  });

  it('discovers Apple Careers postings from static hydration data', async () => {
    const hydration = JSON.stringify({
      loaderData: {
        search: {
          searchResults: [
            {
              jobNumber: '200646237-3350',
              positionId: '200646237',
              postingDate: 'Feb 10, 2026',
              postingTitle: 'ML Engineer - Creator Studio',
              transformedPostingTitle: 'ml-engineer-creator-studio',
              locations: [
                {
                  city: 'Vancouver',
                  stateProvince: 'British Columbia',
                  countryName: 'Canada',
                },
              ],
            },
          ],
        },
      },
    });
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(
          `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(hydration)});</script>`,
        ),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverAppleCareersCandidates(
      {
        searchQuery: 'machine learning',
        url: 'https://jobs.apple.com/en-us/search',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith(
      'https://jobs.apple.com/en-us/search?search=machine+learning',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.apple.com/en-us/details/200646237-3350/ml-engineer-creator-studio',
        companyName: 'Apple',
        externalId: '200646237-3350',
        locationNotes: 'Vancouver, British Columbia, Canada',
        postingUrl:
          'https://jobs.apple.com/en-us/details/200646237-3350/ml-engineer-creator-studio',
        title: 'ML Engineer - Creator Studio',
      }),
    ]);
  });

  it('discovers Google Careers postings from static search result HTML', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <ul>
            <li class="lLd3Je" ssk="17:82347231926985414">
              <a href="jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform?q=AI+Platform">View</a>
              <h3 class="QJPWVe">AI/ML Senior Software Engineer, Data Optimization and Platform</h3>
              <span class="r0wTof">London, UK</span>
            </li>
          </ul>
        `),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGoogleCareersCandidates(
      {
        searchQuery: 'AI Platform',
        url: 'https://www.google.com/about/careers/applications/jobs/results/',
      },
      spider,
    );

    expect(spider.fetch).toHaveBeenCalledWith(
      'https://www.google.com/about/careers/applications/jobs/results/?q=AI+Platform',
      {
        cache: true,
        cacheExpiry: 3600000,
        timeout: 60000,
      },
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform?q=AI+Platform',
        companyName: 'Google',
        externalId: '82347231926985414',
        locationNotes: 'London, UK',
        postingUrl:
          'https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform?q=AI+Platform',
        title: 'AI/ML Senior Software Engineer, Data Optimization and Platform',
      }),
    ]);
  });

  it('discovers Lever board jobs from the public postings API', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
          text: 'Staff Backend Engineer',
          hostedUrl:
            'https://jobs.lever.co/acme/33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
          createdAt: 1553186035299,
          workplaceType: 'remote',
          categories: { commitment: 'Full Time', location: 'Remote - US' },
        },
        // No id/title → filtered out.
        { text: 'Ghost posting' },
      ]),
    );

    const candidates = await discoverLeverCandidates(
      { url: 'https://jobs.lever.co/acme' },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.lever.co/v0/postings/acme?mode=json',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.lever.co/acme/33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
        employmentType: 'full_time',
        externalId: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
        locationNotes: 'Remote - US',
        postingUrl:
          'https://jobs.lever.co/acme/33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
        title: 'Staff Backend Engineer',
        workMode: 'remote',
      }),
    ]);
  });

  it('queues intelligence with crawl and content provenance after saving an eligible opportunity', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT', '4');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT', '4000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS', '40000');
    const sourceCrawls = recordCollection([
      {
        id: 'crawl-1',
        jobAttempt: 1,
        jobId: 'scheduled-job',
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'queued',
      },
    ]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content:
              '<p>Build agentic platform systems.</p><p>Requirements</p><ul><li>TypeScript</li></ul>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-1' } as never,
    }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
        jobAttempt: 1,
        jobId: 'scheduled-job',
        sourceCrawlId: 'crawl-1',
      },
    );

    expect(opportunities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        title: 'Staff Agentic Platform Engineer',
      }),
    );
    expect(opportunities.records[0]).toMatchObject({
      descriptionRaw: expect.stringContaining(
        'Build agentic platform systems.',
      ),
      freshness: 'fresh',
      // Deterministic greenhouse detail parks requirement bullets in
      // qualifications; the LLM extract step refines them into atomic skills.
      qualifications: 'TypeScript',
      workMode: 'remote',
    });
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledWith(
      opportunities.records[0]?.id,
      expect.objectContaining({
        contentFingerprint: expect.any(String),
        contentFingerprintVersion: 'opportunity-source-content:v1',
        contentVersion: 1,
        reason: 'source-crawl',
        sourceCrawlId: 'crawl-1',
        sourceCrawlItemId: 'record-1',
        sourceId: 'source-1',
      }),
      { reason: 'source-crawl' },
    );
    expect(sourceCrawlItems.records[0]).toMatchObject({
      contentFingerprint: expect.any(String),
      contentVersion: 1,
      intelligenceEnqueueStatus: 'queued',
      intelligenceJobId: 'job-1',
    });
    expect(sourceCrawls.records[0]).toMatchObject({
      intelligenceCallLimit: expect.any(Number),
      intelligenceInputTokenLimit: expect.any(Number),
      intelligenceSpendLimitMicros: expect.any(Number),
      status: 'completed',
    });
    expect(
      Number(sourceCrawls.records[0].intelligenceCallLimit),
    ).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      candidates: 1,
      created: 1,
      duplicates: 0,
      errors: [],
      intelligenceDuplicateSuppressed: 0,
      intelligenceEnqueued: 1,
      intelligenceSkipped: 0,
      skipped: 0,
    });
  });

  it('uses zero as a fail-closed kill switch without blocking persistence', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn();

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 0,
      },
    );

    expect(opportunities.records).toHaveLength(1);
    expect(enqueueOpportunityIntelligence).not.toHaveBeenCalled();
    expect(sourceCrawlItems.records[0]).toMatchObject({
      intelligenceEnqueueStatus: 'disabled',
    });
    expect(sourceCrawls.records[0]).toMatchObject({
      intelligenceEnqueueCap: 0,
      intelligenceEnqueuedCount: 0,
      intelligenceSkippedCount: 1,
      status: 'completed',
    });
    expect(summary).toMatchObject({
      created: 1,
      errors: [],
      intelligenceEnqueued: 0,
      intelligenceSkipped: 1,
    });
  });

  it('enforces the per-crawl cap before creating another job', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
          {
            absolute_url: 'https://example.com/jobs/principal-engineer',
            content: '<p>Lead agentic platform systems.</p>',
            id: 124,
            location: { name: 'Remote' },
            title: 'Principal Agentic Platform Engineer',
          },
          {
            absolute_url: 'https://example.com/jobs/architect',
            content: '<p>Architect agentic platform systems.</p>',
            id: 125,
            location: { name: 'Remote' },
            title: 'Agentic Platform Architect',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-1' } as never,
    }));
    const findActiveOpportunityIntelligenceJob = vi
      .fn()
      .mockResolvedValueOnce({ id: 'job-existing' })
      .mockResolvedValueOnce(null);

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        findActiveOpportunityIntelligenceJob,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records).toHaveLength(3);
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledOnce();
    expect(sourceCrawlItems.records).toEqual([
      expect.objectContaining({ intelligenceEnqueueStatus: 'queued' }),
      expect.objectContaining({
        intelligenceEnqueueStatus: 'duplicate_active',
        intelligenceJobId: 'job-existing',
      }),
      expect.objectContaining({
        intelligenceEnqueueStatus: 'cap_exhausted',
      }),
    ]);
    expect(findActiveOpportunityIntelligenceJob).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      created: 3,
      intelligenceDuplicateSuppressed: 1,
      intelligenceEnqueued: 1,
      intelligenceSkipped: 1,
    });
  });

  it('increments the content version and queues materially changed content', async () => {
    getCollection.mockReset();
    const previousContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build platform and agent systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'onsite',
    };
    const opportunities = recordCollection([
      {
        ...previousContent,
        descriptionSummary: 'Stale machine summary.',
        domainTags: 'legacy-domain',
        founderSignal: true,
        greenfieldSignal: true,
        id: 'existing-opportunity',
        locations: 'Legacy location',
        postingUrl: previousContent.canonicalUrl,
        qualifications: 'Stale machine qualification.',
        relocationSupported: true,
        roleTags: 'legacy-role',
        save: vi.fn(async () => {}),
        seniority: 'principal',
        sourceId: 'source-1',
        sourceContentFingerprint:
          fingerprintOpportunitySourceContent(previousContent),
        sourceContentJson: JSON.stringify(previousContent),
        sourceContentVersion: 3,
        status: 'recommended',
        visaOrEorPossible: true,
      },
    ]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: previousContent.canonicalUrl,
            content: '<p>Build platform and agent systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: previousContent.title,
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-v4' } as never,
    }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records[0]).toMatchObject({
      descriptionSummary: expect.stringContaining(
        'Build platform and agent systems',
      ),
      domainTags: '',
      founderSignal: false,
      greenfieldSignal: false,
      locations: '',
      qualifications: '',
      relocationSupported: false,
      roleTags: '',
      seniority: 'unknown',
      descriptionRaw: expect.stringContaining('platform and agent systems'),
      sourceContentFingerprint: expect.any(String),
      sourceContentVersion: 4,
      status: 'found',
      workMode: 'remote',
      visaOrEorPossible: false,
    });
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.objectContaining({ contentVersion: 4 }),
      { reason: 'source-crawl' },
    );
    expect(sourceCrawlItems.records[0]).toMatchObject({
      contentVersion: 4,
      intelligenceEnqueueStatus: 'queued',
      status: 'updated_opportunity',
    });
    expect(summary).toMatchObject({
      created: 0,
      duplicates: 0,
      intelligenceEnqueued: 1,
      reused: 1,
    });
    expect(syncRecommendedOpportunityDecisionTasks).toHaveBeenCalledOnce();
    expect(cancelStaleOpportunityIntelligenceTasks).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.any(String),
      4,
    );
  });

  it('preserves a concurrent human status change while invalidating a recommendation', async () => {
    getCollection.mockReset();
    const previousContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'onsite',
    };
    const opportunity: Record<string, unknown> = {
      ...previousContent,
      id: 'existing-opportunity',
      postingUrl: previousContent.canonicalUrl,
      save: vi.fn(async () => {}),
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(previousContent),
      sourceContentVersion: 1,
      sourceId: 'source-1',
      status: 'recommended',
    };
    const opportunities = recordCollection([opportunity]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fencedOpportunitySourceUpdate = vi.fn(async () => {
      opportunity.status = 'apply';
      return true;
    });
    const fencedOpportunityStatusUpdate = vi.fn(async () => false);

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence: vi.fn(async () => ({
          enqueued: true,
          job: { id: 'job-v2' } as never,
        })),
        fencedOpportunitySourceUpdate,
        fencedOpportunityStatusUpdate,
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            jobs: [
              {
                absolute_url: previousContent.canonicalUrl,
                content: '<p>Build platform and agent systems.</p>',
                id: 123,
                location: { name: 'Remote' },
                title: previousContent.title,
              },
            ],
          }),
        ),
        intelligenceEnqueueCap: 1,
      },
    );

    expect(fencedOpportunityStatusUpdate).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.any(String),
      2,
      'recommended',
      'found',
    );
    expect(opportunity.status).toBe('apply');
    expect(syncRecommendedOpportunityDecisionTasks).not.toHaveBeenCalled();
    expect(fencedOpportunitySourceUpdate).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.any(String),
      1,
      expect.not.objectContaining({
        applyMethod: expect.anything(),
        applyUrl: expect.anything(),
        companyId: expect.anything(),
        status: expect.anything(),
      }),
    );
  });

  it('invalidates a recommendation promoted just before a material source CAS', async () => {
    getCollection.mockReset();
    const previousContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'onsite',
    };
    const opportunity: Record<string, unknown> = {
      ...previousContent,
      id: 'existing-opportunity',
      postingUrl: previousContent.canonicalUrl,
      save: vi.fn(async () => {}),
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(previousContent),
      sourceContentJson: JSON.stringify(previousContent),
      sourceContentVersion: 1,
      sourceId: 'source-1',
      status: 'found',
    };
    const opportunities = recordCollection([opportunity]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fencedOpportunitySourceUpdate = vi.fn(async () => {
      opportunity.status = 'recommended';
      return true;
    });
    const fencedOpportunityStatusUpdate = vi.fn(async () => true);

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence: vi.fn(async () => ({
          enqueued: true,
          job: { id: 'job-v2' } as never,
        })),
        fencedOpportunitySourceUpdate,
        fencedOpportunityStatusUpdate,
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            jobs: [
              {
                absolute_url: previousContent.canonicalUrl,
                content: '<p>Build platform and agent systems.</p>',
                id: 123,
                location: { name: 'Remote' },
                title: previousContent.title,
              },
            ],
          }),
        ),
        intelligenceEnqueueCap: 1,
      },
    );

    expect(fencedOpportunityStatusUpdate).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.any(String),
      2,
      'recommended',
      'found',
    );
    expect(opportunity.status).toBe('found');
    expect(syncRecommendedOpportunityDecisionTasks).toHaveBeenCalledOnce();
  });

  it('retries the source-content CAS against the winning concurrent version', async () => {
    getCollection.mockReset();
    const previousContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'remote',
    };
    const concurrentContent = {
      ...previousContent,
      descriptionRaw: 'Concurrent crawler content.',
    };
    const opportunity: Record<string, unknown> = {
      ...previousContent,
      id: 'existing-opportunity',
      postingUrl: previousContent.canonicalUrl,
      save: vi.fn(async () => {}),
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(previousContent),
      sourceContentJson: JSON.stringify(previousContent),
      sourceContentVersion: 1,
      sourceId: 'source-1',
    };
    const opportunities = recordCollection([opportunity]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const concurrentFingerprint =
      fingerprintOpportunitySourceContent(concurrentContent);
    const fencedOpportunitySourceUpdate = vi
      .fn()
      .mockImplementationOnce(async () => {
        Object.assign(opportunity, concurrentContent, {
          sourceContentFingerprint: concurrentFingerprint,
          sourceContentJson: JSON.stringify(concurrentContent),
          sourceContentVersion: 2,
        });
        return false;
      })
      .mockResolvedValueOnce(true);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: previousContent.canonicalUrl,
            content: '<p>Build platform and agent systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: previousContent.title,
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-v3' } as never,
    }));

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fencedOpportunitySourceUpdate,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(fencedOpportunitySourceUpdate).toHaveBeenNthCalledWith(
      1,
      'existing-opportunity',
      fingerprintOpportunitySourceContent(previousContent),
      1,
      expect.objectContaining({ sourceContentVersion: 2 }),
    );
    expect(fencedOpportunitySourceUpdate).toHaveBeenNthCalledWith(
      2,
      'existing-opportunity',
      concurrentFingerprint,
      2,
      expect.objectContaining({ sourceContentVersion: 3 }),
    );
    expect(opportunity.sourceContentVersion).toBe(3);
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.objectContaining({ contentVersion: 3 }),
      { reason: 'source-crawl' },
    );
  });

  it('persists explicit source removals as a material content version', async () => {
    getCollection.mockReset();
    const canonicalUrl =
      'https://www.freelancer.com/projects/python/Build-Kubernetes-platform';
    const previousContent = {
      canonicalUrl,
      compNotes: 'Project type: fixed',
      currency: 'USD',
      descriptionRaw: 'Build Kubernetes automation for AI infrastructure.',
      employmentType: 'contract',
      externalId: '40540001',
      locationNotes: 'Remote',
      requiredSkills: 'Kubernetes',
      salaryMax: 7_500,
      salaryMin: 3_000,
      title: 'Build Kubernetes platform',
      workMode: 'remote',
    };
    const opportunities = recordCollection([
      {
        ...previousContent,
        id: 'existing-opportunity',
        postingUrl: canonicalUrl,
        save: vi.fn(async () => {}),
        sourceContentFingerprint:
          fingerprintOpportunitySourceContent(previousContent),
        sourceContentJson: JSON.stringify(previousContent),
        sourceContentVersion: 1,
        sourceId: 'source-1',
      },
    ]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        result: {
          projects: [
            {
              currency: { code: 'USD' },
              description: 'Build Kubernetes automation for AI infrastructure.',
              id: 40540001,
              jobs: [{ name: 'Kubernetes' }],
              seo_url: 'python/Build-Kubernetes-platform',
              title: 'Build Kubernetes platform',
              type: 'fixed',
            },
          ],
        },
        status: 'success',
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-v2' } as never,
    }));

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Freelancer',
        searchQuery: 'Kubernetes',
        url: 'https://www.freelancer.com/jobs/',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records[0]).toMatchObject({
      salaryMax: null,
      salaryMin: null,
      sourceContentVersion: 2,
    });
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.objectContaining({ contentVersion: 2 }),
      { reason: 'source-crawl' },
    );
  });

  it('does not enqueue intelligence for unchanged crawled opportunities', async () => {
    getCollection.mockReset();
    const sourceContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build agentic platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'remote',
    };
    const opportunity: Record<string, unknown> = {
      canonicalUrl: sourceContent.canonicalUrl,
      descriptionRaw: sourceContent.descriptionRaw,
      externalId: sourceContent.externalId,
      id: 'existing-opportunity',
      locationNotes: sourceContent.locationNotes,
      postingUrl: 'https://example.com/jobs/staff-engineer',
      qualifications: 'LLM-generated qualification added after ingestion',
      save: vi.fn(async () => {}),
      sourceId: 'source-1',
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(sourceContent),
      sourceContentJson: JSON.stringify(sourceContent),
      sourceContentVersion: 1,
      salaryMax: null,
      title: sourceContent.title,
      workMode: sourceContent.workMode,
    };
    const opportunities = recordCollection([opportunity]);
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn();
    const fencedOpportunitySourceUpdate = vi.fn(
      async (
        _opportunityId: string,
        _expectedFingerprint: string,
        _expectedVersion: number,
        updates: Record<string, unknown>,
      ) => {
        expect(updates).not.toHaveProperty('salaryMax');
        expect(updates).not.toHaveProperty('qualifications');
        opportunity.salaryMax = 200_000;
        return true;
      },
    );

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fencedOpportunitySourceUpdate,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 5,
      },
    );

    expect(enqueueOpportunityIntelligence).not.toHaveBeenCalled();
    expect(opportunities.records[0].qualifications).toBe(
      'LLM-generated qualification added after ingestion',
    );
    expect(opportunities.records[0]).toMatchObject({
      applyMethod: 'company_site',
      applyUrl: sourceContent.canonicalUrl,
      salaryMax: 200_000,
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      intelligenceEnqueueStatus: 'unchanged',
      opportunityId: 'existing-opportunity',
      status: 'duplicate',
    });
    expect(summary).toMatchObject({
      candidates: 1,
      created: 0,
      duplicates: 0,
      errors: [],
      intelligenceEnqueued: 0,
      intelligenceSkipped: 1,
      reused: 1,
      skipped: 0,
    });
  });

  it('preserves deterministic candidate employment type when detail omits it', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <script>
            window.__DATA__ = {"jobPostings":[{"id":"ashby-job-1","title":"Staff Agentic Platform Engineer","employmentType":"FullTime","locationName":"Remote","publishedDate":"2026-04-15","workplaceType":"Remote"}]};
          </script>
        `),
      ),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(
      async () =>
        new Response(`
        <script>
          window.__DATA__ = {"posting":{"id":"ashby-job-1","title":"Staff Agentic Platform Engineer","descriptionPlainText":"Build agentic platform systems.","locationName":"Remote","publishedDate":"2026-04-15","workplaceType":"Remote"}};
        </script>
      `),
    );

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Ashby',
        searchQuery: 'agentic platform',
        url: 'https://jobs.ashbyhq.com/redcan',
      },
      {
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 0,
        spider,
      },
    );

    expect(opportunities.records[0]).toMatchObject({
      employmentType: 'full_time',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'remote',
    });
  });

  it('records enqueue failures without discarding saved opportunities', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => {
      throw new Error('queue unavailable');
    });

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records).toHaveLength(1);
    expect(summary).toMatchObject({
      created: 1,
      errors: [expect.stringContaining('intelligence enqueue failed')],
      intelligenceEnqueued: 0,
      intelligenceSkipped: 1,
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      intelligenceEnqueueStatus: 'enqueue_failed',
    });
    expect(opportunities.records[0]).toMatchObject({
      sourceIntelligenceJobId: '',
      sourceIntelligenceStatus: 'enqueue_failed',
    });
  });

  it('consumes the hard-cap slot when an enqueue commit is ambiguous', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
          {
            absolute_url: 'https://example.com/jobs/principal-engineer',
            content: '<p>Lead agentic platform systems.</p>',
            id: 124,
            location: { name: 'Remote' },
            title: 'Principal Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => {
      throw new Error('queue response lost after commit');
    });
    const findActiveOpportunityIntelligenceJob = vi.fn(async () => null);

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        findActiveOpportunityIntelligenceJob,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(enqueueOpportunityIntelligence).toHaveBeenCalledOnce();
    expect(findActiveOpportunityIntelligenceJob).toHaveBeenCalledOnce();
    expect(sourceCrawlItems.records).toEqual([
      expect.objectContaining({
        intelligenceEnqueueStatus: 'enqueue_failed',
      }),
      expect.objectContaining({
        intelligenceEnqueueStatus: 'cap_exhausted',
      }),
    ]);
    expect(summary).toMatchObject({
      intelligenceEnqueued: 0,
      intelligenceSkipped: 2,
    });
  });

  it('does not let a stale enqueue outcome overwrite newer source content', async () => {
    getCollection.mockReset();
    const sourceContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build agentic platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'remote',
    };
    const opportunity: Record<string, unknown> = {
      ...sourceContent,
      id: 'existing-opportunity',
      postingUrl: sourceContent.canonicalUrl,
      save: vi.fn(async () => {}),
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(sourceContent),
      sourceContentJson: JSON.stringify(sourceContent),
      sourceContentVersion: 1,
      sourceId: 'source-1',
      sourceIntelligenceStatus: 'enqueue_failed',
    };
    const opportunities = recordCollection([opportunity]);
    const sourceCrawls = recordCollection();
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: sourceContent.canonicalUrl,
            content: `<p>${sourceContent.descriptionRaw}</p>`,
            id: 123,
            location: { name: 'Remote' },
            title: sourceContent.title,
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-v1' } as never,
    }));
    const fencedOpportunityIntelligenceUpdate = vi.fn(async () => {
      Object.assign(opportunity, {
        sourceContentFingerprint: 'fingerprint-v2',
        sourceContentVersion: 2,
        sourceIntelligenceJobId: '',
        sourceIntelligenceStatus: 'pending',
      });
      return false;
    });

    await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fencedOpportunityIntelligenceUpdate,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(fencedOpportunityIntelligenceUpdate).toHaveBeenCalledWith(
      'existing-opportunity',
      fingerprintOpportunitySourceContent(sourceContent),
      1,
      {
        sourceIntelligenceJobId: 'job-v1',
        sourceIntelligenceStatus: 'queued',
      },
    );
    expect(opportunity).toMatchObject({
      sourceContentFingerprint: 'fingerprint-v2',
      sourceContentVersion: 2,
      sourceIntelligenceJobId: '',
      sourceIntelligenceStatus: 'pending',
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      intelligenceEnqueueStatus: 'queued',
      intelligenceJobId: 'job-v1',
    });
  });

  it('retries a durable enqueue failure on a later unchanged crawl', async () => {
    getCollection.mockReset();
    const sourceContent = {
      canonicalUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Build agentic platform systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: 'Staff Agentic Platform Engineer',
      workMode: 'remote',
    };
    const opportunities = recordCollection([
      {
        ...sourceContent,
        id: 'existing-opportunity',
        postingUrl: sourceContent.canonicalUrl,
        save: vi.fn(async () => {}),
        sourceContentFingerprint:
          fingerprintOpportunitySourceContent(sourceContent),
        sourceContentJson: JSON.stringify(sourceContent),
        sourceContentVersion: 1,
        sourceId: 'source-1',
        sourceIntelligenceStatus: 'enqueue_failed',
      },
    ]);
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: sourceContent.canonicalUrl,
            content: `<p>${sourceContent.descriptionRaw}</p>`,
            id: 123,
            location: { name: 'Remote' },
            title: sourceContent.title,
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-recovered' } as never,
    }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(enqueueOpportunityIntelligence).toHaveBeenCalledWith(
      'existing-opportunity',
      expect.objectContaining({
        contentFingerprint: fingerprintOpportunitySourceContent(sourceContent),
        contentVersion: 1,
      }),
      { reason: 'source-crawl' },
    );
    expect(opportunities.records[0]).toMatchObject({
      sourceContentVersion: 1,
      sourceIntelligenceJobId: 'job-recovered',
      sourceIntelligenceStatus: 'queued',
    });
    expect(sourceCrawlItems.records[0]).toMatchObject({
      contentVersion: 1,
      intelligenceEnqueueStatus: 'queued',
      intelligenceJobId: 'job-recovered',
      status: 'duplicate',
    });
    expect(summary).toMatchObject({
      created: 0,
      duplicates: 0,
      intelligenceEnqueued: 1,
      intelligenceSkipped: 0,
      reused: 1,
    });
  });

  it('retries the intended created outcome after terminal provenance briefly fails', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    const createCrawlItem = sourceCrawlItems.create;
    sourceCrawlItems.create = vi.fn(async (values: Record<string, unknown>) => {
      const item = await createCrawlItem(values);
      let saves = 0;
      item.save = vi.fn(async () => {
        saves += 1;
        if (saves === 4) throw new Error('crawl item write unavailable');
      });
      return item;
    });
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-queued' } as never,
    }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records).toHaveLength(1);
    expect(enqueueOpportunityIntelligence).not.toHaveBeenCalled();
    expect(sourceCrawlItems.records[0]).toMatchObject({
      opportunityId: expect.any(String),
      outcome: 'created',
      status: 'created_opportunity',
    });
    expect(summary).toMatchObject({
      created: 1,
      failedPersistence: 0,
    });
    expect(summary.errors).toEqual([
      expect.stringContaining('crawl item write unavailable'),
    ]);
    expect(sourceCrawls.records.at(-1)).toMatchObject({
      status: 'completed_with_errors',
    });
  });

  it('retries the intended skipped outcome after terminal provenance briefly fails', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    const createCrawlItem = sourceCrawlItems.create;
    sourceCrawlItems.create = vi.fn(async (values: Record<string, unknown>) => {
      const item = await createCrawlItem(values);
      let saves = 0;
      item.save = vi.fn(async () => {
        saves += 1;
        if (saves === 3) throw new Error('skipped terminal write uncertain');
      });
      return item;
    });
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/accountant',
            content: '<p>Prepare monthly financial statements.</p>',
            id: 456,
            location: { name: 'Remote' },
            title: 'Senior Accountant',
          },
        ],
      }),
    );

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      { fetchImpl: fetchMock },
    );

    expect(opportunities.records).toHaveLength(0);
    expect(sourceCrawlItems.records[0]).toMatchObject({
      outcome: 'skipped',
      status: 'skipped_not_relevant',
    });
    expect(summary).toMatchObject({ failedPersistence: 0, skipped: 1 });
    expect(summary.errors).toEqual([
      expect.stringContaining('skipped terminal write uncertain'),
    ]);
  });

  it('finalizes the crawl after queueing without awaiting AI execution', async () => {
    getCollection.mockReset();
    const opportunities = recordCollection();
    const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
    const sourceCrawlItems = recordCollection();
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return sourceCrawls;
      if (name === 'SourceCrawlItem') return sourceCrawlItems;
      throw new Error(`Unexpected collection ${name}`);
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://example.com/jobs/staff-engineer',
            content: '<p>Build agentic platform systems.</p>',
            id: 123,
            location: { name: 'Remote' },
            title: 'Staff Agentic Platform Engineer',
          },
        ],
      }),
    );
    const enqueueOpportunityIntelligence = vi.fn(async () => ({
      enqueued: true,
      job: { id: 'job-slow-worker' } as never,
    }));

    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Greenhouse',
        searchQuery: 'agentic platform',
        url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      },
      {
        enqueueOpportunityIntelligence,
        fetchImpl: fetchMock,
        intelligenceEnqueueCap: 1,
      },
    );

    expect(opportunities.records).toHaveLength(1);
    expect(sourceCrawlItems.records).toHaveLength(1);
    expect(summary).toMatchObject({
      candidates: 1,
      created: 1,
      errors: [],
      intelligenceEnqueued: 1,
      intelligenceSkipped: 0,
      skipped: 0,
    });
    expect(sourceCrawls.records[1]).toMatchObject({
      error: '',
      finishedAt: expect.any(Date),
      intelligenceEnqueuedCount: 1,
      newOpportunityCount: 1,
      resultCount: 1,
      status: 'completed',
    });
    expect(enqueueOpportunityIntelligence).toHaveBeenCalledOnce();
  });

  it('extracts provider links from generic pages without promoting list URLs itself', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('', [
          {
            href: 'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
            text: 'Staff Software Engineer',
          },
          {
            href: 'https://example.com/jobs/123',
            text: 'Ignore unsupported board',
          },
        ]),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGenericProviderLinks(
      {
        url: 'https://example.com/careers',
      },
      spider,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
        title: 'Staff Software Engineer',
      }),
    ]);
  });

  it('discovers Zapier Ashby jobs from a generic Builder.io careers page', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(
          '{"component":{"name":"JobBoard","options":{"useAshbyData":true}}}',
        ),
      ),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe(
        'https://api.ashbyhq.com/posting-api/job-board/zapier',
      );
      return jsonResponse({
        jobs: [
          {
            descriptionHtml:
              '<p>Build automation platform systems for AI workflows.</p>',
            employmentType: 'FullTime',
            id: '03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
            isRemote: true,
            jobUrl:
              'https://jobs.ashbyhq.com/zapier/03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
            location: 'NAMER',
            publishedAt: '2026-04-22T15:41:06.460+00:00',
            title: 'Staff Software Engineer, AI Automation',
            workplaceType: 'Remote',
          },
        ],
      });
    });

    const candidates = await discoverGenericProviderLinks(
      { url: 'https://zapier.com/jobs' },
      spider,
      fetchMock,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        canonicalUrl:
          'https://jobs.ashbyhq.com/zapier/03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        employmentType: 'full_time',
        externalId: '03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        locationNotes: 'NAMER',
        postingUrl:
          'https://jobs.ashbyhq.com/zapier/03aee44c-e6db-479f-94c4-1eda8cc6bf9f',
        title: 'Staff Software Engineer, AI Automation',
        workMode: 'remote',
      }),
    ]);
    expect(candidates[0]?.resolvedDetail).toMatchObject({
      descriptionRaw: expect.stringContaining('automation platform systems'),
      message: 'Loaded Ashby posting details.',
      provider: 'ashby',
      status: 'resolved',
    });
  });

  it('extracts recognized provider links from page HTML when the spider omits anchors', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(`
          <nav><a href="/careers/all#ubuntu-os-menu">Ubuntu OS</a></nav>
          <a href="https://job-boards.greenhouse.io/canonical/jobs/5569916">Software Engineer</a>
          <a aria-label="Apply for Engineering Manager" href='/ignored-relative-link'>Ignore</a>
        `),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGenericProviderLinks(
      { url: 'https://canonical.com/careers/all' },
      spider,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://job-boards.greenhouse.io/canonical/jobs/5569916',
      }),
    ]);
  });

  it('falls back to direct HTML fetch when spider content omits provider anchors', async () => {
    const originalFetch = globalThis.fetch;
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('Canonical careers rendered text', [
          {
            href: 'https://canonical.com/careers/web-and-design',
            text: 'Web and Design',
          },
        ]),
      ),
    } as unknown as SpiderAdapter;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '<a href="https://job-boards.greenhouse.io/canonical/jobs/5569916">Software Engineer</a>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const candidates = await discoverGenericProviderLinks(
        { url: 'https://canonical.com/careers/all' },
        spider,
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://canonical.com/careers/all',
        expect.any(Object),
      );
      expect(candidates).toEqual([
        expect.objectContaining({
          postingUrl: 'https://job-boards.greenhouse.io/canonical/jobs/5569916',
        }),
      ]);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('discovers provider posting URLs embedded in static page JSON', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(
          '{"href":"https://jobs.ashbyhq.com/buffer/6ee07995-2738-4cee-b16d-fc8967674346"}',
        ),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGenericProviderLinks(
      { url: 'https://buffer.com/journey#open-roles' },
      spider,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://jobs.ashbyhq.com/buffer/6ee07995-2738-4cee-b16d-fc8967674346',
      }),
    ]);
  });

  it('discovers Workday posting URLs embedded in generic careers page JSON', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage(
          '{"applyUrl":"https://circle.wd1.myworkdayjobs.com/Circle/job/San-Francisco---remote-first-in-US/Principal-Software-Engineer_JR100001/apply"}',
        ),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGenericProviderLinks(
      { url: 'https://careers.circle.com/us/en/search-results' },
      spider,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://circle.wd1.myworkdayjobs.com/Circle/job/San-Francisco---remote-first-in-US/Principal-Software-Engineer_JR100001/apply',
      }),
    ]);
  });

  it('keeps only YC Work at a Startup posting links discovered from generic source pages', async () => {
    const spider = {
      fetch: vi.fn(async () =>
        spiderPage('', [
          {
            href: 'https://www.ycombinator.com/companies/accessowl/jobs/hfWAhVp-ai-enabled-senior-software-engineer-typescript-focus',
            text: 'AccessOwl (YC S22) is hiring an AI TypeScript Engineer',
          },
          {
            href: 'https://www.ycombinator.com/jobs',
            text: 'YC jobs index',
          },
          {
            href: 'https://www.ycombinator.com/companies/reflex/jobs',
            text: 'Reflex (YC W23) Is Hiring SWEs, Growth, and GTM Roles',
          },
          {
            href: 'https://www.ycombinator.com/apply/',
            text: 'Apply to YC',
          },
        ]),
      ),
    } as unknown as SpiderAdapter;

    const candidates = await discoverGenericProviderLinks(
      { url: 'https://news.ycombinator.com/jobs' },
      spider,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://www.ycombinator.com/companies/accessowl/jobs/hfWAhVp-ai-enabled-senior-software-engineer-typescript-focus',
        title: 'AccessOwl (YC S22) is hiring an AI TypeScript Engineer',
      }),
    ]);
  });

  it('filters Guru category and skill links from generic posting discovery', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://www.guru.com/d/jobs/' },
      adapterContext([
        {
          href: '/jobs/senior-ai-engineer-needed/2118920&SearchUrl=search.aspx?',
          text: 'Senior AI Engineer Needed',
        },
        {
          href: 'https://www.guru.com/jobs/platform-automation/2118999&SearchUrl=search.aspx?',
          text: 'Platform Automation Engineer',
        },
        {
          classes: ['darkGrey'],
          href: 'https://www.guru.com/d/jobs/c/programming-development',
          text: 'Programming & Development',
        },
        {
          classes: ['skillsList__skill', 'skillsList__skill--hasHover'],
          href: 'https://www.guru.com/d/jobs/c/programming-development/skill/artificial-intelligence/',
          text: 'Artificial Intelligence',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://www.guru.com/jobs/senior-ai-engineer-needed/2118920&SearchUrl=search.aspx?',
        title: 'Senior AI Engineer Needed',
      }),
      expect.objectContaining({
        postingUrl:
          'https://www.guru.com/jobs/platform-automation/2118999&SearchUrl=search.aspx?',
        title: 'Platform Automation Engineer',
      }),
    ]);
  });

  it('applies the source query to Remote Rocketship homepage posting links', async () => {
    const candidates = await discoverGenericPostingLinks(
      {
        searchQuery: 'Canada remote agentic AI senior staff engineer 200k',
        url: 'https://www.remoterocketship.com/',
      },
      adapterContext([
        {
          href: 'https://www.remoterocketship.com/company/netcall-group/jobs/call-center-agent-ventas-peru-remote/',
          text: 'Call Center Agent – Ventas',
        },
        {
          href: 'https://www.remoterocketship.com/company/overflow-co/jobs/data-engineer-united-states-remote/',
          text: 'Data Engineer',
        },
        {
          href: 'https://www.remoterocketship.com/company/platform-labs/jobs/staff-platform-engineer-canada-remote/',
          text: 'Staff Platform Engineer, Canada Remote',
        },
        {
          href: 'https://www.remoterocketship.com/company/agentic-labs/jobs/ai-infrastructure-engineer-remote/',
          text: 'AI Infrastructure Engineer',
        },
        {
          href: 'https://www.remoterocketship.com/jobs/software-engineer/',
          text: 'Software Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://www.remoterocketship.com/company/platform-labs/jobs/staff-platform-engineer-canada-remote/',
        title: 'Staff Platform Engineer, Canada Remote',
      }),
      expect.objectContaining({
        postingUrl:
          'https://www.remoterocketship.com/company/agentic-labs/jobs/ai-infrastructure-engineer-remote/',
        title: 'AI Infrastructure Engineer',
      }),
    ]);
  });

  it('filters generic careers navigation and job-seeker marketing links', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://consensys.io/careers' },
      adapterContext([
        {
          href: 'https://kobalt.io/careers/',
          text: 'Careers',
        },
        {
          classes: ['list__item', 'svelte-1w917jc'],
          href: 'https://consensys.io/careers/locations',
          text: 'Locations',
        },
        {
          classes: ['list__item', 'svelte-1w917jc'],
          href: 'https://consensys.io/careers/culture',
          text: 'Culture',
        },
        {
          classes: ['navbar1_dropdown-link', 'w-dropdown-link'],
          href: 'https://chainlinklabs.com/careers/how-we-work',
          text: 'How we work',
        },
        {
          classes: ['navbar1_dropdown-link', 'w-dropdown-link'],
          href: 'https://chainlinklabs.com/careers/web3-experts',
          text: 'Web3 experts',
        },
        {
          href: 'https://weworkremotely.com/job-seekers/courses',
          text: 'Online Courses New!',
        },
        {
          href: 'https://weworkremotely.com/career-services/job-copilot',
          text: 'AI Job Search',
        },
        {
          href: 'https://www.workingnomads.com/job-skills',
          text: 'Job Skills',
        },
        {
          href: 'https://consensys.io/careers/staff-platform-engineer',
          text: 'Staff Platform Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://consensys.io/careers/staff-platform-engineer',
        title: 'Staff Platform Engineer',
      }),
    ]);
  });

  it('filters Zapier careers marketing pages from generic posting discovery', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://zapier.com/jobs' },
      adapterContext([
        {
          href: 'https://zapier.com/l/jobs/interview-guide',
          text: 'Interviewing at Zapier',
        },
        {
          href: 'https://zapier.com/jobs/our-commitment-to-applicants',
          text: 'Our commitment to applicants',
        },
        {
          href: 'https://zapier.com/jobs/culture-and-values-at-zapier',
          text: 'Learn more about our company values',
        },
        {
          href: 'https://zapier.com/jobs/working-on-diversity-and-inclusivity',
          text: 'DIBE is part of our DNA',
        },
        {
          href: 'https://zapier.com/jobs/zapier-code-of-conduct',
          text: 'code of conduct',
        },
        {
          href: 'https://zapier.com/l/jobs/total-rewards',
          text: 'Learn more about Total Rewards at Zapier',
        },
        {
          href: 'https://zapier.com/jobs/senior-platform-engineer',
          text: 'Senior Platform Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://zapier.com/jobs/senior-platform-engineer',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('filters equivalent source page links with normalized trailing slashes', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://kobalt.io/careers' },
      adapterContext([
        {
          href: 'https://kobalt.io/careers/',
          text: 'Careers',
        },
        {
          href: 'https://kobalt.io/careers/senior-platform-engineer',
          text: 'Senior Platform Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://kobalt.io/careers/senior-platform-engineer',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('filters same-page fragment links from generic posting discovery', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://canonical.com/careers/all' },
      adapterContext([
        {
          href: 'https://canonical.com/careers/all#main-content',
          text: 'Skip to main content',
        },
        {
          href: 'https://canonical.com/careers/all#ubuntu-os-menu',
          text: 'Ubuntu OS',
        },
        {
          href: 'https://canonical.com/careers/software-engineer',
          text: 'Software Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://canonical.com/careers/software-engineer',
        title: 'Software Engineer',
      }),
    ]);
  });

  it('filters Built In navigation links while keeping concrete job postings', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://builtin.com/jobs' },
      adapterContext([
        {
          href: 'https://builtin.com/profile/job-preferences',
          text: 'Manage',
        },
        {
          href: 'https://builtin.com/jobs/dev-engineering/search/ai-engineer',
          text: 'AI Engineer Jobs',
        },
        {
          href: 'https://builtin.com/jobs/hybrid',
          text: 'Hybrid Jobs',
        },
        {
          href: 'https://employers.builtin.com/careers/',
          text: 'Careers',
        },
        {
          href: 'https://builtin.com/job/senior-ai-product-engineer-frameworks/9587612',
          text: 'Senior AI Product Engineer, Frameworks',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://builtin.com/job/senior-ai-product-engineer-frameworks/9587612',
        title: 'Senior AI Product Engineer, Frameworks',
      }),
    ]);
  });

  it('filters Remote Rocketship facets while keeping company job pages', async () => {
    const candidates = await discoverGenericPostingLinks(
      { url: 'https://www.remoterocketship.com/' },
      adapterContext([
        {
          href: 'https://www.remoterocketship.com/jobs/full-time/',
          text: '⏰ Full Time',
        },
        {
          href: 'https://www.remoterocketship.com/us/jobs/h1b/',
          text: 'H1B Visa Sponsor',
        },
        {
          href: 'https://www.remoterocketship.com/jobs/software-engineer/',
          text: 'Software Engineer',
        },
        {
          href: 'https://www.remoterocketship.com/company/acme/jobs/senior-platform-engineer-canada-remote/',
          text: 'Senior Platform Engineer',
        },
      ]),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://www.remoterocketship.com/company/acme/jobs/senior-platform-engineer-canada-remote/',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('uses source search terms and role terms for relevance filtering', () => {
    const source = {
      searchQuery:
        'Agentic AI Foundations OR platform OR orchestration OR memory OR evals',
    };

    expect(keywordTokens(source)).toEqual(
      expect.arrayContaining([
        'agentic',
        'foundations',
        'platform',
        'orchestration',
      ]),
    );
    expect(
      candidateMatchesSource(
        source,
        'Build agentic AI orchestration systems for production workflows.',
      ),
    ).toBe(true);
    expect(candidateMatchesSource(source, 'AI Copywriter')).toBe(false);
    expect(
      candidateMatchesSource(
        source,
        'Account Executive Director - Big Tech, AI, and Startups',
      ),
    ).toBe(false);
    expect(
      candidateMatchesSource(
        source,
        'Retail store manager for seasonal hiring.',
      ),
    ).toBe(false);
  });

  it('discovers relevant provider links from the latest Hacker News Who is Hiring thread', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search_by_date')) {
        return jsonResponse({
          hits: [
            {
              objectID: '48357725',
              title: 'Ask HN: Who is hiring? (June 2026)',
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/items/48357725')) {
        return jsonResponse({
          id: 48357725,
          title: 'Ask HN: Who is hiring? (June 2026)',
          children: [
            {
              id: 1,
              text: 'Acme AI | Platform Engineer | Remote<p>Apply: <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme&#x2F;abc123">https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme&#x2F;abc123</a>',
              type: 'comment',
            },
            {
              id: 2,
              text: 'SalesCo | Account Executive | <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;salesco&#x2F;sales123">Apply</a>',
              type: 'comment',
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const candidates = await discoverHackerNewsJobsCandidates(
      {
        searchQuery:
          'AI, agents, platform, infra, Kubernetes, founding, Canada, remote',
        url: 'https://news.ycombinator.com/submitted?id=whoishiring',
      },
      undefined,
      fetchMock,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://jobs.ashbyhq.com/acme/abc123',
        title: 'Acme AI',
      }),
    ]);
  });

  it('only includes generic sources when explicitly requested', () => {
    const activeSource = (url: string) => ({ isActive: true, url });
    const registeredProviderUrls = [
      'https://jobs.ashbyhq.com/redcan',
      'https://boards.greenhouse.io/example',
      'https://acme.wd5.myworkdayjobs.com/en-US/careers',
      'https://www.ai-jobs.net/',
      'https://www.amazon.jobs/en/job_categories/software-development',
      'https://automattic.com/work-with-us/',
      'https://jobs.apple.com/en-ca/search?team=DEV',
      'https://canonical.com/careers/all',
      'https://www.gemini.com/careers',
      'https://www.google.com/about/careers/applications/jobs/results/',
      'https://news.ycombinator.com/jobs',
      'https://jobs.lever.co/acme',
      'https://www.linkedin.com/jobs/search/?keywords=platform',
      'https://jobs.careers.microsoft.com/global/en/search',
      'https://careers.oracle.com/jobs/',
      'https://www.freelancer.com/jobs/',
      'https://www.peopleperhour.com/freelance-jobs',
      'https://www.ycombinator.com/jobs',
      'https://jobs.a16z.com/',
      'https://remoteok.com/',
      'https://wellfound.com/jobs',
      'https://www.remoterocketship.com/',
      'https://remotive.com/remote-jobs',
      'https://www.workingnomads.com/jobs',
      'https://weworkremotely.com/remote-jobs',
      'https://remote.com/careers',
    ];

    for (const url of registeredProviderUrls) {
      expect(sourceIsCrawlable(activeSource(url))).toBe(true);
    }
    expect(
      sourceIsCrawlable(activeSource('https://remote.com/openings-admin')),
    ).toBe(false);
    expect(sourceIsCrawlable(activeSource('https://example.com/careers'))).toBe(
      false,
    );
    expect(
      sourceIsCrawlable(activeSource('https://example.com/careers'), true),
    ).toBe(true);
    expect(sourceIsCrawlable(activeSource('notaurl'), true)).toBe(false);
    for (const isActive of [false, null, undefined]) {
      expect(
        sourceIsCrawlable({
          isActive,
          url: 'https://jobs.ashbyhq.com/redcan',
        }),
      ).toBe(false);
    }
  });
});

function adapterContext(links: Link[] = []): AdapterContext {
  return {
    fetchPage: vi.fn(),
    scrapeIndex: vi.fn(async () => ({ links }) as never),
  } as unknown as AdapterContext;
}

it('discovers PeoplePerHour AI project cards from the public category page', async () => {
  const html = `
      <a class="item__url⤍ListItem⤚20ULx" href="https://www.peopleperhour.com/freelance-jobs/artificial-intelligence/artificial-intelligence-software-development/ai-product-engineer-needed-4502945">AI Product Engineer Needed</a>
      <p class="item__desc⤍ListItem⤚3f4JV">Build an AI-powered activity content platform with OpenAI, RAG, vector databases, Python and FastAPI.</p>
      <a class="item__url⤍ListItem⤚20ULx" href="https://www.peopleperhour.com/freelance-jobs/artificial-intelligence/artificial-intelligence-speech-audio/native-voice-recording-4504892">Native voice recording</a>
      <p class="item__desc⤍ListItem⤚3f4JV">Record short voice samples.</p>
    `;
  const fetchImpl = vi.fn(
    async () =>
      new Response(html, { headers: { 'content-type': 'text/html' } }),
  );

  const candidates = await discoverPeoplePerHourCandidates(
    {
      searchQuery: 'agentic platform AI automation',
      url: 'https://www.peopleperhour.com/freelance-jobs',
    },
    fetchImpl,
  );

  expect(fetchImpl).toHaveBeenCalledWith(
    'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence',
    expect.objectContaining({
      headers: expect.objectContaining({
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': expect.stringContaining('Mozilla/5.0'),
      }),
    }),
  );
  expect(candidates).toEqual([
    expect.objectContaining({
      employmentType: 'contract',
      externalId: '4502945',
      postingUrl:
        'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence/artificial-intelligence-software-development/ai-product-engineer-needed-4502945',
      resolvedDetail: expect.objectContaining({
        descriptionRaw: expect.stringContaining('AI-powered activity'),
        status: 'resolved',
      }),
      title: 'AI Product Engineer Needed',
      workMode: 'remote',
    }),
  ]);
});

it('falls back to the configured spider when PeoplePerHour HTTP returns an app shell', async () => {
  const shellHtml =
    '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const renderedHtml = `
      <a class="item__url⤍ListItem⤚20ULx" href="https://www.peopleperhour.com/freelance-jobs/artificial-intelligence/artificial-intelligence-software-development/devops-platform-engineer-needed-4502999">DevOps Platform Engineer Needed</a>
      <p class="item__desc⤍ListItem⤚3f4JV">Build an AI platform with Kubernetes, agents, automation, and distributed systems.</p>
    `;
  const fetchImpl = vi.fn(
    async () =>
      new Response(shellHtml, {
        headers: { 'content-type': 'text/html' },
        status: 202,
      }),
  );
  const spider = {
    fetch: vi.fn(async () =>
      spiderPage(
        renderedHtml,
        [],
        'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence',
      ),
    ),
  } as unknown as SpiderAdapter;

  const candidates = await discoverPeoplePerHourCandidates(
    {
      searchQuery: 'agentic platform AI automation Kubernetes',
      url: 'https://www.peopleperhour.com/freelance-jobs',
    },
    fetchImpl,
    spider,
  );

  expect(spider.fetch).toHaveBeenCalledWith(
    'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence',
    expect.objectContaining({
      cache: false,
      headers: expect.objectContaining({
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': expect.stringContaining('Mozilla/5.0'),
      }),
      timeout: 60000,
    }),
  );
  expect(candidates).toEqual([
    expect.objectContaining({
      externalId: '4502999',
      postingUrl:
        'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence/artificial-intelligence-software-development/devops-platform-engineer-needed-4502999',
      rawJson: expect.objectContaining({ fetchedVia: 'spider' }),
      title: 'DevOps Platform Engineer Needed',
    }),
  ]);
});

it('uses crawl4ai spider defaults from environment when configured', () => {
  const previous = {
    crawl4ai: process.env.HAVE_SPIDER_CRAWL4AI_URL,
    kubernetes: process.env.KUBERNETES_SERVICE_HOST,
  };
  try {
    process.env.HAVE_SPIDER_CRAWL4AI_URL = 'http://127.0.0.1:11235';
    delete process.env.KUBERNETES_SERVICE_HOST;

    expect(defaultOpportunitySpiderOptions()).toMatchObject({
      adapter: 'crawl4ai',
      baseUrl: 'http://127.0.0.1:11235',
      cacheDir: '.cache/opportunity-spider',
      waitUntil: 'networkidle',
    });
  } finally {
    if (previous.crawl4ai === undefined)
      delete process.env.HAVE_SPIDER_CRAWL4AI_URL;
    else process.env.HAVE_SPIDER_CRAWL4AI_URL = previous.crawl4ai;
    if (previous.kubernetes === undefined)
      delete process.env.KUBERNETES_SERVICE_HOST;
    else process.env.KUBERNETES_SERVICE_HOST = previous.kubernetes;
  }
});

it('uses the configured product identity for its crawl4ai user agent', () => {
  vi.stubEnv('HAVE_SPIDER_CRAWL4AI_URL', 'http://127.0.0.1:11235');
  vi.stubEnv('IOLAUS_APP_NAME', 'My Career Hub');

  expect(defaultOpportunitySpiderOptions()).toMatchObject({
    userAgent: 'Mozilla/5.0 (compatible; My Career Hub source crawler; )',
  });
});

it('records PeoplePerHour fetch body-shape diagnostics when production returns no cards', async () => {
  getCollection.mockReset();
  const opportunities = recordCollection();
  const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
  const sourceCrawlItems = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'Opportunity') return opportunities;
    if (name === 'SourceCrawl') return sourceCrawls;
    if (name === 'SourceCrawlItem') return sourceCrawlItems;
    throw new Error(`Unexpected collection ${name}`);
  });

  const fetchImpl = vi.fn(
    async () =>
      new Response(
        '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
  );

  const summary = await crawlOpportunitySource(
    {
      id: 'peopleperhour-source',
      name: 'PeoplePerHour - AI/platform contracts',
      searchQuery: 'AI engineer OR automation OR platform engineer',
      url: 'https://www.peopleperhour.com/freelance-jobs/artificial-intelligence',
    },
    { fetchImpl, intelligenceEnqueueCap: 0 },
  );

  expect(summary).toMatchObject({
    candidates: 0,
    created: 0,
    skipped: 0,
  });
  expect(summary.errors).toEqual([
    expect.stringContaining('PeoplePerHour fetch diagnostic'),
  ]);
  expect(summary.errors[0]).toContain('status=200');
  expect(summary.errors[0]).toContain(
    'bodyShape=app_shell_without_project_cards',
  );
  expect(summary.errors[0]).toContain('projectCardCount=0');
  expect(summary.errors[0]).toContain('matchedProjectCount=0');
  expect(sourceCrawls.records.at(-1)).toMatchObject({
    error: expect.stringContaining('PeoplePerHour fetch diagnostic'),
    resultCount: 0,
    status: 'completed_with_errors',
  });
  expect(sourceCrawlItems.records).toHaveLength(0);
});

it('records Contra login diagnostics when the authenticated source returns no candidates', async () => {
  getCollection.mockReset();
  const opportunities = recordCollection();
  const sourceCrawls = recordCollection([{ id: 'crawl-1' }]);
  const sourceCrawlItems = recordCollection();
  getCollection.mockImplementation(async (name: string) => {
    if (name === 'Opportunity') return opportunities;
    if (name === 'SourceCrawl') return sourceCrawls;
    if (name === 'SourceCrawlItem') return sourceCrawlItems;
    throw new Error(`Unexpected collection ${name}`);
  });

  const fetchImpl = vi.fn(
    async () =>
      new Response(
        '<html><body><h1>Welcome back to Contra</h1><button>Continue with Google</button></body></html>',
        {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
  );

  const summary = await crawlOpportunitySource(
    {
      id: 'contra-source',
      name: 'Contra - AI/platform contracts',
      searchQuery: 'AI engineer OR automation OR platform engineer',
      url: 'https://contra.com/opportunities',
    },
    { fetchImpl, intelligenceEnqueueCap: 0 },
  );

  expect(summary).toMatchObject({
    candidates: 0,
    created: 0,
    skipped: 0,
  });
  expect(summary.errors).toEqual([
    expect.stringContaining('Contra fetch diagnostic'),
  ]);
  expect(summary.errors[0]).toContain('status=200');
  expect(summary.errors[0]).toContain('bodyShape=login_required');
  expect(summary.errors[0]).toContain(
    'requires authenticated browser/session-backed crawler',
  );
  expect(sourceCrawls.records.at(-1)).toMatchObject({
    error: expect.stringContaining('Contra fetch diagnostic'),
    resultCount: 0,
    status: 'completed_with_errors',
  });
  expect(sourceCrawlItems.records).toHaveLength(0);
});

describe('job-board adapter engine', () => {
  it('detects greenhouse, ashby, and lever boards by URL, not generic pages', async () => {
    expect(
      (await detectJobBoard('https://boards.greenhouse.io/example'))?.type,
    ).toBe('greenhouse');
    expect(
      (await detectJobBoard('https://jobs.ashbyhq.com/redcan'))?.type,
    ).toBe('ashby');
    expect((await detectJobBoard('https://jobs.lever.co/acme'))?.type).toBe(
      'lever',
    );
    // No fallback requested → an unrecognized careers page resolves to nothing.
    expect(await detectJobBoard('https://example.com/careers')).toBeNull();
    expect(
      (
        await detectJobBoard('https://example.com/careers', {
          includeGeneric: true,
        })
      )?.type,
    ).toBe('generic-careers');
    expect(await detectJobBoard('notaurl')).toBeNull();
  });

  it('routes Coinbase careers through the Greenhouse board API despite the protected public page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://www.coinbase.com/careers/positions/7809557?gh_jid=7809557',
            content: '<p>Build crypto platform systems.</p>',
            first_published: '2026-06-20T00:00:00.000Z',
            id: 7809557,
            location: { name: 'Remote - Canada' },
            title: 'Senior Platform Engineer',
          },
        ],
      }),
    );

    const candidates = await discoverOpportunityCandidates(
      { url: 'https://www.coinbase.com/careers/positions' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/coinbase/jobs?content=true',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        externalId: '7809557',
        postingUrl:
          'https://www.coinbase.com/careers/positions/7809557?gh_jid=7809557',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('routes Fireblocks careers through the Greenhouse board API', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://www.fireblocks.com/careers/position?gh_jid=4684839006',
            content: '<p>Build secure crypto platform systems.</p>',
            first_published: '2026-01-01T00:00:00.000Z',
            id: 4684839006,
            location: { name: 'Remote' },
            title: 'Senior Platform Engineer',
          },
        ],
      }),
    );

    const candidates = await discoverOpportunityCandidates(
      { url: 'https://www.fireblocks.com/careers/' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/fireblocks/jobs?content=true',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        externalId: '4684839006',
        postingUrl:
          'https://www.fireblocks.com/careers/position?gh_jid=4684839006',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('routes Ripple careers through the Greenhouse board API', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://ripple.com/careers/all-jobs/job/8000106?gh_jid=8000106',
            content: '<p>Build crypto payment platform systems.</p>',
            first_published: '2026-06-20T00:00:00.000Z',
            id: 8000106,
            location: { name: 'Toronto, Canada' },
            title: 'Senior Platform Engineer',
          },
        ],
      }),
    );

    const candidates = await discoverOpportunityCandidates(
      { url: 'https://ripple.com/careers/all-jobs/' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/ripple/jobs?content=true',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        externalId: '8000106',
        postingUrl:
          'https://ripple.com/careers/all-jobs/job/8000106?gh_jid=8000106',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('routes a greenhouse source through the registry to its adapter', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url: 'https://boards.greenhouse.io/example/jobs/1',
            content: '<p>Build platform systems.</p>',
            first_published: '2026-01-01T00:00:00.000Z',
            id: 1,
            location: { name: 'Remote' },
            title: 'Staff Platform Engineer',
          },
        ],
      }),
    );

    const candidates = await discoverOpportunityCandidates(
      { url: 'https://boards.greenhouse.io/example' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://boards.greenhouse.io/example/jobs/1',
        title: 'Staff Platform Engineer',
      }),
    ]);
  });

  it('skips generic pages unless generic crawling is requested', async () => {
    const source = { url: 'https://example.com/careers' };
    expect(await discoverOpportunityCandidates(source)).toEqual([]);
  });
});

describe('generic careers posting discovery', () => {
  it('keeps direct posting links and drops ATS, social, and the index page', async () => {
    const ctx = adapterContext([
      {
        href: 'https://acme.com/careers/staff-engineer',
        text: 'Staff Engineer',
      },
      { href: 'https://acme.com/careers', text: 'All openings' }, // index page
      {
        href: 'https://jobs.ashbyhq.com/acme/abc',
        text: 'Handled by provider path',
      },
      { href: 'https://www.linkedin.com/company/acme', text: 'Follow us' },
      { href: 'https://acme.com/about', text: 'About' }, // not a posting URL
      {
        href: 'https://acme.com/jobs/2',
        text: '2',
        classes: ['btn', 'Pagination-item'],
      },
      {
        href: 'https://acme.com/jobs/platform/',
        text: 'Platform',
        classes: ['JobSearchCard-primary-tagsLink'],
      },
      {
        href: 'https://acme.com/job/',
        text: 'Jobs',
        classes: ['Breadcrumbs-link'],
      },
    ] as Link[]);

    const candidates = await discoverGenericPostingLinks(
      { url: 'https://acme.com/careers' },
      ctx,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://acme.com/careers/staff-engineer',
        title: 'Staff Engineer',
      }),
    ]);
  });

  it('filters generic job-description template pages from board crawls', async () => {
    const ctx = adapterContext([
      {
        href: 'https://arc.dev/job-descriptions',
        text: 'Job description templates',
      },
      {
        href: 'https://arc.dev/jobs/senior-platform-engineer',
        text: 'Senior Platform Engineer',
      },
    ] as Link[]);

    const candidates = await discoverGenericPostingLinks(
      { url: 'https://arc.dev/remote-jobs' },
      ctx,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl: 'https://arc.dev/jobs/senior-platform-engineer',
        title: 'Senior Platform Engineer',
      }),
    ]);
  });

  it('discovers Arc.dev remote job detail pages from the generic board scrape', async () => {
    const ctx = adapterContext([
      {
        href: 'https://arc.dev/remote-jobs/devops',
        text: 'DevOps engineers jobs',
      },
      {
        href: 'https://arc.dev/remote-jobs/details/senior-full-stack-software-engineer-healthcare-saas-pt-na-latam-oztbynjfco',
        text: 'Senior Full-Stack Software Engineer – Healthcare SaaS (PT-NA/LATAM)',
      },
    ] as Link[]);

    const candidates = await discoverGenericPostingLinks(
      { url: 'https://arc.dev/remote-jobs' },
      ctx,
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        postingUrl:
          'https://arc.dev/remote-jobs/details/senior-full-stack-software-engineer-healthcare-saas-pt-na-latam-oztbynjfco',
        title:
          'Senior Full-Stack Software Engineer – Healthcare SaaS (PT-NA/LATAM)',
      }),
    ]);
  });

  it('returns no generic posting candidates when the index scrape fails', async () => {
    const ctx = {
      fetchPage: vi.fn(),
      scrapeIndex: vi.fn(async () => {
        throw new Error('HTTP 404: Request failed');
      }),
    } as unknown as AdapterContext;

    await expect(
      discoverGenericPostingLinks({ url: 'https://example.com/careers' }, ctx),
    ).resolves.toEqual([]);
  });

  it('returns no generic provider candidates when the page fetch fails', async () => {
    const spider = {
      fetch: vi.fn(async () => {
        throw new Error('HTTP 404: Request failed');
      }),
    } as unknown as SpiderAdapter;

    await expect(
      discoverGenericProviderLinks(
        { url: 'https://example.com/careers' },
        spider,
      ),
    ).resolves.toEqual([]);
  });
});

describe('source board reconciliation', () => {
  const greenhouseSource = {
    id: 'source-1',
    name: 'Greenhouse',
    url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
  };
  const boardJob = {
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/123',
    content: '<p>Build platform and agent systems.</p>',
    id: 123,
    location: { name: 'Remote' },
    title: 'Staff Engineer',
  };

  function crawlCollections() {
    const opportunities = recordCollection([
      {
        id: 'existing-opportunity',
        postingUrl: boardJob.absolute_url,
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'found',
        title: boardJob.title,
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return recordCollection();
      if (name === 'SourceCrawlItem') return recordCollection();
      throw new Error(`Unexpected collection ${name}`);
    });
    return opportunities;
  }

  it('reconciles the board with the opportunities the crawl matched', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn(async () => ({
      archived: 0,
      missed: 2,
      refreshed: 1,
      seen: 1,
    }));

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
      reconcileSourceBoard,
    });

    expect(summary.errors).toEqual([]);
    expect(reconcileSourceBoard).toHaveBeenCalledWith({
      now: expect.any(Date),
      reconcileAbsence: true,
      seenOpportunityIds: ['existing-opportunity'],
      sourceCrawlId: expect.any(String),
      sourceId: 'source-1',
    });
  });

  it('leaves the board untouched when the crawl fails', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn();

    await expect(
      crawlOpportunitySource(greenhouseSource, {
        fetchImpl: vi.fn(async () => {
          throw new Error('board unavailable');
        }),
        reconcileSourceBoard,
      }),
    ).rejects.toThrow('board unavailable');

    expect(reconcileSourceBoard).not.toHaveBeenCalled();
  });

  it('leaves the board untouched when the crawl listed nothing', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn();

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [] })),
      reconcileSourceBoard,
    });

    expect(summary.candidates).toBe(0);
    expect(reconcileSourceBoard).not.toHaveBeenCalled();
  });

  it('re-stamps but never counts absence when a limit truncates the crawl', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn(async () => ({
      archived: 0,
      missed: 0,
      refreshed: 1,
      seen: 1,
    }));

    await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
      limit: 1,
      reconcileSourceBoard,
    });

    expect(reconcileSourceBoard).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileAbsence: false }),
    );
  });

  it('re-stamps but never counts absence for a source whose adapter caps or filters its results', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn(async () => ({
      archived: 0,
      missed: 0,
      refreshed: 0,
      seen: 0,
    }));

    // Remote OK caps at REMOTE_OK_MAX_CANDIDATES and filters by role, so a
    // successful crawl is a subset of the board, never the board itself.
    const summary = await crawlOpportunitySource(
      {
        id: 'source-1',
        name: 'Remote OK',
        searchQuery: 'AI engineer, platform engineer, devops, Kubernetes',
        url: 'https://remoteok.com/remote-dev+ai+devops-jobs',
      },
      {
        fetchImpl: vi.fn(async () =>
          jsonResponse([
            { last_updated: 1782518404 },
            {
              company: 'Platform Labs',
              date: '2026-06-26T12:00:00+00:00',
              description:
                '<p>Build Kubernetes automation for AI infrastructure.</p>',
              id: '1134001',
              location: 'Worldwide',
              position: 'Senior Platform Engineer, AI Infrastructure',
              slug: 'remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
              tags: ['devops', 'kubernetes', 'ai'],
              url: 'https://remoteok.com/remote-jobs/remote-senior-platform-engineer-ai-infrastructure-platform-labs-1134001',
            },
          ]),
        ),
        reconcileSourceBoard,
      },
    );

    expect(summary.candidates).toBeGreaterThan(0);
    expect(reconcileSourceBoard).not.toHaveBeenCalledWith(
      expect.objectContaining({ reconcileAbsence: true }),
    );
  });

  it('still counts absence when an irrelevant listing is skipped, and treats it as seen', async () => {
    // A whole-company board always lists roles this crawl skips as
    // irrelevant. Those are postings the board *did* list, so they must be
    // recorded as seen rather than aborting absence accounting — otherwise
    // archival would be permanently inert on every real board.
    const opportunities = recordCollection([
      {
        id: 'existing-opportunity',
        postingUrl: boardJob.absolute_url,
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'found',
        title: boardJob.title,
      },
      {
        id: 'irrelevant-opportunity',
        postingUrl: 'https://boards.greenhouse.io/acme/jobs/124',
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'found',
        title: 'Warehouse Associate',
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return recordCollection();
      if (name === 'SourceCrawlItem') return recordCollection();
      throw new Error(`Unexpected collection ${name}`);
    });
    const reconcileSourceBoard = vi.fn(async () => ({
      archived: 0,
      missed: 0,
      refreshed: 2,
      seen: 2,
    }));

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          jobs: [
            boardJob,
            {
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/124',
              content: '<p>Lift boxes onto pallets in the warehouse.</p>',
              id: 124,
              location: { name: 'Ohio' },
              title: 'Warehouse Associate',
            },
          ],
        }),
      ),
      reconcileSourceBoard,
    });

    expect(summary.skipped).toBeGreaterThan(0);
    expect(reconcileSourceBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        reconcileAbsence: true,
        seenOpportunityIds: expect.arrayContaining([
          'existing-opportunity',
          'irrelevant-opportunity',
        ]),
      }),
    );
  });

  it('still counts absence when a posting detail cannot be resolved, and treats it as seen', async () => {
    // Lever resolves every detail per posting, so one unresolvable posting
    // must not make absence accounting inert for the whole source.
    const leverJobId = '33538a2f-d27d-4a96-8f05-fa4b0e4d940e';
    const leverUrl = `https://jobs.lever.co/acme/${leverJobId}`;
    const opportunities = recordCollection([
      {
        externalId: leverJobId,
        id: 'lever-opportunity',
        postingUrl: leverUrl,
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'found',
        title: 'Staff Backend Engineer',
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return recordCollection();
      if (name === 'SourceCrawlItem') return recordCollection();
      throw new Error(`Unexpected collection ${name}`);
    });
    const reconcileSourceBoard = vi.fn(async () => ({
      archived: 0,
      missed: 0,
      refreshed: 1,
      seen: 1,
    }));

    const summary = await crawlOpportunitySource(
      { id: 'source-1', name: 'Lever', url: 'https://jobs.lever.co/acme' },
      {
        fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('?mode=json')) {
            return jsonResponse([
              {
                categories: {
                  commitment: 'Full Time',
                  location: 'Remote - US',
                },
                createdAt: 1553186035299,
                hostedUrl: leverUrl,
                id: leverJobId,
                text: 'Staff Backend Engineer',
                workplaceType: 'remote',
              },
            ]);
          }
          // The per-posting detail fetch fails.
          return new Response('', { status: 503 });
        }),
        reconcileSourceBoard,
      },
    );

    expect(summary.skipped).toBeGreaterThan(0);
    expect(reconcileSourceBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        reconcileAbsence: true,
        seenOpportunityIds: expect.arrayContaining(['lever-opportunity']),
      }),
    );
  });

  it('records a reconciliation failure without failing the crawl', async () => {
    crawlCollections();
    const reconcileSourceBoard = vi.fn(async () => {
      throw new Error('reconciliation unavailable');
    });

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
      reconcileSourceBoard,
    });

    expect(summary.errors).toEqual([
      'Board reconciliation failed: reconciliation unavailable',
    ]);
  });
});

describe('legacy source content fingerprints', () => {
  const greenhouseSource = {
    id: 'source-1',
    name: 'Greenhouse',
    url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
  };
  const boardJob = {
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/123',
    content: '<p>Build platform and agent systems.</p>',
    id: 123,
    location: { name: 'Remote' },
    title: 'Staff Engineer',
  };

  function legacyCollections(overrides: Record<string, unknown> = {}) {
    const opportunities = recordCollection([
      {
        id: 'existing-opportunity',
        postingUrl: boardJob.absolute_url,
        save: vi.fn(async () => {}),
        sourceId: 'source-1',
        status: 'found',
        title: boardJob.title,
        ...overrides,
      },
    ]);
    getCollection.mockImplementation(async (name: string) => {
      if (name === 'Opportunity') return opportunities;
      if (name === 'SourceCrawl') return recordCollection();
      if (name === 'SourceCrawlItem') return recordCollection();
      throw new Error(`Unexpected collection ${name}`);
    });
    return opportunities;
  }

  /** True for either fence shape: the object form or the baseline OR form. */
  const mentionsFingerprint = (criteria: unknown): boolean =>
    Array.isArray(criteria)
      ? criteria.some((group: unknown[]) => group.some(mentionsFingerprint))
      : Object.hasOwn(
          (criteria ?? {}) as Record<string, unknown>,
          'source_content_fingerprint',
        );

  const sourceFenceCalls = () =>
    databaseUpdate.mock.calls.filter(
      (call) =>
        (call as unknown[])[0] === 'opportunities' &&
        mentionsFingerprint((call as unknown[])[1]),
    ) as unknown as Array<[string, unknown, Record<string, unknown>]>;

  const baselineFence = (id: string) => [
    [{ id }, { source_content_fingerprint: null }],
    [{ id }, { source_content_fingerprint: '' }],
  ];

  it('treats a null stored fingerprint as a baseline write, not a conflict', async () => {
    legacyCollections();

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
    });

    expect(summary.errors).toEqual([]);
    const [criteria, updates] = sourceFenceCalls()[0].slice(1) as [
      unknown,
      Record<string, unknown>,
    ];
    expect(criteria).toEqual(baselineFence('existing-opportunity'));
    expect(updates.source_content_fingerprint).toEqual(expect.any(String));
    expect(updates.source_content_fingerprint).not.toBe('');
    expect(updates.source_content_version).toBe(1);
  });

  it('treats an empty stored fingerprint as a baseline write too', async () => {
    // A row created through the SMRT model without source content holds the
    // field default '' rather than SQL NULL; it must not be fenced out of its
    // own first baseline write either.
    legacyCollections({
      sourceContentFingerprint: '',
      sourceContentVersion: 0,
    });

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
    });

    expect(summary.errors).toEqual([]);
    expect(sourceFenceCalls()[0][1]).toEqual(
      baselineFence('existing-opportunity'),
    );
  });

  it('still fences on the stored fingerprint once one exists', async () => {
    const sourceContent = {
      canonicalUrl: boardJob.absolute_url,
      descriptionRaw: 'Build platform and agent systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: boardJob.title,
    };
    legacyCollections({
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(sourceContent),
      sourceContentJson: JSON.stringify(sourceContent),
      sourceContentVersion: 4,
    });

    await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
    });

    expect(sourceFenceCalls()[0][1]).toEqual({
      id: 'existing-opportunity',
      source_content_fingerprint:
        fingerprintOpportunitySourceContent(sourceContent),
      source_content_version: 4,
    });
  });

  it('reports a conflict when a concurrent writer keeps winning the fence', async () => {
    const sourceContent = {
      canonicalUrl: boardJob.absolute_url,
      descriptionRaw: 'Build platform and agent systems.',
      externalId: '123',
      locationNotes: 'Remote',
      title: boardJob.title,
    };
    legacyCollections({
      sourceContentFingerprint:
        fingerprintOpportunitySourceContent(sourceContent),
      sourceContentJson: JSON.stringify(sourceContent),
      sourceContentVersion: 4,
    });
    databaseUpdate.mockResolvedValue({ affected: 0 });

    const summary = await crawlOpportunitySource(greenhouseSource, {
      fetchImpl: vi.fn(async () => jsonResponse({ jobs: [boardJob] })),
    });

    expect(summary.errors.join(' ')).toContain(
      'changed concurrently too many times',
    );
  });
});

it('does not infer a private crawler service from Kubernetes presence', () => {
  vi.stubEnv('KUBERNETES_SERVICE_HOST', '127.0.0.1');
  vi.stubEnv('HAVE_SPIDER_CRAWL4AI_URL', '');
  vi.stubEnv('CRAWL4AI_URL', '');
  vi.stubEnv('CRAWL4AI_BASE_URL', '');
  try {
    expect(defaultOpportunitySpiderOptions()).toEqual({
      adapter: 'simple',
      cacheDir: '.cache/opportunity-spider',
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
