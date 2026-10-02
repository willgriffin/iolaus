import type { SmrtJob, SmrtJobData } from '@happyvertical/smrt-jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  getOpportunityIntelligenceJobDedupeStatus,
  isOpportunityIntelligenceActiveJobConflict,
} from './opportunity-intelligence-job-schema';

const workspace = vi.hoisted(() => ({
  coverageReady: true,
  subject: null as {
    profileId: string;
    tenantId: string;
    userId: string;
  } | null,
}));

vi.mock('./workspace-subject.js', () => ({
  getCurrentWorkspaceSubject: () => workspace.subject,
  requireCurrentWorkspaceSubject: () => workspace.subject,
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: vi.fn(async () => ({
    fingerprint: 'candidate-fingerprint',
  })),
}));
vi.mock('./opportunity-assessment-input.js', () => ({
  verifiedOpportunityRequirementCoverage: vi.fn(() =>
    workspace.coverageReady
      ? { fingerprint: 'coverage-fingerprint', ledger: {} }
      : undefined,
  ),
  opportunityAssessmentSubjectMaterialFingerprint: vi.fn(
    ({
      subject,
      candidateMaterialFingerprint,
      sourceContentFingerprint,
      sourceContentVersion,
    }) =>
      `${subject.tenantId}:${subject.userId}:${subject.profileId}:${candidateMaterialFingerprint}:${sourceContentFingerprint}:${sourceContentVersion}`,
  ),
}));
vi.mock('./opportunity-requirement-coverage-provider.js', () => ({
  hasRecordedRequirementCoverageAudit: vi.fn(async () => true),
  requirementCoverageSourceDependencyFingerprint: vi.fn(
    () => 'source-coverage-contract-seed',
  ),
}));
vi.mock('./opportunity-assessment-dependency-job.js', () => ({
  OpportunityAssessmentDependencyEnqueueError: class extends Error {},
  enqueueOpportunityAssessmentCoverage: vi.fn(async () => ({
    enqueued: true,
    job: { id: 'source-preparation-job' },
    stage: 'source_preparation',
    sourceDependency: { kind: 'requirement_coverage' },
  })),
}));

function jobRecord(data: Record<string, unknown>) {
  return {
    id: String(data.id ?? ''),
    save: vi.fn(async () => {}),
    ...data,
  };
}

describe('opportunity intelligence jobs', () => {
  beforeEach(() => {
    workspace.subject = null;
    workspace.coverageReady = true;
    vi.clearAllMocks();
  });

  it('queues source preparation before loading private evidence when coverage is missing', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    workspace.coverageReady = false;
    const { loadWorkspaceCandidateEvidence } = await import('./resume-data');
    const { enqueueOpportunityAssessmentCoverage } = await import(
      './opportunity-assessment-dependency-job'
    );
    const collection = {
      create: vi.fn(),
      enqueueJob: vi.fn(),
      list: vi.fn(async () => []),
    };
    const result = await enqueueOpportunityIntelligenceWithStatus(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection: { get: vi.fn(async () => ({ id: 'opp-1' })) },
      },
    );
    expect(result.stage).toBe('source_preparation');
    expect(result.job.id).toBe('source-preparation-job');
    expect(enqueueOpportunityAssessmentCoverage).toHaveBeenCalledOnce();
    expect(loadWorkspaceCandidateEvidence).not.toHaveBeenCalled();
    expect(collection.create).not.toHaveBeenCalled();
    expect(collection.enqueueJob).not.toHaveBeenCalled();
  });

  it('keeps explicit source-only extraction separate from the private continuation', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    workspace.coverageReady = false;
    const { loadWorkspaceCandidateEvidence } = await import('./resume-data');
    const { enqueueOpportunityAssessmentCoverage } = await import(
      './opportunity-assessment-dependency-job'
    );
    const collection = {
      create: vi.fn(),
      enqueueJob: vi.fn(
        async (data: SmrtJobData) =>
          jobRecord({ id: 'extract-job', ...data }) as unknown as SmrtJob,
      ),
      list: vi.fn(async () => []),
    };
    const result = await enqueueOpportunityIntelligenceWithStatus(
      'opp-1',
      { modes: ['extract'] },
      {
        collection,
        opportunityCollection: {
          get: vi.fn(async () => ({
            id: 'opp-1',
            sourceContentFingerprint: 'fp',
            sourceContentVersion: 1,
          })),
        },
      },
    );
    expect(result.job.args.modes).toEqual(['extract']);
    expect(result.job.args.scoringMaterialFingerprint).toBe(
      'source-coverage-contract-seed',
    );
    expect(enqueueOpportunityAssessmentCoverage).not.toHaveBeenCalled();
    expect(loadWorkspaceCandidateEvidence).not.toHaveBeenCalled();
    expect(result.stage).toBeUndefined();
  });

  it('reads native source fields through public serialization without changing the source contract identity', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const nativeSource = {
      id: 'opp-1',
      sourceContentFingerprint: 'captured-fp',
      sourceContentVersion: 4,
      sourceContentJson: '{"descriptionRaw":"Captured role"}',
      preparedPostingJson: '{"requirementCoverage":{}}',
    };
    const target = {
      id: nativeSource.id,
      sourceContentFingerprint: nativeSource.sourceContentFingerprint,
      sourceContentVersion: nativeSource.sourceContentVersion,
      toJSON: vi.fn(() => nativeSource),
    };
    const { requirementCoverageSourceDependencyFingerprint } = await import(
      './opportunity-requirement-coverage-provider'
    );
    const collection = {
      create: vi.fn(),
      enqueueJob: vi.fn(
        async (data: SmrtJobData) =>
          jobRecord({ id: 'source-job', ...data }) as unknown as SmrtJob,
      ),
      list: vi.fn(async () => []),
    };
    const result = await enqueueOpportunityIntelligenceWithStatus(
      'opp-1',
      { modes: 'extract' },
      {
        collection,
        opportunityCollection: { get: vi.fn(async () => target) },
      },
    );
    expect(target.toJSON).toHaveBeenCalledOnce();
    expect(requirementCoverageSourceDependencyFingerprint).toHaveBeenCalledWith(
      nativeSource,
    );
    expect(result.job.args.contentFingerprint).toBe(
      nativeSource.sourceContentFingerprint,
    );
    expect(result.job.args.contentVersion).toBe(
      nativeSource.sourceContentVersion,
    );
    expect(result.job.args.scoringMaterialFingerprint).toBe(
      'source-coverage-contract-seed',
    );
  });

  it('uses native tenant-cap enqueue without a second save', async () => {
    const job = jobRecord({ id: 'native-job' }) as unknown as SmrtJob;
    const collection = {
      create: vi.fn(),
      enqueueJob: vi.fn(async () => job),
      list: vi.fn(async () => []),
    };
    await enqueueOpportunityIntelligenceWithStatus(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection: { get: vi.fn(async () => ({ id: 'opp-1' })) },
      },
    );
    expect(collection.enqueueJob).toHaveBeenCalledOnce();
    expect(collection.create).not.toHaveBeenCalled();
    expect(job.save).not.toHaveBeenCalled();
  });

  it('does not trust positive source JSON without its independent completed receipt', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const { hasRecordedRequirementCoverageAudit } = await import(
      './opportunity-requirement-coverage-provider'
    );
    vi.mocked(hasRecordedRequirementCoverageAudit).mockResolvedValueOnce(false);
    const { loadWorkspaceCandidateEvidence } = await import('./resume-data');
    const result = await enqueueOpportunityIntelligenceWithStatus(
      'opp-1',
      {},
      {
        collection: {
          create: vi.fn(),
          enqueueJob: vi.fn(),
          list: vi.fn(async () => []),
        },
        opportunityCollection: { get: vi.fn(async () => ({ id: 'opp-1' })) },
      },
    );
    expect(result.stage).toBe('source_preparation');
    expect(loadWorkspaceCandidateEvidence).not.toHaveBeenCalled();
  });

  it('preserves native queue-cap denial without falling back to create', async () => {
    const capped = new Error('Native tenant in-flight cap reached.');
    const collection = {
      create: vi.fn(),
      enqueueJob: vi.fn(async () => {
        throw capped;
      }),
      list: vi.fn(async () => []),
    };
    await expect(
      enqueueOpportunityIntelligenceWithStatus(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => ({ id: 'opp-1' })) },
        },
      ),
    ).rejects.toBe(capped);
    expect(collection.create).not.toHaveBeenCalled();
  });

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

  it('captures a verified workspace subject and creates only the assessment mode', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const created = jobRecord({ id: 'job-workspace-1' });
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
        sourceContentFingerprint: 'source-fingerprint',
        sourceContentVersion: 7,
        sourceId: 'source-1',
      })),
    };

    await enqueueOpportunityIntelligence(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection,
      },
    );

    expect(collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          contentFingerprint: 'source-fingerprint',
          contentVersion: 7,
          modes: 'assessment',
          runtimeWorkspaceSubject: workspace.subject,
          scoringMaterialFingerprint:
            'tenant-1:user-1:profile-1:candidate-fingerprint:source-fingerprint:7',
        }),
      }),
    );
  });

  it('rejects a same-fingerprint active job whose durable workspace tuple is foreign', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const collection = {
      create: vi.fn(),
      list: vi.fn(async () => [
        jobRecord({
          args: {
            contentFingerprint: 'source-fingerprint',
            runtimeWorkspaceSubject: {
              profileId: 'profile-2',
              tenantId: 'tenant-2',
              userId: 'user-2',
            },
            scoringMaterialFingerprint:
              'tenant-1:user-1:profile-1:candidate-fingerprint:source-fingerprint:7',
          },
          id: 'foreign-job',
          tenantId: 'tenant-2',
        }) as unknown as SmrtJob,
      ]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({
        id: 'opp-1',
        sourceContentFingerprint: 'source-fingerprint',
        sourceContentVersion: 7,
      })),
    };

    await expect(
      enqueueOpportunityIntelligence(
        'opp-1',
        {},
        { collection, opportunityCollection },
      ),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });
    expect(collection.create).not.toHaveBeenCalled();
  });

  it('rejects a foreign active job recovered after a concurrent save conflict', async () => {
    workspace.subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const foreign = jobRecord({
      args: {
        contentFingerprint: 'source-fingerprint',
        runtimeWorkspaceSubject: {
          profileId: 'profile-2',
          tenantId: 'tenant-2',
          userId: 'user-2',
        },
        scoringMaterialFingerprint:
          'tenant-1:user-1:profile-1:candidate-fingerprint:source-fingerprint:7',
      },
      id: 'foreign-race-job',
      tenantId: 'tenant-2',
    });
    const collection = {
      create: vi.fn(async () => {
        throw Object.assign(
          new Error(
            'duplicate key value violates unique constraint "idx_smrt_jobs_opportunity_intelligence_active_fingerprint"',
          ),
          { code: '23505' },
        );
      }),
      list: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([foreign as unknown as SmrtJob]),
    };
    const opportunityCollection = {
      get: vi.fn(async () => ({
        id: 'opp-1',
        sourceContentFingerprint: 'source-fingerprint',
        sourceContentVersion: 7,
      })),
    };

    await expect(
      enqueueOpportunityIntelligence(
        'opp-1',
        {},
        { collection, opportunityCollection },
      ),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });
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
    let statusReads = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('pg_get_indexdef')) {
        statusReads += 1;
        return {
          rows:
            statusReads === 1
              ? []
              : [
                  {
                    index_definition: `CREATE UNIQUE INDEX idx_smrt_jobs_opportunity_intelligence_active_material ON public._smrt_jobs USING btree (queue, object_type, object_id, method, COALESCE((args ->> 'contentFingerprint'::text), ''::text), COALESCE((args ->> 'scoringMaterialFingerprint'::text), ''::text)) WHERE ((status = ANY (ARRAY['pending'::text, 'running'::text])) AND (queue = 'opportunity-intelligence'::text) AND (object_type = '@willgriffin/iolaus-site:Opportunity'::text) AND (method = 'processIntelligence'::text) AND (object_id IS NOT NULL))`,
                    is_ready: true,
                    is_unique: true,
                    is_valid: true,
                  },
                ],
        };
      }
      return { rows: [] };
    });

    await ensureOpportunityIntelligenceJobDedupe({ query } as never);

    expect(query).toHaveBeenCalledTimes(6);
    expect(String(query.mock.calls[1]?.[0])).toContain(
      "COALESCE(args ->> 'contentFingerprint', '')",
    );
    expect(String(query.mock.calls[2]?.[0])).toContain(
      'idx_smrt_jobs_opportunity_intelligence_active_material',
    );
    expect(String(query.mock.calls[3]?.[0])).toContain(
      'DROP INDEX IF EXISTS idx_smrt_jobs_opportunity_intelligence_active',
    );
    expect(String(query.mock.calls[4]?.[0])).toContain(
      'DROP INDEX IF EXISTS idx_smrt_jobs_opportunity_intelligence_active_fingerprint',
    );
  });

  it('rejects a same-name guard whose SQL literal casing changes the predicate', async () => {
    const status = await getOpportunityIntelligenceJobDedupeStatus({
      query: vi.fn(async () => ({
        rows: [
          {
            index_definition: `CREATE UNIQUE INDEX idx_smrt_jobs_opportunity_intelligence_active_fingerprint ON public._smrt_jobs USING btree (queue, object_type, object_id, method, COALESCE((args ->> 'contentFingerprint'::text), ''::text)) WHERE ((status = ANY (ARRAY['pending'::text, 'running'::text])) AND (queue = 'opportunity-intelligence'::text) AND (object_type = '@willgriffin/iolaus-site:Opportunity'::text) AND (method = 'PROCESSINTELLIGENCE'::text) AND (object_id IS NOT NULL))`,
            is_ready: true,
            is_unique: true,
            is_valid: true,
          },
        ],
      })),
    } as never);
    expect(status.activeIndexPresent).toBe(false);
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
        { modes: 'all' },
        undefined,
        { processor, updateStatus },
      ),
    ).rejects.toThrow('Processed 2 intelligence steps; 1 failed.');
    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({
        modes: 'all',
        opportunityId: 'opp-1',
        signal: expect.any(AbortSignal),
        user: null,
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
    const workspaceSubject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };

    await expect(
      runOpportunityIntelligenceJob(
        { id: 'opp-1', sourceContentFingerprint: 'fingerprint-v1' },
        { contentFingerprint: 'fingerprint-v1', contentVersion: 1 },
        { logger } as never,
        { finishRun, processor, startRun, updateStatus, workspaceSubject },
      ),
    ).resolves.toMatchObject({ status: 'processed' });
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSubject,
      }),
    );
    expect(finishRun).toHaveBeenCalledWith(
      'run-1',
      'succeeded',
      '',
      workspaceSubject,
    );
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
