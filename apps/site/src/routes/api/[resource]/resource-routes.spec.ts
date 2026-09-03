import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as collectionGet, POST as collectionPost } from './+server';
import { DELETE as itemDelete, PUT as itemPut } from './[id]/+server';

const routeMocks = vi.hoisted(() => {
  type MockRecord = Record<string, unknown> & {
    delete: ReturnType<typeof vi.fn>;
    id: string;
    save: ReturnType<typeof vi.fn>;
  };

  function collection(initialRecords: Record<string, unknown>[] = []) {
    const records: MockRecord[] = [];

    function makeRecord(payload: Record<string, unknown>): MockRecord {
      const record = {
        ...payload,
        delete: vi.fn(async () => {
          const index = records.findIndex((item) => item.id === record.id);
          if (index >= 0) records.splice(index, 1);
          return true;
        }),
        id: String(payload.id ?? records.length + 1),
        save: vi.fn(async () => {}),
      } as MockRecord;
      return record;
    }

    for (const record of initialRecords) {
      records.push(makeRecord(record));
    }

    return {
      count: vi.fn(async () => records.length),
      create: vi.fn(async (payload: Record<string, unknown>) => {
        const record = makeRecord({
          id: String(payload.id ?? records.length + 1),
          ...payload,
        });
        records.push(record);
        return record;
      }),
      get: vi.fn(
        async (id: string) =>
          records.find((record) => record.id === id) ?? null,
      ),
      list: vi.fn(async () => records),
      records,
    };
  }

  return {
    collection,
    collections: new Map<string, ReturnType<typeof collection>>(),
    deleteSourceSchedule: vi.fn(async () => undefined),
    normalizeAccountStatus: vi.fn((value: unknown) => {
      const status = typeof value === 'string' ? value.trim() : '';
      if (status === 'needs_magic') {
        const error = new Error('Invalid account status.') as Error & {
          body?: { message: string };
          status?: number;
        };
        error.body = { message: 'Invalid account status.' };
        error.status = 400;
        throw error;
      }
      return status || 'unknown';
    }),
    resumeVariantDeleteViolation: vi.fn(async () => ''),
    releaseResumeVariantApplicationWrite: vi.fn(async () => ({
      applicationLocksReleased: true,
      workflowTasksSynced: true,
    })),
    reserveResumeVariantApplicationWrite: vi.fn(async () => ({
      reservation: null,
      violation: '',
    })),
    resumeVariantWriteViolation: vi.fn(async () => ''),
    syncApplicationWorkflowTasks: vi.fn(async () => ({ created: 0 })),
    syncRecommendedOpportunityDecisionTasks: vi.fn(async () => ({
      closed: 0,
      created: 0,
      existing: 0,
      scanned: 0,
    })),
    syncResumeVariantApplicationApprovals: vi.fn(async () => ({
      invalidated: 0,
      selected: 0,
    })),
    syncSourceAccountTasks: vi.fn(async () => ({ created: 0, existing: 0 })),
    syncSourceSchedule: vi.fn(async () => null),
    validateSubmittedApplicationPayload: vi.fn(() => null as string | null),
  };
});

const applicationConcurrencyMocks = vi.hoisted(() => ({
  applicationUpdatesFromPayload: vi.fn(
    (payload: Record<string, unknown>) => payload,
  ),
  commitApplicationIfCurrent: vi.fn(
    async (
      application: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => {
      Object.assign(application, updates);
      return true;
    },
  ),
}));

vi.mock('$lib/server/application-concurrency', () => ({
  applicationUpdatesFromPayload:
    applicationConcurrencyMocks.applicationUpdatesFromPayload,
  commitApplicationIfCurrent:
    applicationConcurrencyMocks.commitApplicationIfCurrent,
}));

vi.mock('$lib/server/smrt', () => ({
  getCollection: vi.fn(async (className: string) => {
    const collection = routeMocks.collections.get(className);
    if (!collection)
      throw new Error(`Missing mock collection for ${className}`);
    return collection;
  }),
}));

vi.mock('$lib/server/application-workflow', () => ({
  normalizeAccountStatus: routeMocks.normalizeAccountStatus,
  syncApplicationWorkflowTasks: routeMocks.syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks:
    routeMocks.syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks: routeMocks.syncSourceAccountTasks,
  validateSubmittedApplicationPayload:
    routeMocks.validateSubmittedApplicationPayload,
}));

vi.mock('$lib/server/source-schedules', () => ({
  deleteSourceSchedule: routeMocks.deleteSourceSchedule,
  syncSourceSchedule: routeMocks.syncSourceSchedule,
}));

vi.mock('$lib/server/resume-variant-workflow', () => ({
  releaseResumeVariantApplicationWrite:
    routeMocks.releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite:
    routeMocks.reserveResumeVariantApplicationWrite,
  resumeVariantDeleteViolation: routeMocks.resumeVariantDeleteViolation,
  resumeVariantWriteViolation: routeMocks.resumeVariantWriteViolation,
  syncResumeVariantApplicationApprovals:
    routeMocks.syncResumeVariantApplicationApprovals,
}));

function jsonRequest(payload: unknown): Request {
  return new Request('https://iolaus.localhost/api/sources', {
    body: JSON.stringify(payload),
    method: 'POST',
  });
}

function rawRequest(body: string): Request {
  return new Request('https://iolaus.localhost/api/sources', {
    body,
    method: 'POST',
  });
}

describe('generic resource API routes', () => {
  beforeEach(() => {
    routeMocks.collections.clear();
    routeMocks.deleteSourceSchedule.mockClear();
    routeMocks.normalizeAccountStatus.mockClear();
    routeMocks.resumeVariantDeleteViolation.mockReset();
    routeMocks.resumeVariantDeleteViolation.mockResolvedValue('');
    routeMocks.resumeVariantWriteViolation.mockReset();
    routeMocks.resumeVariantWriteViolation.mockResolvedValue('');
    routeMocks.releaseResumeVariantApplicationWrite.mockClear();
    routeMocks.reserveResumeVariantApplicationWrite.mockReset();
    routeMocks.reserveResumeVariantApplicationWrite.mockResolvedValue({
      reservation: null,
      violation: '',
    });
    routeMocks.syncApplicationWorkflowTasks.mockClear();
    routeMocks.syncRecommendedOpportunityDecisionTasks.mockClear();
    routeMocks.syncResumeVariantApplicationApprovals.mockReset();
    routeMocks.syncResumeVariantApplicationApprovals.mockResolvedValue({
      invalidated: 0,
      selected: 0,
    });
    routeMocks.syncSourceAccountTasks.mockClear();
    routeMocks.syncSourceSchedule.mockClear();
    routeMocks.validateSubmittedApplicationPayload.mockClear();
    applicationConcurrencyMocks.applicationUpdatesFromPayload.mockClear();
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockReset();
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockImplementation(
      async (application, updates) => {
        Object.assign(application, updates);
        return true;
      },
    );
  });

  it('returns a SMRT web-compatible data alias on REST collection lists', async () => {
    const tasks = routeMocks.collection([
      { id: 'task-1', title: 'Review application' },
      { id: 'task-2', title: 'Research company' },
    ]);
    routeMocks.collections.set('Task', tasks);

    const response = await collectionGet({
      params: { resource: 'tasks' },
      url: new URL('https://iolaus.localhost/api/tasks?limit=25&offset=5'),
    } as never);
    const payload = (await response.json()) as {
      count: number;
      data: Array<{ id: string; title: string }>;
      items: Array<{ id: string; title: string }>;
      limit: number;
      offset: number;
    };

    expect(payload).toMatchObject({
      count: 2,
      limit: 25,
      offset: 5,
    });
    expect(payload.data).toEqual(payload.items);
    expect(payload.data.map((record) => record.id)).toEqual([
      'task-1',
      'task-2',
    ]);
  });

  it.each([
    'resumeprofiles',
    'resume_profiles',
  ])('serves decorator-exposed resume content under the %s slug', async (resource) => {
    const profiles = routeMocks.collection([
      { id: 'profile-1', profileKey: 'default' },
    ]);
    routeMocks.collections.set('ResumeProfile', profiles);

    const listResponse = await collectionGet({
      params: { resource },
      url: new URL(`https://iolaus.localhost/api/${resource}`),
    } as never);
    expect((await listResponse.json()).count).toBe(1);

    const createResponse = await collectionPost({
      params: { resource },
      request: jsonRequest({ profileKey: 'alt' }),
    } as never);
    expect(createResponse.status).toBe(201);
    expect(profiles.create).toHaveBeenCalledWith({ profileKey: 'alt' });

    const putResponse = await itemPut({
      params: { id: 'profile-1', resource },
      request: jsonRequest({ headline: 'Updated' }),
    } as never);
    expect(putResponse.status).toBe(200);
    expect(profiles.records[0].save).toHaveBeenCalled();

    const deleteResponse = await itemDelete({
      params: { id: 'profile-1', resource },
    } as never);
    expect(await deleteResponse.json()).toEqual({ success: true });
  });

  it('rejects actions the decorator api include leaves out', async () => {
    const controls = routeMocks.collection([{ id: 'control-1' }]);
    routeMocks.collections.set('OpportunityIntelligenceControl', controls);
    const applications = routeMocks.collection([{ id: 'app-1' }]);
    routeMocks.collections.set('Application', applications);

    await expect(
      collectionPost({
        params: { resource: 'opportunityintelligencecontrols' },
        request: jsonRequest({ enabled: true }),
      } as never),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      itemDelete({
        params: { id: 'app-1', resource: 'applications' },
      } as never),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      collectionGet({
        params: { resource: 'candidateanswers' },
        url: new URL('https://iolaus.localhost/api/candidateanswers'),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(controls.create).not.toHaveBeenCalled();
    expect(applications.records[0].delete).not.toHaveBeenCalled();
  });

  it('syncs source schedules and account tasks after REST source creation', async () => {
    const sources = routeMocks.collection();
    routeMocks.collections.set('Source', sources);

    const response = await collectionPost({
      params: { resource: 'sources' },
      request: jsonRequest({
        accountStatus: 'needs_2fa',
        isActive: true,
        name: 'Greenhouse',
        refreshCadence: 'daily',
      }),
    } as never);

    expect(response.status).toBe(201);
    expect(routeMocks.syncSourceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_2fa',
        name: 'Greenhouse',
        refreshCadence: 'daily',
      }),
    );
    expect(routeMocks.syncSourceAccountTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_2fa',
        name: 'Greenhouse',
      }),
    );
  });

  it('syncs source schedules and account tasks after REST source updates', async () => {
    const sources = routeMocks.collection([
      {
        accountStatus: 'unknown',
        id: 'source-1',
        name: 'Greenhouse',
        refreshCadence: 'weekly',
      },
    ]);
    routeMocks.collections.set('Source', sources);

    const response = await itemPut({
      params: { id: 'source-1', resource: 'sources' },
      request: jsonRequest({
        accountStatus: 'needs_login',
        refreshCadence: 'monthly',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(routeMocks.syncSourceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_login',
        id: 'source-1',
        refreshCadence: 'monthly',
      }),
    );
    expect(routeMocks.syncSourceAccountTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_login',
        id: 'source-1',
      }),
    );
  });

  it('records authenticated approval on REST application creation', async () => {
    const applications = routeMocks.collection();
    routeMocks.collections.set('Application', applications);

    const response = await collectionPost({
      locals: { user: { id: 'user-1' } },
      params: { resource: 'applications' },
      request: jsonRequest({
        approvedByUserId: 'user-1',
        status: 'approved',
      }),
    } as never);

    expect(response.status).toBe(201);
    expect(applications.records[0]).toMatchObject({
      approvedAt: expect.any(Date),
      approvedByUserId: 'user-1',
      status: 'approved',
    });
    expect(routeMocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedByUserId: 'user-1',
        status: 'approved',
      }),
    );
  });

  it('rejects system-managed application material locks on REST creation', async () => {
    const applications = routeMocks.collection();
    routeMocks.collections.set('Application', applications);

    await expect(
      collectionPost({
        params: { resource: 'applications' },
        request: jsonRequest({ materialWriteLock: 'not-authorized' }),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Application material-write locks are system-managed.' },
      status: 403,
    });

    expect(applications.records).toHaveLength(0);
  });

  it('normalizes REST agent list payloads before creating records', async () => {
    const opportunities = routeMocks.collection();
    routeMocks.collections.set('Opportunity', opportunities);

    const response = await collectionPost({
      params: { resource: 'opportunities' },
      request: jsonRequest({
        domainTags: ['developer tooling', 'platform'],
        requiredSkills: 'TypeScript\n\nSvelte',
        title: 'Platform Engineer',
      }),
    } as never);

    expect(response.status).toBe(201);
    expect(opportunities.records[0]).toMatchObject({
      domainTags: 'developer tooling\nplatform',
      requiredSkills: 'TypeScript\nSvelte',
    });
    expect(
      routeMocks.syncRecommendedOpportunityDecisionTasks,
    ).toHaveBeenCalled();
  });

  it('syncs recommendation review tasks after REST opportunity updates', async () => {
    const opportunities = routeMocks.collection([
      { id: 'opp-1', status: 'found', title: 'Platform Engineer' },
    ]);
    routeMocks.collections.set('Opportunity', opportunities);

    const response = await itemPut({
      params: { id: 'opp-1', resource: 'opportunities' },
      request: jsonRequest({ status: 'recommended' }),
    } as never);

    expect(response.status).toBe(200);
    expect(
      routeMocks.syncRecommendedOpportunityDecisionTasks,
    ).toHaveBeenCalled();
  });

  it('syncs selected application approvals after REST resume variant writes', async () => {
    const variants = routeMocks.collection([
      { id: 'variant-1', name: 'Old variant' },
    ]);
    routeMocks.collections.set('ResumeVariant', variants);

    const createResponse = await collectionPost({
      params: { resource: 'resumevariants' },
      request: jsonRequest({ name: 'New variant' }),
    } as never);

    expect(createResponse.status).toBe(201);
    expect(
      routeMocks.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('2');

    const updateResponse = await itemPut({
      params: { id: 'variant-1', resource: 'resumevariants' },
      request: jsonRequest({ name: 'Renamed variant' }),
    } as never);

    expect(updateResponse.status).toBe(200);
    expect(
      routeMocks.reserveResumeVariantApplicationWrite,
    ).toHaveBeenCalledWith('variant-1');
    expect(
      routeMocks.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('variant-1');
  });

  it('rejects unsafe REST resume variant updates before saving', async () => {
    const variants = routeMocks.collection([
      { id: 'variant-1', name: 'Approved variant' },
    ]);
    routeMocks.collections.set('ResumeVariant', variants);
    routeMocks.reserveResumeVariantApplicationWrite.mockResolvedValueOnce({
      reservation: null,
      violation:
        'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
    });

    await expect(
      itemPut({
        params: { id: 'variant-1', resource: 'resumevariants' },
        request: jsonRequest({ name: 'Changed variant' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
      },
      status: 409,
    });

    expect(variants.records[0]).toMatchObject({ name: 'Approved variant' });
    expect(variants.records[0].save).not.toHaveBeenCalled();
    expect(
      routeMocks.syncResumeVariantApplicationApprovals,
    ).not.toHaveBeenCalled();
  });

  it('rejects deleting selected REST resume variants', async () => {
    const variants = routeMocks.collection([
      { id: 'variant-1', name: 'Selected variant' },
    ]);
    routeMocks.collections.set('ResumeVariant', variants);
    routeMocks.resumeVariantDeleteViolation.mockResolvedValueOnce(
      'Resume variant is selected by an application and cannot be deleted.',
    );

    await expect(
      itemDelete({
        params: { id: 'variant-1', resource: 'resumevariants' },
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Resume variant is selected by an application and cannot be deleted.',
      },
      status: 400,
    });

    expect(variants.records[0].delete).not.toHaveBeenCalled();
    expect(variants.records).toHaveLength(1);
  });

  it('rejects invalid REST JSON-string fields before creating records', async () => {
    const preferences = routeMocks.collection();
    routeMocks.collections.set('PreferenceRule', preferences);

    await expect(
      collectionPost({
        params: { resource: 'preferencerules' },
        request: jsonRequest({
          name: 'Comp floor',
          ruleJson: '{bad json',
        }),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'JSON fields must contain valid JSON.' },
      status: 400,
    });

    expect(preferences.records).toHaveLength(0);
  });

  it('rejects invalid REST list field values before creating records', async () => {
    const opportunities = routeMocks.collection();
    routeMocks.collections.set('Opportunity', opportunities);

    await expect(
      collectionPost({
        params: { resource: 'opportunities' },
        request: jsonRequest({
          requiredSkills: [{ label: 'TypeScript' }],
          title: 'Platform Engineer',
        }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message: 'List fields must contain string, number, or boolean values.',
      },
      status: 400,
    });

    expect(opportunities.records).toHaveLength(0);
    expect(
      routeMocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();
  });

  it('rejects REST application approval for a different authenticated user', async () => {
    const applications = routeMocks.collection();
    routeMocks.collections.set('Application', applications);

    await expect(
      collectionPost({
        locals: { user: { id: 'user-1' } },
        params: { resource: 'applications' },
        request: jsonRequest({
          approvedByUserId: 'user-2',
          status: 'approved',
        }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application approval requires approvedByUserId matching the authenticated user.',
      },
      status: 400,
    });

    expect(applications.records).toHaveLength(0);
    expect(routeMocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('rejects forged final approval fields on the API surface used by the CLI', async () => {
    const applications = routeMocks.collection([
      { id: 'app-1', status: 'awaiting_user' },
    ]);
    routeMocks.collections.set('Application', applications);

    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'app-1', resource: 'applications' },
        request: jsonRequest({
          finalApprovalAt: '2026-08-26T12:00:00.000Z',
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          finalApprovalMaterialsJson: '[]',
        }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Final submission approval must be recorded from the application review page.',
      },
      status: 400,
    });

    expect(applications.records[0]).toMatchObject({ status: 'awaiting_user' });
    expect(applications.records[0].save).not.toHaveBeenCalled();
  });

  it('requires the application-review action to record a REST submission', async () => {
    const applications = routeMocks.collection([
      {
        approvedAt: '2026-08-26T12:00:00.000Z',
        approvedByUserId: 'user-1',
        finalApprovalAt: '2026-08-26T12:00:00.000Z',
        finalApprovalKind: 'final_submission',
        finalApprovedByUserId: 'user-1',
        id: 'app-1',
        status: 'approved',
      },
    ]);
    routeMocks.collections.set('Application', applications);

    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'app-1', resource: 'applications' },
        request: jsonRequest({ status: 'submitted' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application submission must be recorded from the application review page.',
      },
      status: 400,
    });

    expect(applications.records[0]).toMatchObject({ status: 'approved' });
    expect(applications.records[0].save).not.toHaveBeenCalled();
  });

  it('exposes AgentRun audit records as read-only on generic REST surfaces', async () => {
    const agentRuns = routeMocks.collection([
      { id: 'run-1', status: 'succeeded' },
    ]);
    routeMocks.collections.set('AgentRun', agentRuns);

    await expect(
      collectionPost({
        params: { resource: 'agentruns' },
        request: jsonRequest({ runType: 'application_final_approval' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });
    await expect(
      itemPut({
        params: { id: 'run-1', resource: 'agentruns' },
        request: jsonRequest({ status: 'failed' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });
    await expect(
      itemDelete({
        params: { id: 'run-1', resource: 'agentruns' },
      } as never),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });

    expect(agentRuns.create).not.toHaveBeenCalled();
    expect(agentRuns.records[0].save).not.toHaveBeenCalled();
    expect(agentRuns.records[0].delete).not.toHaveBeenCalled();
  });

  it.each([
    ['SourceCrawl', 'sourcecrawls'],
    ['SourceCrawlItem', 'sourcecrawlitems'],
  ])('exposes %s accounting records as read-only on REST surfaces', async (className, resource) => {
    const records = routeMocks.collection([{ id: 'accounting-1' }]);
    routeMocks.collections.set(className, records);
    const rejection = {
      body: {
        message:
          'Source crawl accounting records are system-authored and immutable.',
      },
      status: 403,
    };

    await expect(
      collectionPost({
        params: { resource },
        request: jsonRequest({ status: 'tampered' }),
      } as never),
    ).rejects.toMatchObject(rejection);
    await expect(
      itemPut({
        params: { id: 'accounting-1', resource },
        request: jsonRequest({ outcome: 'pending' }),
      } as never),
    ).rejects.toMatchObject(rejection);
    await expect(
      itemDelete({ params: { id: 'accounting-1', resource } } as never),
    ).rejects.toMatchObject(rejection);
    expect(records.create).not.toHaveBeenCalled();
    expect(records.records[0].save).not.toHaveBeenCalled();
    expect(records.records[0].delete).not.toHaveBeenCalled();
  });

  it('rejects REST mutations of application-owned materials', async () => {
    const assets = routeMocks.collection([
      { applicationId: 'app-1', id: 'asset-1', title: 'Reviewed resume' },
    ]);
    routeMocks.collections.set('ResumeAsset', assets);

    await expect(
      itemPut({
        params: { id: 'asset-1', resource: 'resumeassets' },
        request: jsonRequest({ title: 'Changed after review' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application-owned materials are immutable through generic resource APIs. Regenerate or revise them through the application workflow.',
      },
      status: 403,
    });
    await expect(
      itemDelete({
        params: { id: 'asset-1', resource: 'resumeassets' },
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    expect(assets.records[0].save).not.toHaveBeenCalled();
    expect(assets.records[0].delete).not.toHaveBeenCalled();
  });

  it('rejects REST creation or ownership transfer of application materials', async () => {
    const assets = routeMocks.collection([
      { applicationId: '', id: 'asset-1', title: 'Global resume' },
    ]);
    routeMocks.collections.set('ResumeAsset', assets);

    await expect(
      collectionPost({
        params: { resource: 'resumeassets' },
        request: jsonRequest({
          applicationId: 'app-1',
          title: 'Bypass material',
        }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      itemPut({
        params: { id: 'asset-1', resource: 'resumeassets' },
        request: jsonRequest({
          applicationId: 'app-1',
          title: 'Transferred material',
        }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(assets.create).not.toHaveBeenCalled();
    expect(assets.records[0].save).not.toHaveBeenCalled();
  });

  it('records authenticated approval on REST application updates', async () => {
    const applications = routeMocks.collection([
      {
        approvedAt: null,
        approvedByUserId: '',
        id: 'app-1',
        status: 'awaiting_user',
      },
    ]);
    routeMocks.collections.set('Application', applications);

    const response = await itemPut({
      locals: { user: { id: 'user-1' } },
      params: { id: 'app-1', resource: 'applications' },
      request: jsonRequest({
        approvedByUserId: 'user-1',
        status: 'approved',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(applications.records[0]).toMatchObject({
      approvedAt: expect.any(Date),
      approvedByUserId: 'user-1',
      status: 'approved',
    });
    expect(routeMocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedByUserId: 'user-1',
        id: 'app-1',
        status: 'approved',
      }),
    );
  });

  it('preserves recorded application approval when REST updates send a blank approval id', async () => {
    const applications = routeMocks.collection([
      {
        approvedByUserId: 'user-1',
        id: 'app-1',
        status: 'approved',
      },
    ]);
    routeMocks.collections.set('Application', applications);

    const response = await itemPut({
      locals: { user: { id: 'user-2' } },
      params: { id: 'app-1', resource: 'applications' },
      request: jsonRequest({ approvedByUserId: '' }),
    } as never);

    expect(response.status).toBe(200);
    expect(applications.records[0]).toMatchObject({
      approvedByUserId: 'user-1',
    });
    expect(routeMocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedByUserId: 'user-1',
        id: 'app-1',
        status: 'approved',
      }),
    );
  });

  it('invalidates approval when REST updates change approved application materials', async () => {
    const applications = routeMocks.collection([
      {
        approvedAt: '2026-06-04T10:00:00.000Z',
        approvedByProfileId: 'profile-1',
        approvedByUserId: 'user-1',
        id: 'app-1',
        resumeAssetId: 'resume-old',
        status: 'approved',
      },
    ]);
    routeMocks.collections.set('Application', applications);

    const response = await itemPut({
      params: { id: 'app-1', resource: 'applications' },
      request: jsonRequest({ resumeAssetId: 'resume-new' }),
    } as never);

    expect(response.status).toBe(200);
    expect(applications.records[0]).toMatchObject({
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      resumeAssetId: 'resume-new',
      status: 'awaiting_user',
    });
    expect(routeMocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'app-1',
        resumeAssetId: 'resume-new',
        status: 'awaiting_user',
      }),
    );
  });

  it('does not let a stale REST application update restore final approval', async () => {
    const applications = routeMocks.collection([
      {
        finalApprovalAt: '2026-06-04T10:00:00.000Z',
        finalApprovalKind: 'final_submission',
        finalApprovedByUserId: 'user-1',
        id: 'app-1',
        notes: 'Current review state',
        status: 'approved',
      },
    ]);
    routeMocks.collections.set('Application', applications);
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockResolvedValueOnce(
      false,
    );

    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'app-1', resource: 'applications' },
        request: jsonRequest({ notes: 'Stale edit' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed before this update could be saved. Reload and review the current application.',
      },
      status: 409,
    });

    expect(applications.records[0]).toMatchObject({
      finalApprovalKind: 'final_submission',
      notes: 'Current review state',
      status: 'approved',
    });
    expect(routeMocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('rejects REST material changes after application materials are locked', async () => {
    const applications = routeMocks.collection([
      {
        id: 'app-1',
        packetAssetId: 'packet-old',
        status: 'submitted',
      },
    ]);
    routeMocks.collections.set('Application', applications);

    await expect(
      itemPut({
        params: { id: 'app-1', resource: 'applications' },
        request: jsonRequest({ packetAssetId: 'packet-new' }),
      } as never),
    ).rejects.toMatchObject({
      body: {
        message:
          'Submitted or closed applications cannot have their approved materials changed.',
      },
      status: 400,
    });

    expect(applications.records[0]).toMatchObject({
      packetAssetId: 'packet-old',
      status: 'submitted',
    });
    expect(applications.records[0].save).not.toHaveBeenCalled();
    expect(routeMocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('rejects invalid REST source account status before saving the record', async () => {
    const sources = routeMocks.collection();
    routeMocks.collections.set('Source', sources);

    await expect(
      collectionPost({
        params: { resource: 'sources' },
        request: jsonRequest({
          accountStatus: 'needs_magic',
          name: 'Greenhouse',
        }),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Invalid account status.' },
      status: 400,
    });

    expect(sources.records).toHaveLength(0);
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('rejects non-object REST source payloads before creating records', async () => {
    const sources = routeMocks.collection();
    routeMocks.collections.set('Source', sources);

    await expect(
      collectionPost({
        params: { resource: 'sources' },
        request: jsonRequest(null),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Request body must be a JSON object.' },
      status: 400,
    });

    expect(sources.records).toHaveLength(0);
    expect(routeMocks.normalizeAccountStatus).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before creating REST records', async () => {
    const sources = routeMocks.collection();
    routeMocks.collections.set('Source', sources);

    await expect(
      collectionPost({
        params: { resource: 'sources' },
        request: rawRequest('{"name":'),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Request body must be valid JSON.' },
      status: 400,
    });

    expect(sources.records).toHaveLength(0);
    expect(routeMocks.normalizeAccountStatus).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('rejects non-object REST source payloads before updating records', async () => {
    const sources = routeMocks.collection([
      {
        accountStatus: 'unknown',
        id: 'source-1',
        name: 'Greenhouse',
      },
    ]);
    routeMocks.collections.set('Source', sources);

    await expect(
      itemPut({
        params: { id: 'source-1', resource: 'sources' },
        request: jsonRequest([]),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Request body must be a JSON object.' },
      status: 400,
    });

    expect(sources.records[0]).toMatchObject({
      accountStatus: 'unknown',
      name: 'Greenhouse',
    });
    expect(sources.records[0].save).not.toHaveBeenCalled();
    expect(routeMocks.normalizeAccountStatus).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before loading REST update records', async () => {
    const sources = routeMocks.collection([
      {
        accountStatus: 'unknown',
        id: 'source-1',
        name: 'Greenhouse',
      },
    ]);
    routeMocks.collections.set('Source', sources);

    await expect(
      itemPut({
        params: { id: 'source-1', resource: 'sources' },
        request: rawRequest('{"name":'),
      } as never),
    ).rejects.toMatchObject({
      body: { message: 'Request body must be valid JSON.' },
      status: 400,
    });

    expect(sources.get).not.toHaveBeenCalled();
    expect(sources.records[0].save).not.toHaveBeenCalled();
    expect(routeMocks.normalizeAccountStatus).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('deletes source schedules after REST source deletion', async () => {
    const sources = routeMocks.collection([
      { id: 'source-1', name: 'Greenhouse' },
    ]);
    routeMocks.collections.set('Source', sources);

    const response = await itemDelete({
      params: { id: 'source-1', resource: 'sources' },
    } as never);

    expect(response.status).toBe(200);
    expect(routeMocks.deleteSourceSchedule).toHaveBeenCalledWith('source-1');
  });
});
