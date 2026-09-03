import type { SmrtJob, SmrtJobData } from '@happyvertical/smrt-jobs';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueOpportunityIntelligence,
  enqueueOpportunityIntelligenceWithStatus,
  findActiveOpportunityIntelligenceJob,
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
  OpportunityIntelligenceEnqueueError,
  runOpportunityIntelligenceJob,
} from './opportunity-intelligence-job';
import {
  ensureOpportunityIntelligenceJobDedupe,
  isOpportunityIntelligenceActiveJobConflict,
} from './opportunity-intelligence-job-schema';

function jobRecord(data: Record<string, unknown>) {
  return {
    id: String(data.id ?? ''),
    save: vi.fn(async () => {}),
    ...data,
  };
}

describe('opportunity intelligence jobs', () => {
  it('rejects missing opportunity ids with a stable enqueue error code', async () => {
    await expect(enqueueOpportunityIntelligence('   ')).rejects.toMatchObject({
      code: 'opportunity_id_required',
      message: 'Opportunity id is required.',
      name: 'OpportunityIntelligenceEnqueueError',
    });
    await expect(enqueueOpportunityIntelligence('   ')).rejects.toBeInstanceOf(
      OpportunityIntelligenceEnqueueError,
    );
  });

  it('enqueues opportunity intelligence without running it in the request', async () => {
    const created = jobRecord({ id: 'job-1' });
    const collection = {
      create: vi.fn(
        async (payload: SmrtJobData) =>
          Object.assign(created, payload) as unknown as SmrtJob,
      ),
      list: vi.fn(async () => [] as SmrtJob[]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({
        id: 'opp-1',
        sourceContentFingerprint: 'fingerprint-v3',
        sourceContentVersion: 3,
        sourceId: 'source-1',
      })),
    };
    const runAt = new Date('2026-06-08T15:00:00.000Z');

    const job = await enqueueOpportunityIntelligence(
      'opp-1',
      { modes: ['extract', 'score'] },
      {
        collection,
        now: runAt,
        opportunityCollection,
        user: { id: 'user-1' },
      },
    );

    expect(job.id).toBe('job-1');
    expect(created.save).toHaveBeenCalledOnce();
    expect(collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          contentFingerprint: 'fingerprint-v3',
          contentFingerprintVersion: 'opportunity-source-content:v1',
          contentVersion: 3,
          modes: ['extract', 'score'],
          reason: 'manual',
          sourceId: 'source-1',
          userId: 'user-1',
        }),
        maxAttempts: 1,
        method: OPPORTUNITY_INTELLIGENCE_METHOD,
        objectId: 'opp-1',
        objectType: OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
        queue: OPPORTUNITY_INTELLIGENCE_QUEUE,
        runAt,
        timeout: OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
      }),
    );
  });

  it('reuses an active opportunity intelligence job for the same opportunity', async () => {
    const existing = jobRecord({ id: 'job-existing', status: 'pending' });
    const collection = {
      create: vi.fn(),
      list: vi.fn(async () => [existing as unknown as SmrtJob]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({ id: 'opp-1' })),
    };

    const job = await enqueueOpportunityIntelligence(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection,
      },
    );

    expect(job).toBe(existing);
    expect(collection.list).toHaveBeenCalledWith({
      limit: 1,
      orderBy: ['priority DESC', 'run_at ASC'],
      where: {
        method: OPPORTUNITY_INTELLIGENCE_METHOD,
        objectId: 'opp-1',
        objectType: OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
        queue: OPPORTUNITY_INTELLIGENCE_QUEUE,
        status: ['pending', 'running'],
      },
    });
    expect(collection.create).not.toHaveBeenCalled();
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('probes the exact active fingerprint without creating a job', async () => {
    const existing = jobRecord({
      args: { contentFingerprint: 'fingerprint-v1' },
      id: 'job-existing',
      status: 'pending',
    });
    const collection = {
      create: vi.fn(),
      list: vi.fn(async () => [existing as unknown as SmrtJob]),
    };

    await expect(
      findActiveOpportunityIntelligenceJob('opp-1', 'fingerprint-v1', {
        collection,
      }),
    ).resolves.toBe(existing);
    expect(collection.create).not.toHaveBeenCalled();
    expect(collection.list).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ objectId: 'opp-1' }),
      }),
    );
  });

  it('returns the active job when a concurrent enqueue wins the uniqueness race', async () => {
    const existing = jobRecord({ id: 'job-existing', status: 'pending' });
    const conflict = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "idx_smrt_jobs_opportunity_intelligence_active_fingerprint"',
      ),
      { code: '23505' },
    );
    const collection = {
      create: vi.fn(async () => {
        throw conflict;
      }),
      list: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([existing as unknown as SmrtJob]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({ id: 'opp-1' })),
    };

    const job = await enqueueOpportunityIntelligence(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection,
      },
    );

    expect(job).toBe(existing);
    expect(collection.create).toHaveBeenCalledOnce();
    expect(collection.list).toHaveBeenCalledTimes(2);
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('detects flattened active-job uniqueness errors', () => {
    const conflict = new Error(
      'code=23505 duplicate key value violates unique constraint "idx_smrt_jobs_opportunity_intelligence_active_fingerprint"',
    );

    expect(isOpportunityIntelligenceActiveJobConflict(conflict)).toBe(true);
  });

  it('recovers when SMRT normalizes the uniqueness error from job.save', async () => {
    const existing = jobRecord({
      args: { contentFingerprint: 'fingerprint-v1' },
      id: 'job-existing',
      status: 'pending',
    });
    const created = jobRecord({ id: 'job-loser' });
    created.save = vi.fn(async () => {
      throw Object.assign(new Error('Unique constraint violation'), {
        code: 'VALIDATION_UNIQUE_CONSTRAINT',
      });
    });
    const collection = {
      create: vi.fn(async () => created as unknown as SmrtJob),
      list: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([existing as unknown as SmrtJob]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({ id: 'opp-1' })),
    };

    await expect(
      enqueueOpportunityIntelligenceWithStatus(
        'opp-1',
        { contentFingerprint: 'fingerprint-v1' },
        { collection, opportunityCollection },
      ),
    ).resolves.toEqual({ enqueued: false, job: existing });
    expect(created.save).toHaveBeenCalledOnce();
    expect(collection.list).toHaveBeenCalledTimes(2);
  });

  it('installs fingerprint-aware active-job uniqueness before dropping the legacy index', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [],
    }));

    await ensureOpportunityIntelligenceJobDedupe({ query } as never);

    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "COALESCE(args ->> 'contentFingerprint', '')",
    );
    expect(String(query.mock.calls[1]?.[0])).toContain(
      'idx_smrt_jobs_opportunity_intelligence_active_fingerprint',
    );
    expect(String(query.mock.calls[2]?.[0])).toContain(
      'DROP INDEX IF EXISTS idx_smrt_jobs_opportunity_intelligence_active',
    );
  });

  it('deduplicates only the same active opportunity content fingerprint', async () => {
    const existing = jobRecord({
      args: { contentFingerprint: 'fingerprint-v1' },
      id: 'job-existing',
      status: 'pending',
    });
    const created = jobRecord({ id: 'job-v2' });
    const collection = {
      create: vi.fn(
        async (payload: SmrtJobData) =>
          Object.assign(created, payload) as unknown as SmrtJob,
      ),
      list: vi.fn(async () => [existing as unknown as SmrtJob]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({ id: 'opp-1' })),
    };

    await expect(
      enqueueOpportunityIntelligenceWithStatus(
        'opp-1',
        { contentFingerprint: 'fingerprint-v1' },
        { collection, opportunityCollection },
      ),
    ).resolves.toEqual({ enqueued: false, job: existing });

    await expect(
      enqueueOpportunityIntelligenceWithStatus(
        'opp-1',
        { contentFingerprint: 'fingerprint-v2' },
        { collection, opportunityCollection },
      ),
    ).resolves.toEqual({ enqueued: true, job: created });
    expect(collection.create).toHaveBeenCalledOnce();
    expect(collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          contentFingerprint: 'fingerprint-v2',
        }),
        maxAttempts: 1,
      }),
    );
  });

  it('runs the queued processor and fails the job on partial failures', async () => {
    const updateStatus = vi.fn(async () => {});
    const processor = vi.fn(async () => ({
      failed: 1,
      message: 'Processed 2 intelligence steps; 1 failed.',
      status: 'processed',
    }));

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1' },
        { modes: 'all', userId: 'user-1' },
        undefined,
        { processor, updateStatus },
      ),
    ).rejects.toThrow('Processed 2 intelligence steps; 1 failed.');
    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({
        modes: 'all',
        opportunityId: 'opp-1',
        signal: expect.any(AbortSignal),
        user: { id: 'user-1' },
      }),
    );
    expect(updateStatus).toHaveBeenCalledWith('opp-1', '', 'failed');
  });

  it('marks the current fingerprint completed after all steps succeed', async () => {
    const updateStatus = vi.fn(async () => {});
    const processor = vi.fn(async () => ({
      failed: 0,
      message: 'Processed 4 intelligence steps.',
      status: 'processed',
    }));

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1', sourceContentFingerprint: 'fingerprint-v1' },
        { contentFingerprint: 'fingerprint-v1', contentVersion: 1 },
        undefined,
        { processor, updateStatus },
      ),
    ).resolves.toMatchObject({ status: 'processed' });
    expect(updateStatus).toHaveBeenCalledWith(
      'opp-1',
      'fingerprint-v1',
      'completed',
    );
  });

  it('finalizes the agent run when terminal status persistence fails', async () => {
    const finishRun = vi.fn(async () => {});
    const logger = { error: vi.fn(), info: vi.fn() };
    const processor = vi.fn(async () => ({
      failed: 0,
      message: 'Processed 4 intelligence steps.',
      status: 'processed',
    }));
    const startRun = vi.fn(async () => 'run-1');
    const updateStatus = vi.fn(async () => {
      throw new Error('database temporarily unavailable');
    });

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1', sourceContentFingerprint: 'fingerprint-v1' },
        { contentFingerprint: 'fingerprint-v1', contentVersion: 1 },
        { logger } as never,
        { finishRun, processor, startRun, updateStatus },
      ),
    ).resolves.toMatchObject({ status: 'processed' });
    expect(finishRun).toHaveBeenCalledWith('run-1', 'succeeded');
    expect(updateStatus).toHaveBeenCalledWith(
      'opp-1',
      'fingerprint-v1',
      'completed',
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Unable to persist opportunity intelligence terminal status.',
      expect.objectContaining({
        message: 'database temporarily unavailable',
        status: 'completed',
      }),
    );
  });

  it('skips a stale queued content version before calling the model', async () => {
    const processor = vi.fn();

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1', sourceContentFingerprint: 'fingerprint-v2' },
        { contentFingerprint: 'fingerprint-v1', contentVersion: 1 },
        undefined,
        { processor },
      ),
    ).resolves.toMatchObject({
      failed: 0,
      status: 'skipped',
    });
    expect(processor).not.toHaveBeenCalled();
  });

  it('propagates the fingerprint fence and accepts a stale in-flight skip', async () => {
    const updateStatus = vi.fn(async () => {});
    const processor = vi.fn(async () => ({
      failed: 0,
      message: 'Discarded stale opportunity extraction results.',
      stale: true,
      status: 'skipped',
    }));

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1', sourceContentFingerprint: 'fingerprint-v1' },
        {
          contentFingerprint: 'fingerprint-v1',
          contentVersion: 1,
          sourceCrawlId: 'crawl-1',
          sourceCrawlItemId: 'crawl-item-1',
          sourceId: 'source-1',
        },
        undefined,
        { processor, updateStatus },
      ),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceContentFingerprint: 'fingerprint-v1',
        sourceContentVersion: 1,
        sourceCrawlId: 'crawl-1',
        sourceCrawlItemId: 'crawl-item-1',
        sourceId: 'source-1',
      }),
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
