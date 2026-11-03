import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCollection: vi.fn(),
  taskList: vi.fn(),
  applicationList: vi.fn(),
  listAdminRecords: vi.fn(),
  listOpportunityPageIds: vi.fn(),
  loadCurrentSourceOpportunityEligibility: vi.fn(),
  loadOpportunityAssessmentReader: vi.fn(),
  project: vi.fn(),
}));
vi.mock('./smrt', () => ({ getCollection: mocks.getCollection }));
vi.mock('./admin-data', () => ({
  listAdminRecords: mocks.listAdminRecords,
  requireAdminResource: (slug: string) => ({
    slug,
    className:
      slug === 'sources'
        ? 'Source'
        : slug === 'companies'
          ? 'Company'
          : 'Opportunity',
  }),
  serializeRecord: (record: unknown) => record,
}));
vi.mock('./admin-opportunity-query', () => ({
  listOpportunityPageIds: mocks.listOpportunityPageIds,
  loadCurrentSourceOpportunityEligibility:
    mocks.loadCurrentSourceOpportunityEligibility,
}));
vi.mock('./opportunity-assessment-store', () => ({
  loadOpportunityAssessmentReader: mocks.loadOpportunityAssessmentReader,
}));
vi.mock('./workspace-subject', () => ({
  requireCandidateWorkspaceSubject: (subject: Record<string, string>) => {
    if (!subject?.tenantId || !subject.userId || !subject.profileId)
      throw new Error('verified profile required');
    return subject;
  },
}));

import { loadAdminOverview } from './admin-overview';

const subjectA = {
  tenantId: 'tenant',
  userId: 'user-a',
  profileId: 'profile-a',
};
const subjectB = {
  tenantId: 'tenant',
  userId: 'user-b',
  profileId: 'profile-b',
};
const ownedByA = {
  tenantId: subjectA.tenantId,
  ownerUserId: subjectA.userId,
  candidateProfileId: subjectA.profileId,
};
const postings = [
  { id: 'new', status: 'found', title: 'Engineer' },
  { id: 'draft', status: 'needs_input', title: 'Active draft' },
  { id: 'pending', status: 'found', title: 'Unassessed' },
];
const assessment = {
  sourceStatus: 'current',
  eligibilityBucket: 'eligible',
  matchReadiness: 'assessable',
  coverage: {
    candidateTruncated: false,
    postingTruncated: false,
    requirementsTruncated: false,
    requirementCount: 4,
  },
  ranking: { eligibilityPriority: 0, fitScore: 82, excluded: false },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCollection.mockImplementation(async (className) => ({
    list: className === 'Application' ? mocks.applicationList : mocks.taskList,
  }));
  mocks.applicationList.mockImplementation(async (options) =>
    options.where['opportunityId in']
      ? [{ id: 'application-a', opportunityId: 'draft', ...ownedByA }]
      : [],
  );
  mocks.taskList.mockResolvedValue(
    [subjectA, subjectB].map((subject) => ({
      id: `task-${subject.userId}`,
      status: 'open',
      title: `Private ${subject.userId}`,
      tenantId: subject.tenantId,
      ownerUserId: subject.userId,
      candidateProfileId: subject.profileId,
    })),
  );
  mocks.loadCurrentSourceOpportunityEligibility.mockResolvedValue(new Map());
  mocks.loadOpportunityAssessmentReader.mockResolvedValue({
    query: {
      assessmentCandidateMaterialFingerprint: 'evidence',
      assessmentPreferencesFingerprint: 'preferences',
    },
    project: mocks.project,
  });
  mocks.project.mockImplementation(
    async (records: Array<{ id: string }>) =>
      new Map(
        records.flatMap(({ id }) =>
          id === 'pending' ? [] : [[id, assessment]],
        ),
      ),
  );
  mocks.listOpportunityPageIds.mockResolvedValue(
    postings.map((posting) => posting.id),
  );
  mocks.listAdminRecords.mockImplementation(async (resource, options) => {
    if (resource.slug !== 'opportunities') return [];
    const ids = options?.where?.['id in'];
    return Array.isArray(ids)
      ? postings.filter((posting) => ids.includes(posting.id))
      : postings;
  });
});

describe('subject-scoped admin overview', () => {
  it('labels an application packet task with its owned opportunity without modifying stored task text', async () => {
    const task = {
      id: 'packet-task',
      title: 'Review application packet: application-a',
      status: 'open',
      taskType: 'approve_application',
      applicationId: 'application-a',
      tenantId: subjectA.tenantId,
      ownerUserId: subjectA.userId,
      candidateProfileId: subjectA.profileId,
    };
    mocks.taskList.mockResolvedValue([task]);
    mocks.applicationList.mockResolvedValue([
      {
        id: 'application-a',
        opportunityId: 'new',
        tenantId: subjectA.tenantId,
        ownerUserId: subjectA.userId,
        candidateProfileId: subjectA.profileId,
      },
    ]);
    expect((await loadAdminOverview(subjectA)).tasks[0].title).toBe(
      'Review application packet: Engineer',
    );
    expect((await loadAdminOverview(subjectA)).tasks[0].href).toBe(
      '/admin/applications/application-a',
    );
    expect(task.title).toBe('Review application packet: application-a');
    expect(mocks.applicationList).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          'id in': ['application-a'],
          tenantId: 'tenant',
          ownerUserId: 'user-a',
          candidateProfileId: 'profile-a',
        },
      }),
    );
  });

  it('never derives a task display title from a foreign application returned by an adapter', async () => {
    mocks.taskList.mockResolvedValue([
      {
        id: 'packet-task',
        title: 'Review application packet: application-b',
        status: 'open',
        taskType: 'approve_application',
        applicationId: 'application-b',
        tenantId: subjectA.tenantId,
        ownerUserId: subjectA.userId,
        candidateProfileId: subjectA.profileId,
      },
    ]);
    mocks.applicationList.mockResolvedValue([
      {
        id: 'application-b',
        opportunityId: 'new',
        tenantId: subjectB.tenantId,
        ownerUserId: subjectB.userId,
        candidateProfileId: subjectB.profileId,
      },
    ]);
    expect((await loadAdminOverview(subjectA)).tasks[0].title).toBe(
      'Review application packet: application-b',
    );
    expect((await loadAdminOverview(subjectA)).tasks[0].href).toBe(
      '/admin/tasks/packet-task',
    );
  });

  it('takes source account setup to the owned source edit form', async () => {
    mocks.taskList.mockResolvedValue([
      {
        ...ownedByA,
        id: 'setup',
        status: 'open',
        taskType: 'account_setup',
        sourceId: 'source-a',
      },
    ]);
    mocks.listAdminRecords.mockImplementation(async (resource) =>
      resource.slug === 'sources'
        ? [{ id: 'source-a', ownerProfileId: subjectA.profileId }]
        : postings,
    );
    expect((await loadAdminOverview(subjectA)).tasks[0].href).toBe(
      '/admin/sources/source-a/edit',
    );
    mocks.taskList.mockResolvedValue([
      {
        ...ownedByA,
        id: 'legacy-signup',
        status: 'open',
        taskType: 'signup_needed',
        sourceId: 'source-a',
      },
    ]);
    expect((await loadAdminOverview(subjectA)).tasks[0].href).toBe(
      '/admin/sources/source-a/edit',
    );
  });

  it('falls back to task detail for a foreign source or an untrusted href', async () => {
    mocks.taskList.mockResolvedValue([
      {
        ...ownedByA,
        id: 'setup',
        status: 'open',
        taskType: 'account_setup',
        sourceId: 'source-b',
        href: 'https://unsafe.example/',
      },
    ]);
    mocks.listAdminRecords.mockImplementation(async (resource) =>
      resource.slug === 'sources'
        ? [{ id: 'source-b', ownerProfileId: subjectB.profileId }]
        : postings,
    );
    expect((await loadAdminOverview(subjectA)).tasks[0].href).toBe(
      '/admin/tasks/setup',
    );
  });

  it('opens a linked opportunity review and keeps missing relations on task detail', async () => {
    mocks.taskList.mockResolvedValue([
      {
        ...ownedByA,
        id: 'review',
        status: 'open',
        taskType: 'review_recommendation',
        opportunityId: 'new',
      },
      { ...ownedByA, id: 'missing', status: 'open', taskType: 'account_setup' },
    ]);
    const tasks = (await loadAdminOverview(subjectA)).tasks;
    expect(tasks.find((task) => task.id === 'review')?.href).toBe(
      '/admin/opportunities?selected=new',
    );
    expect(tasks.find((task) => task.id === 'missing')?.href).toBe(
      '/admin/tasks/missing',
    );
  });

  it('retains native task ownership and never leaks another user task from an adapter', async () => {
    const a = await loadAdminOverview(subjectA);
    const b = await loadAdminOverview(subjectB);
    expect(a.tasks.map((task) => task.id)).toEqual(['task-user-a']);
    expect(b.tasks.map((task) => task.id)).toEqual(['task-user-b']);
    expect(mocks.taskList).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          'status in': ['open', 'in_progress', 'blocked'],
          tenantId: 'tenant',
          ownerUserId: 'user-a',
          candidateProfileId: 'profile-a',
        },
      }),
    );
  });

  it('reads the current assessment score and private projections for the verified workspace', async () => {
    await loadAdminOverview(subjectA);
    expect(mocks.loadOpportunityAssessmentReader).toHaveBeenCalledWith(
      subjectA,
    );
    expect(mocks.listOpportunityPageIds).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSubject: subjectA,
        assessmentCandidateMaterialFingerprint: 'evidence',
        assessmentPreferencesFingerprint: 'preferences',
        reviewFilter: 'unsorted',
        scoreSource: 'assessment',
        filters: expect.objectContaining({
          excludeExpired: true,
          excludeStale: true,
          sort: 'score',
          eligibilityBuckets: ['eligible', 'sponsorship_possible'],
        }),
      }),
    );
    expect(
      mocks.loadCurrentSourceOpportunityEligibility,
    ).toHaveBeenCalledExactlyOnceWith(subjectA);
    expect(mocks.listOpportunityPageIds).toHaveBeenCalledTimes(2);
    expect(
      mocks.listOpportunityPageIds.mock.calls.map(([query]) => [
        query.limit,
        query.offset,
      ]),
    ).toEqual([
      [90, 0],
      [90, 0],
    ]);
    expect(mocks.project).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ id: 'new' }),
      expect.objectContaining({ id: 'pending' }),
    ]);
  });

  it('excludes this user draft even with needs_input review and separates unknown scores', async () => {
    const a = await loadAdminOverview(subjectA);
    const b = await loadAdminOverview(subjectB);
    expect(a.opportunities.map((opportunity) => opportunity.id)).toEqual([
      'new',
    ]);
    expect(a.pendingOpportunities.map((opportunity) => opportunity.id)).toEqual(
      ['pending'],
    );
    expect(a.pendingOpportunities[0].fitScore).toBeNull();
    expect(b.opportunities.map((opportunity) => opportunity.id)).toEqual([
      'new',
      'draft',
    ]);
  });

  it('keeps both bucket orders while hydrating the shared candidate window once', async () => {
    const scored = Array.from({ length: 8 }, (_, index) => `scored-${index}`);
    const pending = Array.from({ length: 4 }, (_, index) => `pending-${index}`);
    mocks.listOpportunityPageIds.mockImplementation(async ({ filters }) =>
      filters.sort === 'score'
        ? ['missing', ...scored]
        : [scored[0], ...pending],
    );
    mocks.listAdminRecords.mockImplementation(async (resource) =>
      resource.slug === 'companies'
        ? [{ id: 'company', name: 'Synthetic Company' }]
        : [...scored, ...pending].reverse().map((id) => ({
            id,
            title: id,
            status: 'found',
            companyId: 'company',
          })),
    );
    mocks.project.mockResolvedValue(
      new Map(scored.map((id) => [id, assessment])),
    );

    const result = await loadAdminOverview(subjectA);
    expect(result.opportunities.map((card) => card.id)).toEqual(
      scored.slice(0, 6),
    );
    expect(result.pendingOpportunities.map((card) => card.id)).toEqual(
      pending.slice(0, 3),
    );
    expect(result.opportunities[0].company).toBe('Synthetic Company');
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(mocks.project.mock.calls[0][0]).toHaveLength(12);
    expect(
      mocks.listAdminRecords.mock.calls.filter(
        ([resource]) => resource.slug === 'opportunities',
      ),
    ).toHaveLength(1);
  });

  it('rejects missing selected profile before storage reads', async () => {
    await expect(
      loadAdminOverview({ tenantId: 'tenant', userId: 'user-a' }),
    ).rejects.toThrow('verified profile required');
    expect(mocks.getCollection).not.toHaveBeenCalled();
    expect(mocks.listOpportunityPageIds).not.toHaveBeenCalled();
  });

  it('returns honest empty sections without extra hydration when there are no new postings', async () => {
    mocks.taskList.mockResolvedValue([]);
    mocks.listOpportunityPageIds.mockResolvedValue([]);
    expect(await loadAdminOverview(subjectA)).toEqual({
      tasks: [],
      opportunities: [],
      pendingOpportunities: [],
    });
    expect(mocks.project).not.toHaveBeenCalled();
  });
});
