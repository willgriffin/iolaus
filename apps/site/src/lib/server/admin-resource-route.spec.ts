import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const collections = new Map<string, { list: ReturnType<typeof vi.fn> }>();

  return {
    collections,
    countAdminResourceRecords: vi.fn(),
    countOpportunityRecords: vi.fn(),
    createAdminRecord: vi.fn(),
    createOpportunityQueryFingerprint: vi.fn(() => 'query-fingerprint'),
    createDraftApplicationForOpportunity: vi.fn(),
    createFactIntakeFromText: vi.fn(),
    deleteAdminRecord: vi.fn(),
    enqueueOpportunityIntelligence: vi.fn(),
    enqueueSourceCrawl: vi.fn(),
    getCollection: vi.fn(async (className: string) => {
      return (
        collections.get(className) ?? {
          list: vi.fn(async () => []),
        }
      );
    }),
    getAdminRecord: vi.fn(),
    listAdminRecords: vi.fn(),
    listComboOptions: vi.fn(),
    listOpportunityFilterOptions: vi.fn(),
    listOpportunityPageIds: vi.fn(),
    listReferenceOptions: vi.fn(),
    processRecommendationTask: vi.fn(),
    requireAdminResource: vi.fn(),
    acceptOpportunityForApplication: vi.fn(),
    bulkUpdateOpportunityReviews: vi.fn(),
    ensureCompanyResearch: vi.fn(),
    updateOpportunityReview: vi.fn(),
    serializeRecord: vi.fn((record: unknown) => record),
    syncRecommendedOpportunityDecisionTasks: vi.fn(),
    updateAdminRecord: vi.fn(),
    isOpportunityIntelligenceEnqueueError: vi.fn(),
    latestPostingPreflightStatus: vi.fn(async (id: string) => ({
      checkedAt: '2026-09-01T00:00:00.000Z',
      reason: 'http_ok',
      state: id === 'opp-1' ? 'live' : 'never_preflighted',
    })),
    loadTriageQueue: vi.fn(async () => ({
      candidates: [{ id: 'opp-1', title: 'Staff engineer' }],
      limit: 3,
      offset: 0,
      total: 3,
    })),
  };
});

vi.mock('./admin-data', () => ({
  countAdminResourceRecords: mocks.countAdminResourceRecords,
  createAdminRecord: mocks.createAdminRecord,
  DEFAULT_ADMIN_RECORD_PAGE_SIZE: 250,
  deleteAdminRecord: mocks.deleteAdminRecord,
  getAdminRecord: mocks.getAdminRecord,
  listAdminRecords: mocks.listAdminRecords,
  listComboOptions: mocks.listComboOptions,
  listReferenceOptions: mocks.listReferenceOptions,
  requireAdminResource: mocks.requireAdminResource,
  serializeRecord: mocks.serializeRecord,
  updateAdminRecord: mocks.updateAdminRecord,
}));

vi.mock('./opportunity-intelligence-job', () => ({
  enqueueOpportunityIntelligence: mocks.enqueueOpportunityIntelligence,
  isOpportunityIntelligenceEnqueueError:
    mocks.isOpportunityIntelligenceEnqueueError,
}));

vi.mock('./application-workflow', () => ({
  acceptOpportunityForApplication: mocks.acceptOpportunityForApplication,
  ensureCompanyResearch: mocks.ensureCompanyResearch,
  processRecommendationTask: mocks.processRecommendationTask,
  syncRecommendedOpportunityDecisionTasks:
    mocks.syncRecommendedOpportunityDecisionTasks,
}));

vi.mock('./fact-workflow', () => ({
  acceptFactCandidate: vi.fn(),
  createFactIntakeFromText: mocks.createFactIntakeFromText,
}));

vi.mock('./application-package', () => ({
  bulkUpdateOpportunityReviews: mocks.bulkUpdateOpportunityReviews,
  createDraftApplicationForOpportunity:
    mocks.createDraftApplicationForOpportunity,
  updateOpportunityReview: mocks.updateOpportunityReview,
}));

// The owner principal runs the real `executeAsPrincipal()` gate against an
// in-memory database; only the workflow writers behind it are mocked.
vi.mock('./smrt', () => ({
  getCollection: mocks.getCollection,
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: ':memory:' })),
}));

vi.mock('./source-schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source-schedules')>()),
  enqueueSourceCrawl: mocks.enqueueSourceCrawl,
}));

vi.mock('./posting-preflight-status', () => ({
  latestPostingPreflightStatus: mocks.latestPostingPreflightStatus,
}));

// The triage preset itself stays real, so the queue request the action builds
// is asserted against the shared filter model rather than against a stub.
vi.mock('./opportunity-triage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./opportunity-triage')>()),
  loadTriageQueue: mocks.loadTriageQueue,
}));

vi.mock('./admin-opportunity-query', () => ({
  countOpportunityRecords: mocks.countOpportunityRecords,
  createOpportunityQueryFingerprint: mocks.createOpportunityQueryFingerprint,
  listOpportunityFilterOptions: mocks.listOpportunityFilterOptions,
  listOpportunityPageIds: mocks.listOpportunityPageIds,
  OPPORTUNITY_TABLE_PAGE_SIZE: 100,
}));

function formRequest(opportunityIds: string[]): Request {
  const form = new FormData();
  for (const opportunityId of opportunityIds) {
    form.append('opportunityId', opportunityId);
  }
  return new Request('http://localhost/admin/opportunities', {
    body: form,
    method: 'POST',
  });
}

function postForm(path: string, fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(`http://localhost${path}`, { body: form, method: 'POST' });
}

/** Every generated operation permission the owner-principal form actions can require. */
const ownerPermissions = [
  ...['applications', 'opportunities', 'sources', 'tasks'].flatMap(
    (collection) =>
      ['read', 'create', 'update'].map((action) => `${collection}.${action}`),
  ),
  'agentruns.read',
  'companies.read',
  'companies.update',
  'decisions.create',
  'decisions.read',
  'decisions.update',
  'evaluationscores.read',
  'factcandidates.create',
  'factintakes.create',
  'factintakes.update',
  'opportunityplaces.create',
  'opportunityplaces.delete',
  'opportunityplaces.read',
  'opportunityroles.create',
  'opportunityroles.delete',
  'opportunityroles.read',
  'opportunitytags.create',
  'opportunitytags.delete',
  'opportunitytags.read',
  'resumeassets.read',
];

function without(...denied: string[]): string[] {
  return ownerPermissions.filter((slug) => !denied.includes(slug));
}

function ownerLocals(permissions: string[] = ownerPermissions) {
  return { permissions, tenantId: 'tenant-1', user: { id: 'user-1' } };
}

function auditEntries(info: { mock: { calls: unknown[][] } }) {
  return info.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry?.event === 'owner_principal.audit',
    );
}

describe('admin-resource-route', () => {
  beforeEach(() => {
    mocks.countAdminResourceRecords.mockReset();
    mocks.countOpportunityRecords.mockReset();
    mocks.createAdminRecord.mockReset();
    mocks.createDraftApplicationForOpportunity.mockReset();
    mocks.createFactIntakeFromText.mockReset();
    mocks.collections.clear();
    mocks.deleteAdminRecord.mockReset();
    mocks.enqueueOpportunityIntelligence.mockReset();
    mocks.enqueueSourceCrawl.mockReset();
    mocks.getCollection.mockClear();
    mocks.getAdminRecord.mockReset();
    mocks.isOpportunityIntelligenceEnqueueError.mockReset();
    mocks.listAdminRecords.mockReset();
    mocks.listComboOptions.mockReset();
    mocks.listOpportunityFilterOptions.mockReset();
    mocks.listOpportunityFilterOptions.mockResolvedValue({
      employmentTypes: [],
      freshness: [],
      seniorities: [],
      skills: [],
      statuses: [],
      workModes: [],
    });
    mocks.listOpportunityPageIds.mockReset();
    mocks.listReferenceOptions.mockReset();
    mocks.processRecommendationTask.mockReset();
    mocks.requireAdminResource.mockReset();
    mocks.acceptOpportunityForApplication.mockReset();
    mocks.bulkUpdateOpportunityReviews.mockReset();
    mocks.ensureCompanyResearch.mockReset();
    mocks.updateOpportunityReview.mockReset();
    mocks.serializeRecord.mockClear();
    mocks.syncRecommendedOpportunityDecisionTasks.mockReset();
    mocks.updateAdminRecord.mockReset();
  });

  it("forwards the owner's explicit inconclusive-posting override to a recommendation decision", async () => {
    mocks.processRecommendationTask.mockResolvedValue({ status: 'accepted' });
    const form = new FormData();
    form.set('deciderProfileId', 'profile-1');
    form.set('decision', 'accept_to_apply');
    form.set(
      'preflightOverrideReason',
      'I checked the employer posting and it remains open.',
    );
    form.set('reason', 'Proceed with this role.');
    form.set('taskId', 'task-1');

    const { processRecommendationTaskAction } = await import(
      './admin-resource-route'
    );
    await processRecommendationTaskAction(
      new Request('http://localhost/admin/tasks', {
        body: form,
        method: 'POST',
      }),
      ownerLocals(),
    );

    expect(mocks.processRecommendationTask).toHaveBeenCalledWith({
      deciderProfileId: 'profile-1',
      decision: 'accept_to_apply',
      preflightOverrideReason:
        'I checked the employer posting and it remains open.',
      reason: 'Proceed with this role.',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });
  }, 15_000);

  it('runs recommendation decisions as the owner principal and audits them', async () => {
    mocks.processRecommendationTask.mockResolvedValue({ status: 'deferred' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { processRecommendationTaskAction } = await import(
      './admin-resource-route'
    );

    const result = await processRecommendationTaskAction(
      postForm('/admin/tasks', { decision: 'defer', taskId: 'task-1' }),
      ownerLocals(),
    );

    expect(result).toEqual({ status: 'deferred' });
    expect(mocks.processRecommendationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'defer',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    );
    expect(auditEntries(info)).toContainEqual(
      expect.objectContaining({
        action: 'admin.processRecommendationTask',
        actorUserId: 'user-1',
        agentClass: 'iolaus/owner',
        onBehalfOfUserId: 'user-1',
        tenantId: 'tenant-1',
      }),
    );
    info.mockRestore();
  });

  it('refuses recommendation decisions the owner principal lacks permission for', async () => {
    const { processRecommendationTaskAction } = await import(
      './admin-resource-route'
    );

    await expect(
      processRecommendationTaskAction(
        postForm('/admin/tasks', { decision: 'defer', taskId: 'task-1' }),
        ownerLocals(without('decisions.create')),
      ),
    ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });

    // Accepting additionally needs the application and research writes and
    // the AgentRun audit surrogate for the posting-preflight verdict.
    for (const denied of ['applications.create', 'agentruns.read']) {
      await expect(
        processRecommendationTaskAction(
          postForm('/admin/tasks', {
            decision: 'accept_to_apply',
            taskId: 'task-1',
          }),
          ownerLocals(without(denied)),
        ),
        denied,
      ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });
    }
    expect(mocks.processRecommendationTask).not.toHaveBeenCalled();

    // A non-apply decision records no AgentRun and does not require them.
    mocks.processRecommendationTask.mockResolvedValue({ status: 'rejected' });
    await processRecommendationTaskAction(
      postForm('/admin/tasks', { decision: 'reject', taskId: 'task-1' }),
      ownerLocals(
        without('agentruns.read', 'applications.create', 'sources.create'),
      ),
    );
    expect(mocks.processRecommendationTask).toHaveBeenCalledTimes(1);
  });

  it('runs draft application creation as the owner principal and audits it', async () => {
    mocks.createDraftApplicationForOpportunity.mockResolvedValue({
      id: 'app-1',
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { createDraftApplicationAction } = await import(
      './admin-resource-route'
    );

    const result = await createDraftApplicationAction(
      postForm('/admin/opportunities/opp-1', {
        opportunityId: 'opp-1',
        preflightOverrideReason: 'Checked the posting by hand.',
        resumeMode: 'default',
      }),
      ownerLocals(),
    );

    expect(result).toEqual({ id: 'app-1' });
    expect(mocks.createDraftApplicationForOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityId: 'opp-1',
        preflightOverrideReason: 'Checked the posting by hand.',
        resumeMode: 'default',
        user: { id: 'user-1' },
      }),
    );
    expect(auditEntries(info)).toContainEqual(
      expect.objectContaining({
        action: 'admin.createDraftApplication',
        actorUserId: 'user-1',
        onBehalfOfUserId: 'user-1',
      }),
    );
    info.mockRestore();
  });

  it('refuses draft application creation the owner principal lacks permission for', async () => {
    const { createDraftApplicationAction } = await import(
      './admin-resource-route'
    );

    for (const denied of [
      'agentruns.read',
      'applications.create',
      'tasks.update',
    ]) {
      await expect(
        createDraftApplicationAction(
          postForm('/admin/opportunities/opp-1', { opportunityId: 'opp-1' }),
          ownerLocals(without(denied)),
        ),
        denied,
      ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });
    }
    expect(mocks.createDraftApplicationForOpportunity).not.toHaveBeenCalled();
  });

  it('runs fact intake creation as the owner principal and audits it', async () => {
    mocks.createFactIntakeFromText.mockResolvedValue({
      candidates: [],
      intake: { id: 'intake-1' },
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { createFactIntakeAction } = await import('./admin-resource-route');

    const result = await createFactIntakeAction(
      postForm('/admin/experiences/exp-1', {
        rawText: 'Shipped the platform.',
        targetEntityId: 'exp-1',
        targetEntityType: 'Experience',
      }),
      ownerLocals(),
    );

    expect(result).toEqual({ candidates: [], intake: { id: 'intake-1' } });
    expect(mocks.createFactIntakeFromText).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: 'Shipped the platform.',
        targetEntityId: 'exp-1',
        targetEntityType: 'Experience',
        user: { id: 'user-1' },
      }),
    );
    expect(auditEntries(info)).toContainEqual(
      expect.objectContaining({
        action: 'admin.createFactIntake',
        actorUserId: 'user-1',
        onBehalfOfUserId: 'user-1',
      }),
    );
    info.mockRestore();
  });

  it('refuses fact intake creation the owner principal lacks permission for', async () => {
    const { createFactIntakeAction } = await import('./admin-resource-route');

    for (const denied of ['factintakes.create', 'factcandidates.create']) {
      await expect(
        createFactIntakeAction(
          postForm('/admin/experiences/exp-1', { rawText: 'Shipped it.' }),
          ownerLocals(without(denied)),
        ),
      ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });
    }
    expect(mocks.createFactIntakeFromText).not.toHaveBeenCalled();
  });

  it('creates opportunity membership joins with the route opportunity id fixed server-side', async () => {
    const tagResource = {
      className: 'OpportunityTag',
      fields: [],
      label: 'Opportunity tags',
      singularLabel: 'Opportunity tag',
      slug: 'opportunity-tags',
      tableColumns: [],
    };
    mocks.requireAdminResource.mockImplementation((slug: string) => {
      if (slug === 'opportunity-tags') return tagResource;
      throw new Error(`unexpected resource ${slug}`);
    });
    mocks.createAdminRecord.mockResolvedValue({ id: 'link-1' });
    const form = new FormData();
    form.set('relation', 'tags');
    form.set('opportunityId', 'someone-elses-opportunity');
    form.set('tagId', 'tag-1');
    form.set('tagRole', 'required_skill');

    const { createOpportunityRelationAction } = await import(
      './admin-resource-route'
    );
    const result = await createOpportunityRelationAction(
      'opp-1',
      new Request('http://localhost/admin/opportunities/opp-1', {
        body: form,
        method: 'POST',
      }),
      ownerLocals(),
    );

    expect(result).toEqual({ id: 'link-1' });
    expect(mocks.createAdminRecord).toHaveBeenCalledTimes(1);
    const [resource, submitted, user] = mocks.createAdminRecord.mock.calls[0];
    expect(resource).toBe(tagResource);
    expect((submitted as FormData).get('opportunityId')).toBe('opp-1');
    expect((submitted as FormData).get('tagRole')).toBe('required_skill');
    expect(user).toEqual({ id: 'user-1' });
  });

  it('rejects unknown opportunity relations before touching the database', async () => {
    const form = new FormData();
    form.set('relation', 'attachments');

    const { createOpportunityRelationAction } = await import(
      './admin-resource-route'
    );
    await expect(
      createOpportunityRelationAction(
        'opp-1',
        new Request('http://localhost/admin/opportunities/opp-1', {
          body: form,
          method: 'POST',
        }),
        ownerLocals(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.requireAdminResource).not.toHaveBeenCalled();
    expect(mocks.createAdminRecord).not.toHaveBeenCalled();
  });

  it('accepts an opportunity only under the full accept-to-apply operation set', async () => {
    mocks.acceptOpportunityForApplication.mockResolvedValue({
      applicationId: 'app-1',
      status: 'accepted',
    });
    const { acceptOpportunityAction } = await import('./admin-resource-route');
    const fields = {
      humanReviewNotes: 'Strong platform fit',
      opportunityId: 'opp-1',
      preflightOverrideReason: 'Posting verified by hand',
      reviewedByProfileId: 'profile-1',
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    for (const denied of [
      'agentruns.read',
      'applications.create',
      'companies.update',
      'decisions.update',
      'evaluationscores.read',
      'sources.create',
      'tasks.update',
    ]) {
      await expect(
        acceptOpportunityAction(
          postForm('/admin/opportunities', fields),
          ownerLocals(without(denied)),
        ),
        denied,
      ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });
    }
    expect(mocks.acceptOpportunityForApplication).not.toHaveBeenCalled();

    const result = await acceptOpportunityAction(
      postForm('/admin/opportunities', fields),
      ownerLocals(),
    );

    expect(result).toEqual({ applicationId: 'app-1', status: 'accepted' });
    expect(mocks.acceptOpportunityForApplication).toHaveBeenCalledWith({
      deciderProfileId: 'profile-1',
      opportunityId: 'opp-1',
      preflightOverrideReason: 'Posting verified by hand',
      reason: 'Strong platform fit',
      user: { id: 'user-1' },
    });
    expect(auditEntries(info)).toContainEqual(
      expect.objectContaining({ action: 'admin.acceptOpportunity' }),
    );
    info.mockRestore();
    // Nine principal runs through the real authorization machinery: ~2s on an
    // idle machine, but past the 5s default under a loaded CI pool. Give it
    // headroom rather than letting a slow runner read as a failure.
  }, 30_000);

  it('refuses relation deletion before any lookup when the caller lacks read or delete authority', async () => {
    mocks.requireAdminResource.mockReturnValue({
      className: 'OpportunityRole',
      fields: [],
      label: 'Opportunity roles',
      singularLabel: 'Opportunity role',
      slug: 'opportunity-roles',
      tableColumns: [],
    });
    mocks.getAdminRecord.mockResolvedValue({
      id: 'link-2',
      opportunityId: 'opp-other',
    });
    const { deleteOpportunityRelationAction } = await import(
      './admin-resource-route'
    );

    for (const denied of ['opportunityroles.read', 'opportunityroles.delete']) {
      const form = new FormData();
      form.set('relation', 'roles');
      form.set('id', 'link-2');
      await expect(
        deleteOpportunityRelationAction(
          'opp-1',
          new Request('http://localhost/admin/opportunities/opp-1', {
            body: form,
            method: 'POST',
          }),
          ownerLocals(without(denied)),
        ),
        denied,
      ).rejects.toMatchObject({ body: { message: 'Forbidden' }, status: 403 });
    }
    // A missing id is refused the same way: nothing about the request is
    // examined before authorization.
    const missingIdForm = new FormData();
    missingIdForm.set('relation', 'roles');
    await expect(
      deleteOpportunityRelationAction(
        'opp-1',
        new Request('http://localhost/admin/opportunities/opp-1', {
          body: missingIdForm,
          method: 'POST',
        }),
        ownerLocals(without('opportunityroles.delete')),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(mocks.getAdminRecord).not.toHaveBeenCalled();
    expect(mocks.deleteAdminRecord).not.toHaveBeenCalled();
  });

  it('only deletes membership joins that belong to the route opportunity', async () => {
    const roleResource = {
      className: 'OpportunityRole',
      fields: [],
      label: 'Opportunity roles',
      singularLabel: 'Opportunity role',
      slug: 'opportunity-roles',
      tableColumns: [],
    };
    mocks.requireAdminResource.mockReturnValue(roleResource);
    mocks.getAdminRecord.mockResolvedValue({
      id: 'link-2',
      opportunityId: 'opp-other',
    });
    const form = new FormData();
    form.set('relation', 'roles');
    form.set('id', 'link-2');

    const { deleteOpportunityRelationAction } = await import(
      './admin-resource-route'
    );
    await expect(
      deleteOpportunityRelationAction(
        'opp-1',
        new Request('http://localhost/admin/opportunities/opp-1', {
          body: form,
          method: 'POST',
        }),
        ownerLocals(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.deleteAdminRecord).not.toHaveBeenCalled();

    mocks.getAdminRecord.mockResolvedValueOnce(null);
    const missingForm = new FormData();
    missingForm.set('relation', 'roles');
    missingForm.set('id', 'link-missing');
    await expect(
      deleteOpportunityRelationAction(
        'opp-1',
        new Request('http://localhost/admin/opportunities/opp-1', {
          body: missingForm,
          method: 'POST',
        }),
        ownerLocals(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.getAdminRecord).toHaveBeenLastCalledWith(
      roleResource,
      'link-missing',
    );
    expect(mocks.deleteAdminRecord).not.toHaveBeenCalled();

    mocks.getAdminRecord.mockResolvedValue({
      id: 'link-2',
      opportunityId: 'opp-1',
    });
    mocks.deleteAdminRecord.mockResolvedValue({ deleted: true });
    const okForm = new FormData();
    okForm.set('relation', 'roles');
    okForm.set('id', 'link-2');
    await deleteOpportunityRelationAction(
      'opp-1',
      new Request('http://localhost/admin/opportunities/opp-1', {
        body: okForm,
        method: 'POST',
      }),
      ownerLocals(),
    );
    expect(mocks.deleteAdminRecord).toHaveBeenCalledWith(
      roleResource,
      expect.any(FormData),
    );
  });

  it('builds the admin page shell without waiting on record or editor queries', async () => {
    const resource = {
      className: 'Task',
      description: '',
      fields: [],
      icon: 'check-square',
      label: 'Tasks',
      orderBy: 'updated_at DESC',
      singularLabel: 'Task',
      slug: 'tasks',
      tableColumns: ['title'],
    };
    mocks.requireAdminResource.mockReturnValue(resource);

    const { loadAdminResourcePageShellData } = await import(
      './admin-resource-route'
    );
    const data = loadAdminResourcePageShellData(
      'tasks',
      new URL('http://localhost/admin/tasks?owner=me&status=open&page=3'),
      { tenantId: 'tenant-a', user: { id: 'user-a' } },
    );

    expect(data).toMatchObject({
      activeTaskOwnerFilter: 'me',
      activeTaskStatusFilter: 'open',
      loading: true,
      pagination: {
        page: 3,
        pageSize: 250,
        totalRecords: 0,
      },
      records: [],
      resource,
      tenantId: 'tenant-a',
      user: { id: 'user-a' },
    });
    expect(mocks.countAdminResourceRecords).not.toHaveBeenCalled();
    expect(mocks.listAdminRecords).not.toHaveBeenCalled();
    expect(mocks.listComboOptions).not.toHaveBeenCalled();
    expect(mocks.listReferenceOptions).not.toHaveBeenCalled();
  });

  it('hydrates only the current server-paged opportunity page', async () => {
    const records = Array.from({ length: 339 }, (_, index) => ({
      id: `opp-${index + 1}`,
      title: `Opportunity ${index + 1}`,
    }));
    const applicationList = vi.fn(async () => []);
    mocks.collections.set('Application', { list: applicationList });
    const pageIds = records.slice(100, 200).map((record) => record.id);
    mocks.countOpportunityRecords.mockResolvedValue(records.length);
    mocks.listOpportunityPageIds.mockResolvedValue(pageIds);
    mocks.listAdminRecords.mockImplementation(async () =>
      [...records].reverse(),
    );
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities?page=2'),
    );

    expect(mocks.listOpportunityPageIds).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 100,
        reviewFilter: 'unsorted',
      }),
    );
    expect(mocks.listAdminRecords).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'opportunities' }),
      {
        limit: 100,
        where: { 'id in': pageIds },
      },
    );
    expect(data.records).toHaveLength(100);
    expect(data.records[0]?.id).toBe('opp-101');
    expect(data.records.at(-1)?.id).toBe('opp-200');
    expect(applicationList).toHaveBeenCalledWith({
      orderBy: 'updated_at DESC',
      where: {
        'opportunityId in': pageIds,
      },
    });
    expect(data.pagination).toMatchObject({
      page: 2,
      pageSize: 100,
      recordCount: 100,
      totalRecords: 339,
    });
    expect(mocks.listOpportunityFilterOptions).not.toHaveBeenCalled();
    expect(mocks.listComboOptions).not.toHaveBeenCalled();
    expect(mocks.listReferenceOptions).not.toHaveBeenCalled();
  });

  it('loads compact opportunity facets only when the filter drawer requests them', async () => {
    const pageIds = ['opp-101', 'opp-102'];
    const pageRecords = pageIds.map((id) => ({ id, title: id }));
    const applicationList = vi.fn(async () => []);
    mocks.collections.set('Application', { list: applicationList });
    mocks.countOpportunityRecords.mockResolvedValue(339);
    mocks.listOpportunityPageIds.mockResolvedValue(pageIds);
    mocks.listAdminRecords.mockResolvedValue([...pageRecords].reverse());
    mocks.listOpportunityFilterOptions.mockResolvedValue({
      employmentTypes: [],
      freshness: [],
      seniorities: [],
      skills: ['Rust', 'SvelteKit'],
      statuses: ['found', 'recommended'],
      workModes: [],
    });
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities?facets&page=2'),
    );

    expect(mocks.listOpportunityPageIds).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ sort: 'best' }),
        limit: 100,
        offset: 100,
        reviewFilter: 'unsorted',
      }),
    );
    expect(mocks.listAdminRecords).toHaveBeenCalledTimes(1);
    expect(mocks.listAdminRecords).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'opportunities' }),
      {
        limit: 2,
        where: { 'id in': pageIds },
      },
    );
    expect(data.records.map((record) => record.id)).toEqual(pageIds);
    expect(applicationList).toHaveBeenCalledWith({
      orderBy: 'updated_at DESC',
      where: { 'opportunityId in': pageIds },
    });
    expect(data.opportunityFilterOptions.skills).toEqual(['Rust', 'SvelteKit']);
    expect(mocks.listOpportunityFilterOptions).toHaveBeenCalledWith('unsorted');
    expect(data.pagination).toMatchObject({
      page: 2,
      pageSize: 100,
      recordCount: 2,
      totalRecords: 339,
    });
  });

  it('applies opportunity drawer filters before pagination', async () => {
    const records = Array.from({ length: 300 }, (_, index) => ({
      id: `opp-${index + 1}`,
      requiredSkills: index === 299 ? 'SvelteKit' : 'Rust',
      title: `Opportunity ${index + 1}`,
    }));
    mocks.collections.set('Application', { list: vi.fn(async () => []) });
    mocks.countOpportunityRecords.mockResolvedValue(1);
    mocks.listOpportunityPageIds.mockResolvedValue(['opp-300']);
    mocks.listAdminRecords.mockResolvedValue([records[299]]);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities?skill=SvelteKit'),
    );

    expect(data.records).toHaveLength(1);
    expect(data.records[0]?.id).toBe('opp-300');
    expect(data.pagination).toMatchObject({
      page: 1,
      recordCount: 1,
      totalRecords: 1,
    });
    expect(mocks.listOpportunityPageIds).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ skills: ['SvelteKit'] }),
      }),
    );
  });

  it('defaults opportunity review filtering to unsorted decisions', async () => {
    const records = [
      { humanReviewStatus: '', id: 'opp-empty', title: 'Empty' },
      {
        humanReviewStatus: 'needs_input',
        id: 'opp-needs-input',
        title: 'Needs input',
      },
      { humanReviewStatus: 'reviewed', id: 'opp-reviewed', title: 'Reviewed' },
      { humanReviewStatus: 'apply', id: 'opp-apply', title: 'Apply' },
      { humanReviewStatus: 'maybe', id: 'opp-maybe', title: 'Maybe' },
      { humanReviewStatus: 'reject', id: 'opp-reject', title: 'Reject' },
    ];
    const pageIds = ['opp-empty', 'opp-needs-input', 'opp-reviewed'];
    mocks.countOpportunityRecords.mockResolvedValue(pageIds.length);
    mocks.listOpportunityPageIds.mockResolvedValue(pageIds);
    mocks.listAdminRecords.mockResolvedValue(records);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities'),
    );

    expect(data.activeReviewFilter).toBe('unsorted');
    expect(data.records.map((record) => record.id)).toEqual([
      'opp-empty',
      'opp-needs-input',
      'opp-reviewed',
    ]);
    expect(data.pagination).toMatchObject({
      recordCount: 3,
      totalRecords: 3,
    });
    expect(mocks.countOpportunityRecords).toHaveBeenCalledWith(
      expect.objectContaining({ reviewFilter: 'unsorted' }),
    );
  });

  it('supports explicitly viewing all opportunity review statuses', async () => {
    const records = [
      { humanReviewStatus: '', id: 'opp-empty', title: 'Empty' },
      { humanReviewStatus: 'apply', id: 'opp-apply', title: 'Apply' },
      { humanReviewStatus: 'maybe', id: 'opp-maybe', title: 'Maybe' },
      { humanReviewStatus: 'reject', id: 'opp-reject', title: 'Reject' },
    ];
    mocks.countOpportunityRecords.mockResolvedValue(records.length);
    mocks.listOpportunityPageIds.mockResolvedValue(
      records.map((record) => record.id),
    );
    mocks.listAdminRecords.mockResolvedValue(records);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities?review=all'),
    );

    expect(data.activeReviewFilter).toBe('all');
    expect(data.records.map((record) => record.id)).toEqual([
      'opp-empty',
      'opp-apply',
      'opp-maybe',
      'opp-reject',
    ]);
  });

  it('applies task owner and status filters before pagination', async () => {
    const records = [
      {
        assigneeRole: 'owner',
        id: 'task-owner-open',
        status: 'open',
        title: 'Owner open',
      },
      {
        assigneeRole: 'agent',
        id: 'task-agent-done',
        status: 'done',
        title: 'Agent done',
      },
    ];
    mocks.countAdminResourceRecords.mockResolvedValue(1);
    mocks.listAdminRecords.mockResolvedValue([records[0]]);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Task',
      description: '',
      fields: [],
      icon: 'check-square',
      label: 'Tasks',
      orderBy: 'updated_at DESC',
      singularLabel: 'Task',
      slug: 'tasks',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'tasks',
      new URL('http://localhost/admin/tasks?owner=owner&status=open'),
    );

    expect(data.activeTaskOwnerFilter).toBe('owner');
    expect(data.activeTaskStatusFilter).toBe('open');
    expect(data.records.map((record) => record.id)).toEqual([
      'task-owner-open',
    ]);
    expect(data.pagination).toMatchObject({
      recordCount: 1,
      totalRecords: 1,
    });
    expect(mocks.countAdminResourceRecords).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'tasks' }),
      {
        where: {
          assigneeRole: 'owner',
          status: 'open',
        },
      },
    );
    expect(mocks.listAdminRecords).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'tasks' }),
      {
        limit: 250,
        offset: 0,
        where: {
          assigneeRole: 'owner',
          status: 'open',
        },
      },
    );
  });

  it('loads latest evaluation scores in one batch for each opportunity page', async () => {
    const records = [
      {
        id: 'opp-1',
        sourceContentFingerprint: 'fingerprint-opp-1',
        title: 'Opportunity 1',
      },
      {
        id: 'opp-2',
        sourceContentFingerprint: 'fingerprint-opp-2',
        title: 'Opportunity 2',
      },
      {
        id: 'opp-3',
        sourceContentFingerprint: 'fingerprint-opp-3',
        title: 'Opportunity 3',
      },
      {
        id: 'opp-4',
        sourceContentFingerprint: '',
        title: 'Opportunity 4',
      },
    ];
    const evaluationScoreList = vi.fn(
      async (_options?: Record<string, unknown>) => [
        {
          id: 'score-opp-2-stale',
          opportunityId: 'opp-2',
          score: 99,
          sourceContentFingerprint: 'fingerprint-opp-2-old',
          updated_at: '2026-01-03T00:00:00.000Z',
        },
        {
          id: 'score-opp-2-legacy',
          opportunityId: 'opp-2',
          score: 98,
          sourceContentFingerprint: '',
          updated_at: '2026-01-02T12:00:00.000Z',
        },
        {
          id: 'score-opp-2-newer',
          opportunityId: 'opp-2',
          score: 92,
          sourceContentFingerprint: 'fingerprint-opp-2',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'score-opp-1',
          opportunityId: 'opp-1',
          score: 91,
          sourceContentFingerprint: 'fingerprint-opp-1',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'score-opp-3-legacy',
          opportunityId: 'opp-3',
          score: 90,
          sourceContentFingerprint: '',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'score-opp-4-legacy',
          opportunityId: 'opp-4',
          score: 88,
          sourceContentFingerprint: '',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'score-opp-2-older',
          opportunityId: 'opp-2',
          score: 72,
          updated_at: '2025-12-31T00:00:00.000Z',
        },
      ],
    );
    mocks.collections.set('Application', { list: vi.fn(async () => []) });
    mocks.collections.set('EvaluationScore', { list: evaluationScoreList });
    mocks.countOpportunityRecords.mockResolvedValue(records.length);
    mocks.listOpportunityPageIds.mockResolvedValue([
      'opp-2',
      'opp-1',
      'opp-4',
      'opp-3',
    ]);
    mocks.listAdminRecords.mockResolvedValue(records);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Opportunity',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'opportunities',
      new URL('http://localhost/admin/opportunities'),
    );

    expect(
      data.records.map((record) => [record.id, record.latestScore]),
    ).toEqual([
      ['opp-2', 92],
      ['opp-1', 91],
      ['opp-4', 88],
      ['opp-3', null],
    ]);
    expect(evaluationScoreList).toHaveBeenCalled();
    for (const [options] of evaluationScoreList.mock.calls) {
      expect(options).toMatchObject({
        orderBy: 'updated_at DESC',
      });
      const where = options?.where as
        | { 'opportunityId in': string[] }
        | undefined;
      expect(where?.['opportunityId in'].toSorted()).toEqual([
        'opp-1',
        'opp-2',
        'opp-3',
        'opp-4',
      ]);
    }
  });

  it('loads project names onto experience rows so projects are visible in the experience list', async () => {
    const records = [
      {
        experienceKey: 'happy-vertical',
        id: 'experience-1',
      },
      {
        experienceKey: 'other',
        id: 'experience-2',
      },
    ];
    const projectList = vi.fn(async () => [
      {
        experienceId: 'experience-1',
        name: 's-m-r-t',
        projectKey: 'smrt',
      },
      {
        experienceId: 'experience-1',
        name: 'AI applications',
        projectKey: 'ai-apps',
      },
    ]);
    mocks.collections.set('Project', { list: projectList });
    mocks.countAdminResourceRecords.mockResolvedValue(records.length);
    mocks.listAdminRecords.mockResolvedValue(records);
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockReturnValue({
      className: 'Experience',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Experience',
      orderBy: 'sortOrder ASC',
      singularLabel: 'experience item',
      slug: 'experience',
      tableColumns: ['experienceKey', 'projectNames'],
    });

    const { loadAdminResourcePageData } = await import(
      './admin-resource-route'
    );
    const data = await loadAdminResourcePageData(
      'experience',
      new URL('http://localhost/admin/experience'),
    );

    expect(projectList).toHaveBeenCalledWith({
      orderBy: 'sortOrder ASC',
      where: { 'experienceId in': ['experience-1', 'experience-2'] },
    });
    expect(data.records).toEqual([
      {
        experienceKey: 'happy-vertical',
        id: 'experience-1',
        projectNames: 's-m-r-t, AI applications',
      },
      {
        experienceKey: 'other',
        id: 'experience-2',
        projectNames: '',
      },
    ]);
  });

  it('loads inline editor data for projects associated with an experience record', async () => {
    const projectRecords = [
      {
        endPrecision: 'year',
        experienceId: 'experience-1',
        id: 'project-1',
        name: 's-m-r-t',
        projectKey: 'smrt',
        startPrecision: 'year',
        summary: 'Schema and domain knowledge tooling.',
      },
      {
        endPrecision: 'year',
        experienceId: 'experience-1',
        id: 'project-2',
        name: '',
        projectKey: 'ai-apps',
        startPrecision: 'year',
        summary: '',
      },
    ];
    const achievementRecords = [
      {
        body: 'Generated schema-aware code review context.',
        experienceId: 'experience-1',
        id: 'achievement-1',
        metric: '',
        projectId: 'project-1',
        title: 'Domain review context',
      },
      {
        body: 'Captured architecture decisions.',
        experienceId: 'experience-1',
        id: 'achievement-2',
        metric: '3 workflows',
        projectId: 'project-1',
        title: '',
      },
    ];
    const projectList = vi.fn(async () => projectRecords);
    const achievementList = vi.fn(async () => achievementRecords);
    const experienceResource = {
      className: 'Experience',
      description: '',
      fields: [],
      icon: 'briefcase',
      label: 'Experience',
      orderBy: 'sortOrder ASC',
      singularLabel: 'experience item',
      slug: 'experience',
      tableColumns: ['experienceKey', 'projectNames'],
    };
    const projectResource = {
      className: 'Project',
      description: '',
      fields: [{ key: 'experienceId', kind: 'combo', label: 'Experience' }],
      icon: 'layers',
      label: 'Projects',
      orderBy: 'sortOrder ASC',
      singularLabel: 'project',
      slug: 'projects',
      tableColumns: ['name'],
    };
    const achievementResource = {
      className: 'Achievement',
      description: '',
      fields: [
        { key: 'experienceId', kind: 'combo', label: 'Experience' },
        { key: 'projectId', kind: 'combo', label: 'Project' },
        { key: 'title', kind: 'text', label: 'Title' },
        { key: 'body', kind: 'textarea', label: 'Body' },
      ],
      icon: 'file-text',
      label: 'Achievements',
      orderBy: 'sortOrder ASC',
      singularLabel: 'achievement',
      slug: 'achievements',
      tableColumns: ['title'],
    };
    mocks.collections.set('Project', { list: projectList });
    mocks.collections.set('Achievement', { list: achievementList });
    mocks.getAdminRecord.mockResolvedValue({
      experienceKey: 'happy-vertical',
      id: 'experience-1',
    });
    mocks.listComboOptions.mockResolvedValue({});
    mocks.listReferenceOptions.mockResolvedValue({});
    mocks.requireAdminResource.mockImplementation((slug: string) => {
      if (slug === 'projects') return projectResource;
      if (slug === 'achievements') return achievementResource;
      return experienceResource;
    });

    const { loadAdminRecordPageData } = await import('./admin-resource-route');
    const data = await loadAdminRecordPageData('experience', 'experience-1', {
      includeRelatedProjects: true,
      returnTo: 'https://example.test/admin/experience',
    });

    expect(projectList).toHaveBeenCalledWith({
      orderBy: 'sortOrder ASC',
      where: { experienceId: 'experience-1' },
    });
    expect(achievementList).toHaveBeenCalledWith({
      orderBy: 'sortOrder ASC',
      where: { 'projectId in': ['project-1', 'project-2'] },
    });
    expect(data.relatedProjects).toEqual([
      {
        achievements: [
          {
            body: 'Generated schema-aware code review context.',
            href: '/admin/achievements/achievement-1',
            id: 'achievement-1',
            label: 'Generated schema-aware code review context.',
            metric: '',
            record: achievementRecords[0],
          },
          {
            body: 'Captured architecture decisions.',
            href: '/admin/achievements/achievement-2',
            id: 'achievement-2',
            label: 'Captured architecture decisions.',
            metric: '3 workflows',
            record: achievementRecords[1],
          },
        ],
        href: '/admin/projects/project-1',
        id: 'project-1',
        label: 's-m-r-t',
        record: projectRecords[0],
        summary: 'Schema and domain knowledge tooling.',
      },
      {
        achievements: [],
        href: '/admin/projects/project-2',
        id: 'project-2',
        label: 'ai-apps',
        record: projectRecords[1],
        summary: '',
      },
    ]);
    expect(data.relatedProjectBulletEditor).toMatchObject({
      createRecord: {
        experienceId: 'experience-1',
        sortOrder: 0,
      },
      resource: achievementResource,
    });
    expect(data.relatedProjectEditor).toMatchObject({
      createRecord: {
        endPrecision: 'year',
        experienceId: 'experience-1',
        sortOrder: 2,
        startPrecision: 'year',
      },
      resource: projectResource,
    });
    expect(data.returnTo).toBe('');
  });

  it('creates a related project against the current experience item', async () => {
    const projectResource = {
      className: 'Project',
      description: '',
      fields: [],
      icon: 'layers',
      label: 'Projects',
      orderBy: 'sortOrder ASC',
      singularLabel: 'project',
      slug: 'projects',
      tableColumns: ['name'],
    };
    const form = new FormData();
    form.set('experienceId', 'other-experience');
    form.set('name', 'Inline project');
    mocks.createAdminRecord.mockResolvedValue({ id: 'project-1' });
    mocks.requireAdminResource.mockReturnValue(projectResource);

    const { createExperienceProjectAction } = await import(
      './admin-resource-route'
    );
    await createExperienceProjectAction(
      'experience-1',
      new Request('http://localhost/admin/experience/experience-1/edit', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    const [, submittedForm, user] = mocks.createAdminRecord.mock.calls[0];
    expect(submittedForm.get('experienceId')).toBe('experience-1');
    expect(submittedForm.get('name')).toBe('Inline project');
    expect(user).toEqual({ id: 'user-1' });
  });

  it('updates a related project only when it belongs to the current experience item', async () => {
    const projectResource = {
      className: 'Project',
      description: '',
      fields: [],
      icon: 'layers',
      label: 'Projects',
      orderBy: 'sortOrder ASC',
      singularLabel: 'project',
      slug: 'projects',
      tableColumns: ['name'],
    };
    const form = new FormData();
    form.set('experienceId', 'other-experience');
    form.set('id', 'project-1');
    form.set('name', 'Updated project');
    mocks.getAdminRecord.mockResolvedValue({
      experienceId: 'experience-1',
      id: 'project-1',
    });
    mocks.requireAdminResource.mockReturnValue(projectResource);
    mocks.updateAdminRecord.mockResolvedValue({ id: 'project-1' });

    const { updateExperienceProjectAction } = await import(
      './admin-resource-route'
    );
    await updateExperienceProjectAction(
      'experience-1',
      new Request('http://localhost/admin/experience/experience-1/edit', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    const [, submittedForm, user] = mocks.updateAdminRecord.mock.calls[0];
    expect(submittedForm.get('experienceId')).toBe('experience-1');
    expect(submittedForm.get('id')).toBe('project-1');
    expect(submittedForm.get('name')).toBe('Updated project');
    expect(user).toEqual({ id: 'user-1' });
  });

  it('creates a project bullet against a project on the current experience item', async () => {
    const projectResource = {
      className: 'Project',
      description: '',
      fields: [],
      icon: 'layers',
      label: 'Projects',
      orderBy: 'sortOrder ASC',
      singularLabel: 'project',
      slug: 'projects',
      tableColumns: ['name'],
    };
    const achievementResource = {
      className: 'Achievement',
      description: '',
      fields: [
        { key: 'experienceId', kind: 'combo', label: 'Experience' },
        { key: 'projectId', kind: 'combo', label: 'Project' },
        { key: 'title', kind: 'text', label: 'Title' },
        { key: 'body', kind: 'textarea', label: 'Body' },
      ],
      icon: 'file-text',
      label: 'Achievements',
      orderBy: 'sortOrder ASC',
      singularLabel: 'achievement',
      slug: 'achievements',
      tableColumns: ['title'],
    };
    const form = new FormData();
    form.set('experienceId', 'other-experience');
    form.set('projectId', 'project-1');
    form.set('title', 'Project bullet');
    form.set('body', 'Created without a title.');
    mocks.getAdminRecord.mockResolvedValue({
      experienceId: 'experience-1',
      id: 'project-1',
    });
    mocks.createAdminRecord.mockResolvedValue({ id: 'achievement-1' });
    mocks.requireAdminResource.mockImplementation((slug: string) =>
      slug === 'projects' ? projectResource : achievementResource,
    );

    const { createExperienceProjectBulletAction } = await import(
      './admin-resource-route'
    );
    await createExperienceProjectBulletAction(
      'experience-1',
      new Request('http://localhost/admin/experience/experience-1/edit', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    const [, submittedForm, user] = mocks.createAdminRecord.mock.calls[0];
    expect(submittedForm.get('experienceId')).toBe('experience-1');
    expect(submittedForm.get('projectId')).toBe('project-1');
    expect(submittedForm.get('title')).toBe('');
    expect(submittedForm.get('body')).toBe('Created without a title.');
    expect(user).toEqual({ id: 'user-1' });
  });

  it('updates a project bullet only when its project belongs to the current experience item', async () => {
    const projectResource = {
      className: 'Project',
      description: '',
      fields: [],
      icon: 'layers',
      label: 'Projects',
      orderBy: 'sortOrder ASC',
      singularLabel: 'project',
      slug: 'projects',
      tableColumns: ['name'],
    };
    const achievementResource = {
      className: 'Achievement',
      description: '',
      fields: [
        { key: 'experienceId', kind: 'combo', label: 'Experience' },
        { key: 'projectId', kind: 'combo', label: 'Project' },
        { key: 'title', kind: 'text', label: 'Title' },
        { key: 'body', kind: 'textarea', label: 'Body' },
      ],
      icon: 'file-text',
      label: 'Achievements',
      orderBy: 'sortOrder ASC',
      singularLabel: 'achievement',
      slug: 'achievements',
      tableColumns: ['title'],
    };
    const form = new FormData();
    form.set('experienceId', 'other-experience');
    form.set('id', 'achievement-1');
    form.set('projectId', 'other-project');
    form.set('title', 'Updated bullet');
    form.set('body', 'Updated without a title.');
    mocks.getAdminRecord
      .mockResolvedValueOnce({
        experienceId: 'experience-1',
        id: 'achievement-1',
        projectId: 'project-1',
      })
      .mockResolvedValueOnce({
        experienceId: 'experience-1',
        id: 'project-1',
      });
    mocks.updateAdminRecord.mockResolvedValue({ id: 'achievement-1' });
    mocks.requireAdminResource.mockImplementation((slug: string) =>
      slug === 'projects' ? projectResource : achievementResource,
    );

    const { updateExperienceProjectBulletAction } = await import(
      './admin-resource-route'
    );
    await updateExperienceProjectBulletAction(
      'experience-1',
      new Request('http://localhost/admin/experience/experience-1/edit', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    const [, submittedForm, user] = mocks.updateAdminRecord.mock.calls[0];
    expect(submittedForm.get('experienceId')).toBe('experience-1');
    expect(submittedForm.get('id')).toBe('achievement-1');
    expect(submittedForm.get('projectId')).toBe('project-1');
    expect(submittedForm.get('title')).toBe('');
    expect(submittedForm.get('body')).toBe('Updated without a title.');
    expect(user).toEqual({ id: 'user-1' });
  });

  it.each([
    {
      action: 'reviewOpportunityAction',
      auditAction: 'admin.reviewOpportunity',
      fields: { humanReviewStatus: 'maybe', opportunityId: 'opp-1' },
      handler: 'updateOpportunityReview',
    },
    {
      action: 'bulkReviewOpportunitiesAction',
      auditAction: 'admin.bulkReviewOpportunities',
      fields: { humanReviewStatus: 'maybe', opportunityId: 'opp-1' },
      handler: 'bulkUpdateOpportunityReviews',
    },
  ] as const)('$action asserts the opportunity read its workflow performs', async ({
    action,
    fields,
    handler,
    auditAction,
  }) => {
    const route = await import('./admin-resource-route');
    mocks[handler].mockResolvedValue({ id: 'job-1' } as never);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    for (const denied of ['opportunities.read', 'opportunities.update']) {
      await expect(
        route[action](
          postForm('/admin/opportunities', fields),
          ownerLocals(without(denied)),
        ),
        denied,
      ).rejects.toMatchObject({
        body: { message: 'Forbidden' },
        status: 403,
      });
    }
    expect(mocks[handler]).not.toHaveBeenCalled();

    await route[action](
      postForm('/admin/opportunities', fields),
      ownerLocals(),
    );

    expect(mocks[handler]).toHaveBeenCalledTimes(1);
    expect(auditEntries(info)).toContainEqual(
      expect.objectContaining({
        action: auditAction,
        actorUserId: 'user-1',
      }),
    );
    info.mockRestore();
  });

  it('returns a bounded row error for an inactive source crawl refusal', async () => {
    mocks.requireAdminResource.mockReturnValue({ className: 'Source' });
    mocks.enqueueSourceCrawl.mockRejectedValue(
      new Error(
        `Source is not explicitly active. ${'Enable it first. '.repeat(40)}`,
      ),
    );
    const form = new FormData();
    form.set('sourceId', 'source-1');
    const { crawlSourceNowAction } = await import('./admin-resource-route');
    const result = await crawlSourceNowAction(
      'sources',
      new Request('http://localhost/admin/sources', {
        body: form,
        method: 'POST',
      }),
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('not explicitly active');
    expect(result.message).toHaveLength(300);
  });
});

/**
 * The triage deck is a modal over the opportunity list, so it has no page load
 * of its own: it posts the list's filter parameters to this action and gets one
 * window of the queue back.
 */
describe('triageQueueAction', () => {
  beforeEach(() => {
    mocks.loadTriageQueue.mockClear();
    mocks.latestPostingPreflightStatus.mockClear();
  });

  /** The one queue request the action under test made. */
  function queueRequest() {
    const [call] = mocks.loadTriageQueue.mock.calls as unknown as [
      unknown[] | undefined,
    ];
    if (!call) throw new Error('Expected loadTriageQueue to be called');
    return call[0] as {
      filters: Record<string, unknown>;
      limit: number;
      offset: number;
      search?: string;
    };
  }

  it('reads one window under the triage preset and its recorded posting checks', async () => {
    const { triageQueueAction } = await import('./admin-resource-route');

    const result = await triageQueueAction(
      postForm('/admin/opportunities', {
        limit: '3',
        offset: '0',
        search: '',
      }),
    );

    const request = queueRequest();
    expect(request.limit).toBe(3);
    expect(request.offset).toBe(0);
    expect(request.filters.status).toBe('all');
    expect(request.filters.sort).toBe('score');
    expect(request.filters.excludeExpired).toBe(true);
    expect(request.filters.excludeStale).toBe(true);
    expect(result.total).toBe(3);
    expect(result.candidates).toHaveLength(1);
    // The verdict lives in the audit trail, not on the opportunity row, so the
    // card can only show it if the action reads it for the window in hand.
    expect(mocks.latestPostingPreflightStatus).toHaveBeenCalledWith('opp-1');
    expect(result.preflights['opp-1']).toMatchObject({ state: 'live' });
  });

  it('carries the list filters and the skip offset across', async () => {
    const { triageQueueAction } = await import('./admin-resource-route');

    await triageQueueAction(
      postForm('/admin/opportunities', {
        offset: '4',
        search: 'skill=Rust&workMode=remote&q=platform',
      }),
    );

    const request = queueRequest();
    expect(request.offset).toBe(4);
    expect(request.search).toBe('platform');
    expect(request.filters.skills).toEqual(['Rust']);
    expect(request.filters.workModes).toEqual(['remote']);
  });

  it('ignores a non-numeric offset and caps an oversized window', async () => {
    const { triageQueueAction } = await import('./admin-resource-route');

    await triageQueueAction(
      postForm('/admin/opportunities', {
        limit: '500',
        offset: 'nope',
        search: '',
      }),
    );

    const request = queueRequest();
    expect(request.offset).toBe(0);
    // Clamped to the server's own window (#452): three cards, not five.
    expect(request.limit).toBe(3);
  });
});
