import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = { query: vi.fn() };
  const database = {
    transaction: vi.fn(
      async (work: (tx: unknown) => Promise<unknown>) =>
        await work(transaction),
    ),
  };
  const sources = { list: vi.fn() };
  return {
    transaction,
    database,
    sources,
    config: { type: 'postgres' },
    getCollection: vi.fn(async () => sources),
    sourceCreate: vi.fn(),
    crawl: vi.fn(),
    importPosting: vi.fn(),
    process: vi.fn(),
    validate: vi.fn(),
    operator: vi.fn(),
    sqliteLock: vi.fn(
      async (_key: string, work: () => Promise<unknown>) => await work(),
    ),
    owner: vi.fn(),
    tool: vi.fn(),
    operation: vi.fn(),
    crawlOperations: vi.fn(),
  };
});
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => mocks.database),
}));
vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: () => mocks.database,
}));
vi.mock('./db.js', () => ({ getDbConfig: () => mocks.config }));
vi.mock('./smrt.js', () => ({ getCollection: mocks.getCollection }));
vi.mock('./owner-principal.js', () => ({ runAsOwner: mocks.owner }));
vi.mock('./workspace-subject.js', () => ({
  workspaceSubjectFromLocals: (locals: { workspaceSubject?: unknown }) =>
    locals.workspaceSubject,
  requireCandidateWorkspaceSubject: (subject: {
    tenantId?: string;
    userId?: string;
    profileId?: string;
  }) => {
    if (!subject?.tenantId || !subject.userId || !subject.profileId)
      throw Object.assign(new Error('verified profile required'), {
        status: 403,
      });
    return subject;
  },
}));
vi.mock('./workspace-workflow-capabilities.js', () => ({
  workspaceWorkflowOperation: (capability: string) => ({
    collection: capability,
    action: 'execute',
  }),
}));
vi.mock('./public-https.js', () => ({
  PUBLIC_HTTPS_TIMEOUT_MS: 15000,
  validatePublicHttpsUrl: mocks.validate,
}));
vi.mock('./source-crawl-operator.js', () => ({
  requireSourceCrawlOperator: mocks.operator,
  assertSourceCrawlOperations: mocks.crawlOperations,
}));
vi.mock('./source-webmcp.js', () => ({
  createRootSourceFromWebMcp: mocks.sourceCreate,
  enqueueRootSourceCrawl: mocks.crawl,
}));
vi.mock('./job-search-webmcp.js', () => ({
  importJobOpportunity: mocks.importPosting,
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: mocks.process,
}));
vi.mock('./sqlite-operation-lock.js', () => ({
  withSqliteOperationLock: mocks.sqliteLock,
  KeyedLockTimeoutError: class extends Error {},
}));

import { ingestPublicUrl } from './url-intake';

const subject = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  profileId: 'profile-1',
};
const locals = { user: { id: 'user-1' }, workspaceSubject: subject };
const board = 'https://jobs.ashbyhq.com/acme';
const posting = `${board}/d78184cd-027f-4932-8613-bf8c94d536ae`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.type = 'postgres';
  mocks.sources.list.mockResolvedValue([]);
  mocks.sourceCreate.mockResolvedValue({ id: 'source-1' });
  mocks.crawl.mockResolvedValue({
    jobId: 'job-1',
    crawlId: 'crawl-1',
    reused: false,
    status: 'pending',
  });
  mocks.importPosting.mockResolvedValue({
    created: true,
    opportunity: { id: 'opp-1' },
    detail: { status: 'resolved', message: 'Imported' },
  });
  mocks.process.mockResolvedValue({
    job: { id: 'job-2' },
    stage: 'source_preparation',
    enqueued: true,
  });
  mocks.validate.mockResolvedValue({});
  mocks.operator.mockImplementation(() => undefined);
  mocks.tool.mockImplementation(() => undefined);
  mocks.operation.mockResolvedValue(undefined);
  mocks.owner.mockImplementation(
    async (_locals: unknown, work: (run: unknown) => Promise<unknown>) =>
      await work({
        assertToolAllowed: mocks.tool,
        assertOperation: mocks.operation,
      }),
  );
});

describe('native shared URL intake', () => {
  it('offers uncertain pages a choice after fresh authorization without fetching or mutating', async () => {
    expect(
      await ingestPublicUrl({ url: 'https://careers.example.com' }, locals),
    ).toMatchObject({ status: 'needs_choice', kind: 'choice' });
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.importPosting).not.toHaveBeenCalled();
    expect(mocks.sourceCreate).not.toHaveBeenCalled();
  });

  it('imports a posting and queues the existing private preparation workflow with fresh authority', async () => {
    expect(await ingestPublicUrl({ url: posting }, locals)).toMatchObject({
      status: 'queued',
      kind: 'opportunity',
      href: '/admin/opportunities/opp-1',
      jobId: 'job-2',
    });
    expect(mocks.importPosting).toHaveBeenCalledWith(
      { url: posting },
      locals.user,
    );
    expect(mocks.process).toHaveBeenCalledWith('opp-1', {
      modes: 'assessment',
      reason: 'url_intake',
    });
    expect(
      mocks.owner.mock.calls.map(
        (call) => (call[2] as { action: string }).action,
      ),
    ).toEqual([
      'admin.url_intake.detect',
      'admin.url_intake.import',
      'admin.url_intake.process',
    ]);
    expect(mocks.operation).toHaveBeenCalledWith(
      'assessment.execute',
      'execute',
    );
  });

  it.each([
    'unsupported',
    'not_found',
  ])('keeps unavailable posting details saved without claiming processing for %s', async (status) => {
    mocks.importPosting.mockResolvedValue({
      created: true,
      opportunity: { id: 'opp-1' },
      detail: { status, message: 'Static details unavailable' },
    });
    expect(await ingestPublicUrl({ url: posting }, locals)).toMatchObject({
      status: 'saved',
      message: expect.stringContaining('Static details unavailable'),
    });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('does not fabricate an identifier when the native enqueue response omits its optional ID', async () => {
    mocks.process.mockResolvedValue({
      job: { id: null },
      stage: 'source_preparation',
      enqueued: true,
    });
    const result = await ingestPublicUrl({ url: posting }, locals);
    expect(result.status).toBe('queued');
    expect(result).not.toHaveProperty('jobId');
    expect(mocks.process).toHaveBeenCalledOnce();
  });

  it('preserves a saved posting when processing authority is revoked at the next boundary', async () => {
    mocks.process.mockRejectedValue(new Error('membership revoked'));
    expect(await ingestPublicUrl({ url: posting }, locals)).toMatchObject({
      status: 'saved',
      href: '/admin/opportunities/opp-1',
      message: expect.stringContaining('not queued'),
    });
  });

  it.each([
    'postgres',
    'sqlite',
  ])('creates only an ad-hoc native source using the locked %s executor', async (type) => {
    mocks.config.type = type;
    expect(await ingestPublicUrl({ url: board }, locals)).toMatchObject({
      status: 'queued',
      created: true,
      kind: 'source',
    });
    expect(mocks.getCollection).toHaveBeenCalledWith('Source', {
      db: mocks.transaction,
    });
    expect(mocks.sources.list).toHaveBeenCalledWith({
      limit: 2,
      where: { url: board, sourceRole: 'root' },
    });
    expect(mocks.sourceCreate).toHaveBeenCalledWith(
      {
        url: board,
        name: 'acme careers',
        provider: 'ashby',
        type: 'company_careers',
        active: true,
      },
      locals.user,
      { database: mocks.transaction, sourceCollection: mocks.sources },
    );
    expect(mocks.crawl).toHaveBeenCalledWith(
      {
        sourceId: 'source-1',
        idempotencyKey: expect.stringMatching(/^url-intake:v1:[0-9a-f]{64}$/),
        limit: 25,
        reason: 'url_intake',
      },
      locals.user,
    );
    if (type === 'sqlite') expect(mocks.sqliteLock).toHaveBeenCalledOnce();
    else
      expect(mocks.transaction.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext(?))',
        [expect.stringMatching(/^url-intake-source:/)],
      );
  });

  it('reuses the existing source and stable initial crawl request across canonical alias retries', async () => {
    mocks.sources.list.mockResolvedValue([{ id: 'source-1', isActive: true }]);
    mocks.crawl.mockResolvedValue({
      jobId: 'job-1',
      crawlId: 'crawl-1',
      reused: true,
      status: 'running',
    });
    await ingestPublicUrl({ url: board }, locals);
    const again = await ingestPublicUrl(
      { url: `${board}/?utm_source=share#top` },
      locals,
    );
    expect(again).toMatchObject({
      created: false,
      status: 'queued',
      message: expect.stringContaining('already requested'),
    });
    expect(mocks.sourceCreate).not.toHaveBeenCalled();
    expect(mocks.crawl.mock.calls[0]?.[0]).toEqual(
      mocks.crawl.mock.calls[1]?.[0],
    );
    await ingestPublicUrl(
      { url: board },
      { ...locals, workspaceSubject: { ...subject, profileId: 'profile-2' } },
    );
    expect(mocks.crawl.mock.calls[2]?.[0].idempotencyKey).not.toBe(
      mocks.crawl.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it.each([
    'completed',
    'completed_with_errors',
    'failed',
    'timed_out',
  ])('reports %s initial requests without claiming new queued work', async (status) => {
    mocks.sources.list.mockResolvedValue([{ id: 'source-1', isActive: true }]);
    mocks.crawl.mockResolvedValue({
      jobId: 'job-1',
      crawlId: 'crawl-1',
      reused: true,
      status,
    });
    expect(await ingestPublicUrl({ url: board }, locals)).toMatchObject({
      status: 'saved',
      message: expect.stringContaining(`initial pull is ${status}`),
    });
    expect(mocks.sourceCreate).not.toHaveBeenCalled();
  });

  it('preserves paused sources and queue failures instead of enabling schedules or losing saved records', async () => {
    mocks.sources.list.mockResolvedValue([{ id: 'source-1', isActive: false }]);
    expect(await ingestPublicUrl({ url: board }, locals)).toMatchObject({
      status: 'saved',
      created: false,
      message: expect.stringContaining('paused'),
    });
    expect(mocks.crawl).not.toHaveBeenCalled();
    mocks.sources.list.mockResolvedValue([]);
    mocks.crawl.mockRejectedValue(new Error('queue unavailable'));
    expect(await ingestPublicUrl({ url: board }, locals)).toMatchObject({
      status: 'saved',
      created: true,
      message: expect.stringContaining('not queued'),
    });
  });

  it('does not enqueue after creation/audit transaction failure or ambiguous existing roots', async () => {
    mocks.sourceCreate.mockRejectedValue(new Error('audit rollback'));
    await expect(ingestPublicUrl({ url: board }, locals)).rejects.toThrow(
      'audit rollback',
    );
    expect(mocks.crawl).not.toHaveBeenCalled();
    mocks.sources.list.mockResolvedValue([
      { id: 'source-1' },
      { id: 'source-2' },
    ]);
    await expect(ingestPublicUrl({ url: board }, locals)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(mocks.crawl).not.toHaveBeenCalled();
  });

  it('denies missing subject, revoked native authority, and private destinations before mutations', async () => {
    await expect(
      ingestPublicUrl({ url: board }, { user: locals.user }),
    ).rejects.toMatchObject({ status: 403 });
    mocks.owner.mockRejectedValueOnce(new Error('membership revoked'));
    await expect(ingestPublicUrl({ url: posting }, locals)).rejects.toThrow(
      'membership revoked',
    );
    mocks.validate.mockRejectedValueOnce(new Error('private destination'));
    await expect(ingestPublicUrl({ url: posting }, locals)).rejects.toThrow(
      'private destination',
    );
    expect(mocks.importPosting).not.toHaveBeenCalled();
    expect(mocks.sourceCreate).not.toHaveBeenCalled();
  });

  it('denies non-operator source creation and native tool/operation denials before writes', async () => {
    mocks.operator.mockImplementationOnce(() => {
      throw new Error('operator required');
    });
    await expect(ingestPublicUrl({ url: board }, locals)).rejects.toMatchObject(
      { status: 403 },
    );
    mocks.tool.mockImplementationOnce(() => {
      throw new Error('tool denied');
    });
    await expect(ingestPublicUrl({ url: posting }, locals)).rejects.toThrow(
      'tool denied',
    );
    mocks.operation.mockRejectedValueOnce(new Error('operation denied'));
    await expect(ingestPublicUrl({ url: posting }, locals)).rejects.toThrow(
      'operation denied',
    );
    expect(mocks.sourceCreate).not.toHaveBeenCalled();
    expect(mocks.importPosting).not.toHaveBeenCalled();
  });
});
