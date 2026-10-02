import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeWorkspaceSubject } from './job-workspace-subject.js';
import type { WorkspaceWorkflowCapability } from './workspace-workflow-capabilities.js';

const auth = vi.hoisted(() => ({ active: true }));
vi.mock('./source-crawl-operator.js', () => ({
  requireSourceCrawlOperator: () => {
    if (!auth.active) throw new Error('Operator revoked.');
  },
  captureSourceCrawlOperator: vi.fn(),
  assertSourceCrawlOperations: async (run: {
    assertOperation: (c: string, a: string) => Promise<void>;
  }) => {
    await run.assertOperation('sources', 'read');
    await run.assertOperation('sources', 'update');
  },
}));
vi.mock('./job-workspace-subject.js', () => ({
  runAsRevalidatedJobWorkspaceSubject: vi.fn(),
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) => {
    const subject = args.runtimeWorkspaceSubject as Record<string, unknown>;
    if (
      !subject ||
      ['tenantId', 'userId', 'profileId'].some(
        (key) =>
          typeof subject[key] !== 'string' ||
          !subject[key] ||
          subject[key] !== (subject[key] as string).trim(),
      )
    ) {
      throw new Error('Explicit runtime subject required.');
    }
    return subject;
  },
}));
vi.mock('./source-schedules.js', () => ({
  SOURCE_JOB_OBJECT_TYPE: '@willgriffin/iolaus-site:Source',
  SOURCE_CRAWL_METHOD: 'crawl',
  nextRunForCron: () => new Date('2026-10-03T00:00:00.000Z'),
}));
vi.mock('./source-webmcp.js', () => ({ enqueueRootSourceCrawl: vi.fn() }));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./db.js', () => ({ getDbConfig: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({ resolveDatabase: vi.fn() }));
vi.mock('@happyvertical/smrt-agents', () => ({
  AgentScheduleCollection: { create: vi.fn() },
}));

import {
  dispatchDueSourceCrawls,
  type SourceCrawlDispatcherDependencies,
} from './source-crawl-dispatcher.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CRAWL = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-02T10:00:00.000Z');
const operator = {
  tenantId: 'tenant-a',
  profileId: 'profile-a',
  userId: 'user-a',
};
function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-a',
    agentId: SOURCE,
    agentType: '@willgriffin/iolaus-site:Source',
    method: 'crawl',
    enabled: true,
    status: 'active',
    tenantId: operator.tenantId,
    timezone: 'UTC',
    cron: '0 0 * * *',
    nextRun: new Date('2026-10-02T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    methodArgs: { runtimeWorkspaceSubject: operator },
    ...overrides,
  };
}
function harness(overrides: Record<string, unknown> = {}) {
  let current = schedule(overrides);
  const receipt = {
    crawlId: CRAWL,
    jobId: JOB,
    sourceId: SOURCE,
    reused: false,
    status: 'pending',
  };
  const update = vi.fn(
    async (
      _table: string,
      where: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      if (where.next_run !== new Date(current.nextRun).toISOString())
        return { affected: 0 };
      current = {
        ...current,
        nextRun: new Date(String(data.next_run)),
        updated_at: new Date(String(data.updated_at)),
      };
      return { affected: 1 };
    },
  );
  const list = vi.fn(async () => [structuredClone(current)]);
  // Mirror native collection.get: a non-UUID string is a slug, not a text PK.
  const get = vi.fn(
    async (filter: string | { id: string }, _options?: { cache: false }) =>
      typeof filter === 'object' && filter.id === current.id
        ? structuredClone(current)
        : null,
  );
  const source = {
    id: SOURCE,
    sourceRole: 'root',
    parentSourceId: null,
    isActive: true,
  };
  const sources = { get: vi.fn(async () => source as Record<string, unknown>) };
  const assertOperation = vi.fn(async () => undefined);
  const revalidate = vi.fn(
    async <T>(
      subject: RuntimeWorkspaceSubject,
      capability: WorkspaceWorkflowCapability | undefined,
      work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
    ) => {
      expect(subject).toEqual(operator);
      expect(capability).toBe('audit.record');
      if (!auth.active) throw new Error('Membership revoked.');
      return await work(operator, {
        assertOperation,
      } as unknown as PrincipalRun);
    },
  );
  const enqueue = vi.fn(async () => receipt);
  const database = { update };
  const options = {
    allowSourceIds: [SOURCE],
    now: NOW,
    database: database as never,
  };
  const dependencies = {
    schedules: { list, get },
    sources,
    enqueue,
    captureOperator: () => operator,
    revalidate,
  } as unknown as SourceCrawlDispatcherDependencies;
  return {
    options,
    dependencies,
    update,
    list,
    get,
    sources,
    revalidate,
    assertOperation,
    enqueue,
    receipt,
    replace: (fields: Record<string, unknown>) => {
      current = schedule(fields);
    },
  };
}

beforeEach(() => {
  auth.active = true;
});
describe('bounded native source schedule dispatcher', () => {
  it('selects a legacy textual primary key exactly: before due zero, at due once, repeated tick zero', async () => {
    const id = `source-crawl:${SOURCE}`;
    const h = harness({ id });
    h.list.mockImplementation(async (...args: unknown[]) => {
      const where = (args[0] as { where: Record<string, unknown> }).where;
      const current = await h.get({ id }, { cache: false });
      return current &&
        new Date(current.nextRun) <= new Date(where['nextRun <='] as Date)
        ? [current]
        : [];
    });
    const early = await dispatchDueSourceCrawls(
      { ...h.options, now: new Date('2026-10-01T23:59:00Z') },
      h.dependencies,
    );
    expect(early).toEqual({ scanned: 0, outcomes: [] });
    expect(h.enqueue).not.toHaveBeenCalled();
    const due = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(due.outcomes[0]).toMatchObject({
      scheduleId: id,
      status: 'dispatched',
    });
    expect(h.get).toHaveBeenCalledWith({ id }, { cache: false });
    expect(h.update).toHaveBeenCalledWith(
      '_smrt_agent_schedules',
      expect.objectContaining({ id }),
      expect.any(Object),
    );
    const repeated = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(repeated).toEqual({ scanned: 0, outcomes: [] });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it('admits only due source schedules, uses audited native enqueue, then advances by revision', async () => {
    const h = harness();
    const result = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(result.outcomes[0]).toMatchObject({
      status: 'dispatched',
      receipt: h.receipt,
    });
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        where: expect.objectContaining({
          agentType: '@willgriffin/iolaus-site:Source',
          method: 'crawl',
          tenantId: operator.tenantId,
          'agentId in': [SOURCE],
          'nextRun <=': NOW,
        }),
      }),
    );
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: SOURCE,
        limit: 75,
        idempotencyKey: expect.stringMatching(/^source-schedule-[a-f0-9]{64}$/),
      }),
      { id: operator.userId },
      expect.objectContaining({ database: h.options.database }),
    );
    expect(h.update).toHaveBeenCalledWith(
      '_smrt_agent_schedules',
      expect.objectContaining({
        tenant_id: operator.tenantId,
        next_run: '2026-10-02T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      expect.objectContaining({ next_run: '2026-10-03T00:00:00.000Z' }),
    );
    expect(h.revalidate).toHaveBeenCalledTimes(3);
    expect(h.assertOperation).toHaveBeenCalledWith('sources', 'update');
  });

  it.each([
    ['future', { nextRun: new Date('2026-10-03T00:00:00.000Z') }],
    ['unbound', { methodArgs: {} }],
    [
      'malformed',
      {
        methodArgs: {
          runtimeWorkspaceSubject: { ...operator, userId: ' bad' },
        },
      },
    ],
    ['foreign tenant', { tenantId: 'tenant-b' }],
    [
      'foreign user',
      {
        methodArgs: {
          runtimeWorkspaceSubject: { ...operator, userId: 'user-b' },
        },
      },
    ],
    [
      'foreign profile',
      {
        methodArgs: {
          runtimeWorkspaceSubject: { ...operator, profileId: 'profile-b' },
        },
      },
    ],
    ['unadmitted source', { agentId: OTHER }],
    ['disabled', { enabled: false }],
    ['wrong method', { method: 'run' }],
    ['wrong type', { agentType: '@willgriffin/iolaus-site:Application' }],
    ['non-UTC', { timezone: 'America/Toronto' }],
    ['missing revision', { updated_at: undefined }],
  ])('refuses %s without enqueue or advancement', async (_label, fields) => {
    const h = harness(fields);
    const result = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(result.outcomes[0].status).toBe('refused');
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ['not-an-id'],
    Array(76).fill(SOURCE),
  ])('rejects invalid admission lists before reads', async (ids) => {
    const h = harness();
    await expect(
      dispatchDueSourceCrawls(
        { ...h.options, allowSourceIds: ids },
        h.dependencies,
      ),
    ).rejects.toThrow('allowSourceIds');
    expect(h.list).not.toHaveBeenCalled();
  });
  it('caps both the schedule scan and posting work and never expands the allowlist', async () => {
    const h = harness();
    h.list.mockResolvedValue(
      Array.from({ length: 76 }, (_, i) =>
        schedule({ id: `schedule-${i}`, agentId: OTHER }),
      ),
    );
    const result = await dispatchDueSourceCrawls(
      { ...h.options, maxSchedules: 75, sourceLimit: 1 },
      h.dependencies,
    );
    expect(result.scanned).toBe(75);
    expect(result.outcomes).toHaveLength(75);
    expect(h.enqueue).not.toHaveBeenCalled();
    await expect(
      dispatchDueSourceCrawls(
        { ...h.options, sourceLimit: 76 },
        h.dependencies,
      ),
    ).rejects.toThrow('sourceLimit');
  });
  it('refuses stale principal authority before dispatch', async () => {
    const h = harness();
    h.revalidate.mockImplementationOnce(async (_subject, _capability, work) => {
      const output = await work(operator, {
        assertOperation: h.assertOperation,
      } as unknown as PrincipalRun);
      auth.active = false;
      return output;
    });
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .status,
    ).toBe('refused');
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it('revalidates after enqueue and retains receipt without advancing after revocation', async () => {
    const h = harness();
    h.enqueue.mockImplementation(async () => {
      auth.active = false;
      return h.receipt;
    });
    const result = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(result.outcomes[0]).toMatchObject({
      status: 'refused',
      receipt: h.receipt,
      error: 'Membership revoked.',
    });
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each([
    { tenantId: 'foreign' },
    { isActive: false },
    { sourceRole: 'posting_derived', parentSourceId: OTHER },
  ])('rechecks source admission and provenance at dispatch', async (fields) => {
    const h = harness();
    h.sources.get.mockResolvedValue({
      sourceRole: 'root',
      isActive: true,
      ...fields,
    });
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .status,
    ).toBe('refused');
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('keeps active/conflicting source revisions due', async () => {
    const h = harness();
    h.enqueue.mockRejectedValue(
      new Error('Source already has an active crawl.'),
    );
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .error,
    ).toContain('active crawl');
    expect(h.update).not.toHaveBeenCalled();
  });
  it('requires a durable receipt before advancing', async () => {
    const h = harness();
    h.enqueue.mockResolvedValue({ ...h.receipt, crawlId: '' });
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .status,
    ).toBe('refused');
    expect(h.update).not.toHaveBeenCalled();
  });
  it('retries a failed CAS using the same deterministic accepted job', async () => {
    const h = harness();
    const seen = new Set<string>();
    h.enqueue.mockImplementation(async (...args: unknown[]) => {
      const key = (args[0] as { idempotencyKey: string }).idempotencyKey;
      const reused = seen.has(key);
      seen.add(key);
      return { ...h.receipt, reused };
    });
    h.update.mockRejectedValueOnce(
      new Error('Database temporarily unavailable.'),
    );
    const first = await dispatchDueSourceCrawls(h.options, h.dependencies);
    const second = await dispatchDueSourceCrawls(h.options, h.dependencies);
    expect(first.outcomes[0]).toMatchObject({
      status: 'refused',
      receipt: h.receipt,
    });
    expect(second.outcomes[0]).toMatchObject({
      status: 'dispatched',
      receipt: { reused: true },
    });
    expect(seen.size).toBe(1);
  });
  it('concurrent ticks reuse one durable revision and only one CAS advances', async () => {
    const h = harness();
    const keys = new Set<string>();
    h.enqueue.mockImplementation(async (...args: unknown[]) => {
      keys.add((args[0] as { idempotencyKey: string }).idempotencyKey);
      return { ...h.receipt, reused: keys.size === 1 };
    });
    const results = await Promise.all([
      dispatchDueSourceCrawls(h.options, h.dependencies),
      dispatchDueSourceCrawls(h.options, h.dependencies),
    ]);
    expect(keys.size).toBe(1);
    expect(
      results
        .flatMap((result) => result.outcomes)
        .filter((outcome) => outcome.status === 'dispatched'),
    ).toHaveLength(1);
  });
  it('does not overwrite completion sync or a changed schedule revision', async () => {
    const h = harness();
    h.enqueue.mockImplementation(async () => {
      h.replace({ nextRun: new Date('2026-10-03T01:00:00Z') });
      return h.receipt;
    });
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .status,
    ).toBe('superseded');
    expect(h.update).not.toHaveBeenCalled();
  });
  it('advances a terminal deduplicated receipt without creating a new crawl', async () => {
    const h = harness();
    h.enqueue.mockResolvedValue({
      ...h.receipt,
      reused: true,
      status: 'completed',
    });
    expect(
      (await dispatchDueSourceCrawls(h.options, h.dependencies)).outcomes[0]
        .status,
    ).toBe('dispatched');
  });
});
