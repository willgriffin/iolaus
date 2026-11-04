import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCollection: vi.fn(),
  taskList: vi.fn(),
  applicationList: vi.fn(),
  listAdminRecords: vi.fn(),
  listOpportunityPageIds: vi.fn(),
  listCurrentDiscoveryMatches: vi.fn(),
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
  listCurrentDiscoveryMatches: mocks.listCurrentDiscoveryMatches,
  discoveryMatchForRecord: (
    matches: Map<string, unknown>,
    record: { id: string },
  ) => matches.get(record.id),
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
  mocks.listOpportunityPageIds.mockImplementation(
    async ({ workspaceSubject }) =>
      workspaceSubject.userId === subjectA.userId ? ['new'] : ['new', 'draft'],
  );
  mocks.listCurrentDiscoveryMatches.mockImplementation(
    async (ids: string[]) =>
      new Map(ids.map((id) => [id, { score: 82, reasons: [] }])),
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

  it('reads one bounded ranked window for the verified workspace, excluding application rows', async () => {
    const overview = await loadAdminOverview(subjectA);
    expect(mocks.listOpportunityPageIds).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceSubject: subjectA,
        currentQualified: true,
        excludeApplications: true,
        reviewFilter: 'unsorted',
        limit: 6,
        offset: 0,
        filters: expect.objectContaining({
          sort: 'best',
          excludeExpired: true,
          excludeStale: true,
        }),
      }),
    );
    expect(mocks.listCurrentDiscoveryMatches).toHaveBeenCalledExactlyOnceWith(
      ['new'],
      subjectA,
    );
    expect(
      overview.opportunities.map((card) => [card.id, card.fitScore]),
    ).toEqual([['new', 82]]);
    expect(overview.pendingOpportunities).toEqual([]);
  });

  it('drops a selected row which becomes stale during hydration', async () => {
    mocks.listCurrentDiscoveryMatches.mockResolvedValue(new Map());
    expect((await loadAdminOverview(subjectA)).opportunities).toEqual([]);
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
    expect(mocks.listCurrentDiscoveryMatches).not.toHaveBeenCalled();
  });
});
