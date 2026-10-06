import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadWorkspaceActivity,
  WORKSPACE_ACTIVITY_LIMIT,
  type WorkspaceActivityDependencies,
} from './workspace-activity.js';

vi.mock('./db.js', () => ({ getDbConfig: () => ({ type: 'sqlite' }) }));
const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  profileId: 'profile-a',
};
const now = new Date('2026-10-02T21:00:00.000Z');
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-a',
    tenant_id: 'tenant-a',
    subject_tenant_id: 'tenant-a',
    owner_user_id: 'user-a',
    candidate_profile_id: 'profile-a',
    status: 'running',
    created_at: '2026-10-02T20:58:00.000Z',
    started_at: '2026-10-02T20:59:00.000Z',
    completed_at: null,
    method: 'prepareAssessmentCoverage',
    object_type: '@willgriffin/iolaus-site:Opportunity',
    queue: 'opportunity-intelligence',
    worker_id: 'incarnation-a',
    worker_status: 'running',
    lease_expires_at: '2026-10-02T21:01:00.000Z',
    ...overrides,
  };
}
function event(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-a',
    tenantId: 'tenant-a',
    type: 'progress',
    progress: 42,
    createdAt: new Date('2026-10-02T20:59:30.000Z'),
    message: 'PRIVATE MESSAGE',
    data: { input: 'PRIVATE INPUT' },
    ...overrides,
  };
}
const query = vi.fn<
  NonNullable<WorkspaceActivityDependencies['database']>['query']
>(async () => ({ rows: [] }));
const loadProgress = vi.fn<
  NonNullable<WorkspaceActivityDependencies['loadProgress']>
>(async () => new Map());
function dependencies() {
  return { database: { query }, loadProgress, dialect: 'sqlite' as const, now };
}

describe('workspace active process projection', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    loadProgress.mockReset();
    loadProgress.mockResolvedValue(new Map());
  });

  it.each([
    'sqlite',
    'postgres',
  ] as const)('scopes the %s read before its hard bound and selects no audit payload', async (dialect) => {
    const result = await loadWorkspaceActivity(subject, {
      ...dependencies(),
      dialect,
    });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("job.status = 'running'");
    expect(sql).toContain('LEFT JOIN _smrt_workers');
    expect(sql).toContain('worker.lease_expires_at >= ?');
    expect(sql.indexOf('job.tenant_id = ?')).toBeLessThan(
      sql.indexOf('LIMIT ?'),
    );
    expect(sql).toContain(
      dialect === 'sqlite'
        ? 'json_valid(job.args)'
        : "job.args -> 'runtimeWorkspaceSubject'",
    );
    expect(params).toEqual([
      now.toISOString(),
      '2026-10-02T20:55:00.000Z',
      'tenant-a',
      'tenant-a',
      'user-a',
      'profile-a',
      '@willgriffin/iolaus-site:Opportunity',
      'opportunity-intelligence',
      'prepareAssessmentCoverage',
      'processIntelligence',
      '@willgriffin/iolaus-site:Application',
      'auto-submit-applications',
      'autoSubmit',
      '@willgriffin/iolaus-site:Source',
      'source-crawls',
      'crawl',
      '@willgriffin/iolaus-site:Opportunity',
      'opportunity-screening',
      'prepareAssessmentCoverage',
      21,
    ]);
    const projection = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
    expect(projection).not.toMatch(
      /input_json|output_json|last_error|task_result|result_pointer/iu,
    );
    expect(projection).not.toMatch(
      /(?:SELECT|,)\s*job\.args\s*(?:,|\bAS\b|$)/iu,
    );
    expect(result).toEqual({
      items: [],
      observedAt: now.toISOString(),
      truncated: false,
    });
    expect(loadProgress).not.toHaveBeenCalled();
  });

  it('returns one allowlisted safe process and native numeric progress only', async () => {
    query.mockResolvedValue({
      rows: [
        row({
          title: 'PRIVATE TITLE',
          args: { secret: true },
          input_json: 'PRIVATE INPUT',
          output_json: 'PRIVATE OUTPUT',
          last_error: 'PRIVATE ERROR',
        }),
        row(),
      ],
    });
    loadProgress.mockResolvedValue(new Map([['job-a', event()]]));
    const result = await loadWorkspaceActivity(subject, dependencies());
    expect(result.items).toEqual([
      {
        id: 'job:job-a',
        title: 'Preparing opportunity assessment',
        status: 'running',
        createdAt: '2026-10-02T20:58:00.000Z',
        completedAt: null,
        startedAt: '2026-10-02T20:59:00.000Z',
        progress: 42,
      },
    ]);
    expect(loadProgress).toHaveBeenCalledWith(['job-a'], 'tenant-a');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toMatch(
      /tenant|profile|worker|args|input_json|output_json/u,
    );
  });

  it.each([
    { tenant_id: 'foreign' },
    { subject_tenant_id: 'foreign' },
    { owner_user_id: 'foreign' },
    { candidate_profile_id: 'foreign' },
    { status: 'completed' },
    { completed_at: '2026-10-02T20:59:45Z' },
    { worker_status: 'stopped' },
    { worker_id: '' },
    { lease_expires_at: '2026-10-02T20:59:59Z' },
    { started_at: null },
    { started_at: '2026-10-02T21:01:00Z' },
    { method: 'arbitraryMethod' },
    { queue: 'foreign' },
    { object_type: '@willgriffin/iolaus-site:CandidateProfile' },
  ])('drops foreign, malformed, orphaned or unknown process %# at the DTO fence', async (invalid) => {
    query.mockResolvedValue({ rows: [row(invalid)] });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items,
    ).toEqual([]);
    expect(loadProgress).not.toHaveBeenCalled();
  });

  it.each([
    { tenantId: 'foreign' },
    { jobId: 'foreign' },
    { type: 'log' },
    { progress: NaN },
    { progress: 101 },
    { progress: -1 },
    { progress: '42' },
    { createdAt: new Date('2026-10-02T20:58:59Z') },
    { createdAt: new Date('2026-10-02T21:01:00Z') },
  ])('ignores progress outside the current owned attempt %#', async (invalid) => {
    query.mockResolvedValue({ rows: [row()] });
    loadProgress.mockResolvedValue(new Map([['job-a', event(invalid)]]));
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items[0]?.progress,
    ).toBeNull();
  });

  it('keeps current zero progress and caps the response and progress read at twenty', async () => {
    query.mockResolvedValue({
      rows: Array.from({ length: 21 }, (_, index) =>
        row({ id: `job-${index}` }),
      ),
    });
    loadProgress.mockResolvedValue(
      new Map([['job-0', event({ jobId: 'job-0', progress: 0 })]]),
    );
    const result = await loadWorkspaceActivity(subject, dependencies());
    expect(result.items).toHaveLength(WORKSPACE_ACTIVITY_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.items[0]?.progress).toBe(0);
    expect(loadProgress.mock.calls[0]?.[0]).toHaveLength(
      WORKSPACE_ACTIVITY_LIMIT,
    );
  });

  it('exposes real pending work without inventing a start or requiring a worker', async () => {
    query.mockResolvedValue({
      rows: [
        row({
          status: 'pending',
          started_at: null,
          worker_id: null,
          worker_status: null,
          lease_expires_at: null,
        }),
      ],
    });
    const result = await loadWorkspaceActivity(subject, dependencies());
    expect(result.items[0]).toEqual({
      id: 'job:job-a',
      title: 'Preparing opportunity assessment',
      status: 'queued',
      createdAt: '2026-10-02T20:58:00.000Z',
      startedAt: null,
      completedAt: null,
      progress: null,
    });
    expect(loadProgress).not.toHaveBeenCalled();
  });
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'canceled'],
  ])('keeps recent %s outcomes without a worker only in their actual status', async (native, status) => {
    query.mockResolvedValue({
      rows: [
        row({
          status: native,
          completed_at: '2026-10-02T20:59:30.000Z',
          worker_id: null,
          worker_status: null,
          lease_expires_at: null,
        }),
      ],
    });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items[0],
    ).toMatchObject({
      status,
      completedAt: '2026-10-02T20:59:30.000Z',
      progress: null,
    });
    expect(loadProgress).not.toHaveBeenCalled();
  });
  it.each([
    '2026-10-02T20:54:59.000Z',
    '2026-10-02T21:00:01.000Z',
    null,
    'invalid',
  ])('drops terminal outcomes outside the bounded current window: %s', async (completed_at) => {
    query.mockResolvedValue({
      rows: [row({ status: 'completed', completed_at })],
    });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items,
    ).toEqual([]);
  });
  it.each([
    'pending',
    'completed',
    'failed',
    'cancelled',
  ])('retains the private tuple fence for %s', async (status) => {
    query.mockResolvedValue({
      rows: [
        row({
          status,
          completed_at: status === 'pending' ? null : '2026-10-02T20:59:30Z',
          owner_user_id: 'foreign',
        }),
      ],
    });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items,
    ).toEqual([]);
  });

  it('includes the dedicated native screening queue without treating other methods there as supported', async () => {
    query.mockResolvedValue({
      rows: [
        row({ queue: 'opportunity-screening' }),
        row({
          id: 'wrong-method',
          queue: 'opportunity-screening',
          method: 'processIntelligence',
        }),
      ],
    });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items.map(
        ({ title }) => title,
      ),
    ).toEqual(['Screening opportunity']);
  });

  it('uses generic titles for other explicitly allowed native processes', async () => {
    query.mockResolvedValue({
      rows: [
        row({ method: 'processIntelligence' }),
        row({
          id: 'source-job',
          method: 'crawl',
          queue: 'source-crawls',
          object_type: '@willgriffin/iolaus-site:Source',
        }),
        row({
          id: 'application-job',
          method: 'autoSubmit',
          queue: 'auto-submit-applications',
          object_type: '@willgriffin/iolaus-site:Application',
        }),
      ],
    });
    expect(
      (await loadWorkspaceActivity(subject, dependencies())).items.map(
        (item) => item.title,
      ),
    ).toEqual([
      'Processing opportunity',
      'Crawling requested source',
      'Submitting approved application',
    ]);
  });

  it('rejects incomplete subjects before storage, and propagates unavailable native reads', async () => {
    await expect(
      loadWorkspaceActivity({ ...subject, profileId: '' }, dependencies()),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    query.mockRejectedValue(new Error('native read unavailable'));
    await expect(
      loadWorkspaceActivity(subject, dependencies()),
    ).rejects.toThrow('native read unavailable');
    query.mockResolvedValue({ rows: [row()] });
    loadProgress.mockRejectedValue(new Error('native progress unavailable'));
    await expect(
      loadWorkspaceActivity(subject, dependencies()),
    ).rejects.toThrow('native progress unavailable');
  });
});
