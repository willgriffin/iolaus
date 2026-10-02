import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: true,
  operator: true,
  fresh: vi.fn(),
  assert: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('./workspace-subject.js', () => ({
  isCurrentWorkspaceOperator: () => mocks.operator,
}));
vi.mock('./source-schedules.js', () => ({
  SOURCE_CRAWL_METHOD: 'crawl',
  SOURCE_CRAWL_QUEUE: 'source-crawls',
  SOURCE_JOB_OBJECT_TYPE: '@willgriffin/iolaus-site:Source',
}));
vi.mock('./job-workspace-subject.js', () => ({
  captureRuntimeWorkspaceSubject: mocks.capture,
  requireActiveRunnerExecutionContext: (context: unknown) => {
    if (!mocks.active || !context)
      throw new Error('active TaskRunner execution context');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) => {
    if (!args.runtimeWorkspaceSubject)
      throw new Error('runtime workspace subject');
    return args.runtimeWorkspaceSubject;
  },
  assertJobTenantMatchesRuntimeWorkspaceSubject: (
    job: { tenantId?: string },
    subject: { tenantId: string },
  ) => {
    if (job.tenantId !== subject.tenantId)
      throw new Error('tenant does not match');
  },
  runAsRevalidatedJobWorkspaceSubject: mocks.fresh,
}));

import {
  captureSourceCrawlOperator,
  runAsSourceCrawlOperator,
} from './source-crawl-operator';

const subject = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  profileId: 'profile-1',
};
function context() {
  return {
    job: {
      jobId: 'job-1',
      attempt: 1,
      tenantId: subject.tenantId,
      queue: 'source-crawls',
      objectType: '@willgriffin/iolaus-site:Source',
      method: 'crawl',
    },
  } as never;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = true;
  mocks.operator = true;
  mocks.capture.mockReturnValue(subject);
  mocks.assert.mockResolvedValue(undefined);
  mocks.fresh.mockImplementation(async (_subject, capability, work) => {
    expect(capability).toBe('audit.record');
    return await work(subject, { assertOperation: mocks.assert });
  });
});
describe('source crawl operator dispatch', () => {
  it('captures only the verified installation operator', () => {
    expect(captureSourceCrawlOperator()).toEqual(subject);
    mocks.operator = false;
    expect(() => captureSourceCrawlOperator()).toThrow('installation operator');
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it('enters a fresh native identity/profile/permission scope at each write fence', async () => {
    const write = vi.fn(async () => 'saved');
    await expect(
      runAsSourceCrawlOperator(
        { runtimeWorkspaceSubject: subject },
        context(),
        async (resolved, fence) => {
          expect(resolved).toEqual(subject);
          return await fence(write);
        },
      ),
    ).resolves.toBe('saved');
    expect(mocks.fresh).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    for (const collection of ['sources', 'opportunities', 'companies']) {
      for (const action of ['read', 'create', 'update'])
        expect(mocks.assert).toHaveBeenCalledWith(collection, action);
    }
    expect(mocks.assert).not.toHaveBeenCalledWith('agentruns', 'create');
  });
  it('refuses operator revocation after provider work before persistence', async () => {
    const write = vi.fn();
    await expect(
      runAsSourceCrawlOperator(
        { runtimeWorkspaceSubject: subject },
        context(),
        async (_resolved, fence) => {
          mocks.operator = false;
          return await fence(write);
        },
      ),
    ).rejects.toThrow('installation operator');
    expect(write).not.toHaveBeenCalled();
  });
  it('refuses permission revocation at the later write fence', async () => {
    const write = vi.fn();
    await expect(
      runAsSourceCrawlOperator(
        { runtimeWorkspaceSubject: subject },
        context(),
        async (_resolved, fence) => {
          mocks.assert.mockRejectedValue(new Error('permission revoked'));
          return await fence(write);
        },
      ),
    ).rejects.toThrow('permission revoked');
    expect(write).not.toHaveBeenCalled();
  });
  it.each([
    'brand',
    'tenant',
    'queue',
    'method',
    'objectType',
    'envelope',
  ])('refuses a mismatched %s before any work', async (failure) => {
    const runner = context() as unknown as { job: Record<string, unknown> };
    const args: Record<string, unknown> = { runtimeWorkspaceSubject: subject };
    if (failure === 'brand') mocks.active = false;
    else if (failure === 'tenant') runner.job.tenantId = 'foreign-tenant';
    else if (failure === 'envelope') delete args.runtimeWorkspaceSubject;
    else runner.job[failure] = 'foreign';
    const work = vi.fn();
    await expect(
      runAsSourceCrawlOperator(args, runner as never, work),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(mocks.fresh).not.toHaveBeenCalled();
  });
  it('does not execute when fresh identity/membership/profile revalidation fails', async () => {
    mocks.fresh.mockRejectedValue(new Error('profile no longer active'));
    const work = vi.fn();
    await expect(
      runAsSourceCrawlOperator(
        { runtimeWorkspaceSubject: subject },
        context(),
        work,
      ),
    ).rejects.toThrow('profile no longer active');
    expect(work).not.toHaveBeenCalled();
  });
});
