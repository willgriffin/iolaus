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

  const collections = new Map<string, ReturnType<typeof collection>>();

  return {
    collection,
    getCollection: vi.fn(async (className: string) => {
      const matched = collections.get(className);
      if (!matched) throw new Error(`Missing mock collection for ${className}`);
      return matched;
    }),
    collections,
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
  getCollection: routeMocks.getCollection,
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
    routeMocks.getCollection.mockClear();
    routeMocks.normalizeAccountStatus.mockClear();
    routeMocks.syncSourceAccountTasks.mockClear();
    routeMocks.syncSourceSchedule.mockClear();
  });

  it('keeps public catalog collection lists compatible with the SMRT data alias', async () => {
    const sources = routeMocks.collection([
      { id: 'source-1', name: 'Greenhouse' },
      { id: 'source-2', name: 'Lever' },
    ]);
    routeMocks.collections.set('Source', sources);

    const response = await collectionGet({
      params: { resource: 'sources' },
      url: new URL('https://iolaus.localhost/api/sources?limit=25&offset=5'),
    } as never);
    const payload = (await response.json()) as {
      count: number;
      data: Array<{ id: string }>;
      items: Array<{ id: string }>;
      limit: number;
      offset: number;
    };

    expect(payload).toMatchObject({ count: 2, limit: 25, offset: 5 });
    expect(payload.data).toEqual(payload.items);
    expect(payload.data.map((record) => record.id)).toEqual([
      'source-1',
      'source-2',
    ]);
  });

  it('retains canonical and table-name public catalog resource aliases', async () => {
    const research = routeMocks.collection([
      { id: 'research-1', websiteUrl: 'https://example.test' },
    ]);
    routeMocks.collections.set('CompanyResearch', research);

    const response = await collectionGet({
      params: { resource: 'company_research' },
      url: new URL('https://iolaus.localhost/api/company_research'),
    } as never);

    expect(response.status).toBe(200);
    expect(research.list).toHaveBeenCalledOnce();
  });

  it('keeps public source mutations and their catalog lifecycle hooks', async () => {
    const sources = routeMocks.collection([
      {
        accountStatus: 'unknown',
        id: 'source-1',
        name: 'Greenhouse',
        refreshCadence: 'weekly',
      },
    ]);
    routeMocks.collections.set('Source', sources);

    const createResponse = await collectionPost({
      params: { resource: 'sources' },
      request: jsonRequest({
        accountStatus: 'needs_2fa',
        isActive: true,
        name: 'Lever',
        refreshCadence: 'daily',
      }),
    } as never);
    expect(createResponse.status).toBe(201);
    expect(routeMocks.syncSourceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_2fa',
        name: 'Lever',
        refreshCadence: 'daily',
      }),
    );
    expect(routeMocks.syncSourceAccountTasks).toHaveBeenCalledWith(
      expect.objectContaining({ accountStatus: 'needs_2fa', name: 'Lever' }),
    );

    const updateResponse = await itemPut({
      params: { id: 'source-1', resource: 'sources' },
      request: jsonRequest({
        accountStatus: 'needs_login',
        refreshCadence: 'monthly',
      }),
    } as never);
    expect(updateResponse.status).toBe(200);
    expect(sources.records[0]).toMatchObject({
      accountStatus: 'needs_login',
      refreshCadence: 'monthly',
    });

    const deleteResponse = await itemDelete({
      params: { id: 'source-1', resource: 'sources' },
    } as never);
    expect(deleteResponse.status).toBe(200);
    expect(routeMocks.deleteSourceSchedule).toHaveBeenCalledWith('source-1');
  });

  it('rejects unavailable actions for a public catalog record', async () => {
    const controls = routeMocks.collection([{ id: 'control-1' }]);
    routeMocks.collections.set('OpportunityIntelligenceControl', controls);

    await expect(
      collectionPost({
        params: { resource: 'opportunityintelligencecontrols' },
        request: jsonRequest({ enabled: true }),
      } as never),
    ).rejects.toMatchObject({ status: 405 });

    expect(controls.create).not.toHaveBeenCalled();
  });

  it('fails closed every private generic CRUD request before a collection lookup', async () => {
    const attempts: Array<{
      name: string;
      invoke: () => Promise<unknown>;
    }> = [
      {
        name: 'an anonymous legacy résumé profile list',
        invoke: async () =>
          await collectionGet({
            params: { resource: 'resumeprofiles' },
            url: new URL('https://iolaus.localhost/api/resumeprofiles'),
          } as never),
      },
      {
        name: 'an authenticated legacy résumé position creation',
        invoke: async () =>
          await collectionPost({
            locals: { user: { id: 'user-1' } },
            params: { resource: 'resumepositions' },
            request: jsonRequest({ role: 'Engineer' }),
          } as never),
      },
      {
        name: 'a forged legacy résumé profile ownership update',
        invoke: async () =>
          await itemPut({
            locals: { user: { id: 'user-1' } },
            params: { id: 'profile-2', resource: 'resumeprofiles' },
            request: jsonRequest({
              candidateProfileId: 'profile-2',
              ownerUserId: 'user-2',
              tenantId: 'tenant-2',
            }),
          } as never),
      },
      {
        name: 'a legacy résumé skill deletion',
        invoke: async () =>
          await itemDelete({
            locals: { user: { id: 'user-1' } },
            params: { id: 'skill-2', resource: 'resumeskills' },
          } as never),
      },
    ];

    for (const attempt of attempts) {
      await expect(attempt.invoke(), attempt.name).rejects.toMatchObject({
        body: { message: 'Resource not found' },
        status: 404,
      });
    }

    expect(routeMocks.getCollection).not.toHaveBeenCalled();
  });

  it('rejects malformed public catalog payloads before a source write', async () => {
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

    expect(sources.create).not.toHaveBeenCalled();
    expect(routeMocks.syncSourceSchedule).not.toHaveBeenCalled();
  });
});

vi.mock('$lib/server/workspace-subject.js', () => ({
  getCurrentWorkspaceSubject: () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileId: 'profile-1',
  }),
  isCurrentWorkspaceOperator: () => hostedMocks.operator,
}));

const hostedMocks = vi.hoisted(() => ({ operator: true, shared: false }));
vi.mock('$lib/server/app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/app-config')>()),
  isSharedHosted: () => hostedMocks.shared,
}));

const scopedMocks = vi.hoisted(() => ({
  getScopedRecord: vi.fn(),
  listScopedRecords: vi.fn(),
  runScopedWriteSideEffects: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/scoped-resource-crud', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('$lib/server/scoped-resource-crud')
  >()),
  ...scopedMocks,
}));
const ownedTuple = {
  candidateProfileId: 'profile-1',
  ownerUserId: 'user-1',
  tenantId: 'tenant-1',
};

describe('owner-scoped candidate resource routes (#259, #262)', () => {
  beforeEach(() => {
    hostedMocks.operator = false;
    hostedMocks.shared = true;
    routeMocks.collections.clear();
    routeMocks.getCollection.mockClear();
    scopedMocks.getScopedRecord.mockReset();
    scopedMocks.listScopedRecords.mockReset();
    scopedMocks.runScopedWriteSideEffects.mockClear();
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockClear();
    scopedMocks.listScopedRecords.mockResolvedValue({
      items: [{ id: 'exp-1', summary: 'Mine' }],
      limit: 25,
      offset: 0,
      total: 1,
    });
    scopedMocks.getScopedRecord.mockResolvedValue({ id: 'exp-1' });
  });

  it('lets a hosted owner reach career records through the scoped path, never an unscoped collection read', async () => {
    const experiences = routeMocks.collection([
      { id: 'exp-1', summary: 'Mine', ...ownedTuple },
      { id: 'exp-2', summary: 'Theirs', ...ownedTuple, ownerUserId: 'user-2' },
    ]);
    const achievements = routeMocks.collection();
    routeMocks.collections.set('Experience', experiences);
    routeMocks.collections.set('Achievement', achievements);

    const list = await collectionGet({
      params: { resource: 'experiences' },
      url: new URL('https://iolaus.localhost/api/experiences?limit=25'),
    } as never);
    expect(await list.json()).toMatchObject({
      count: 1,
      items: [{ id: 'exp-1' }],
      limit: 25,
    });
    expect(scopedMocks.listScopedRecords).toHaveBeenCalledWith('Experience', {
      limit: 25,
      offset: 0,
    });
    expect(experiences.list).not.toHaveBeenCalled();

    const created = await collectionPost({
      locals: { user: { id: 'user-1' } },
      params: { resource: 'achievements' },
      request: jsonRequest({ title: 'Shipped it' }),
    } as never);
    expect(created.status).toBe(201);
    // The owner tuple is stamped by the server, never taken from the body.
    expect(achievements.create).toHaveBeenCalledWith({
      title: 'Shipped it',
      ...ownedTuple,
    });
    expect(scopedMocks.runScopedWriteSideEffects).toHaveBeenCalledWith(
      'Achievement',
    );

    const updated = await itemPut({
      locals: { user: { id: 'user-1' } },
      params: { id: 'exp-1', resource: 'experiences' },
      request: jsonRequest({ summary: 'Changed' }),
    } as never);
    expect(await updated.json()).toMatchObject({
      id: 'exp-1',
      summary: 'Changed',
    });
    // A same-tenant foreign row is indistinguishable from a missing one.
    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'exp-2', resource: 'experiences' },
        request: jsonRequest({ summary: 'Taken' }),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      collectionPost({
        locals: { user: { id: 'user-1' } },
        params: { resource: 'achievements' },
        request: jsonRequest({ title: 'Forged', ownerUserId: 'user-2' }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      collectionPost({
        locals: { user: { id: 'user-1' } },
        params: { resource: 'achievements' },
        request: jsonRequest({ title: 'Adopt', slug: 'exp-2' }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });

    const deleted = await itemDelete({
      locals: { user: { id: 'user-1' } },
      params: { id: 'exp-1', resource: 'experiences' },
    } as never);
    expect(await deleted.json()).toEqual({ success: true });
    expect(experiences.records.some((row) => row.id === 'exp-1')).toBe(false);
    await expect(
      itemDelete({
        locals: { user: { id: 'user-1' } },
        params: { id: 'exp-2', resource: 'experiences' },
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(experiences.records.some((row) => row.id === 'exp-2')).toBe(true);
  });

  it('keeps the application guards and the owner scope together on the private workspace path (#262)', async () => {
    const applications = routeMocks.collection([
      { id: 'app-1', status: 'draft', ...ownedTuple },
      { id: 'app-2', status: 'draft', ...ownedTuple, ownerUserId: 'user-2' },
    ]);
    routeMocks.collections.set('Application', applications);
    // Foreign application: 404 before any guard or commit.
    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'app-2', resource: 'applications' },
        request: jsonRequest({ notes: 'x' }),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      applicationConcurrencyMocks.commitApplicationIfCurrent,
    ).not.toHaveBeenCalled();
    // Owned application: the existing guards still run before the commit.
    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'app-1', resource: 'applications' },
        request: jsonRequest({ materialWriteLock: 'locked' }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    const updated = await itemPut({
      locals: { user: { id: 'user-1' } },
      params: { id: 'app-1', resource: 'applications' },
      request: jsonRequest({ approvalNotes: 'Looks fine' }),
    } as never);
    expect(updated.status).toBe(200);
    expect(
      applicationConcurrencyMocks.commitApplicationIfCurrent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-1' }),
      expect.objectContaining({ approvalNotes: 'Looks fine' }),
    );
    // Create: the server stamps the owner tuple and the create guards run.
    const created = await collectionPost({
      locals: { user: { id: 'user-1' } },
      params: { resource: 'applications' },
      request: jsonRequest({ opportunityId: 'opp-1' }),
    } as never);
    expect(created.status).toBe(201);
    expect(applications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityId: 'opp-1',
        status: 'draft',
        ...ownedTuple,
      }),
    );
  });

  it('keeps the shared catalog operator-only for the same hosted owner', async () => {
    await expect(
      collectionGet({
        params: { resource: 'sources' },
        url: new URL('https://iolaus.localhost/api/sources'),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(routeMocks.getCollection).not.toHaveBeenCalled();
  });

  it('rejects profile fields outside the agent contract before the scoped write', async () => {
    const profiles = routeMocks.collection([
      { id: 'profile-1', ownerUserId: 'user-1', tenantId: 'tenant-1' },
    ]);
    routeMocks.collections.set('CandidateProfile', profiles);
    await expect(
      itemPut({
        locals: { user: { id: 'user-1' } },
        params: { id: 'profile-1', resource: 'candidateprofiles' },
        request: jsonRequest({ ownerUserId: 'user-2', summary: 'x' }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(profiles.records[0].save).not.toHaveBeenCalled();
    await expect(
      collectionPost({
        locals: { user: { id: 'user-1' } },
        params: { resource: 'candidateprofiles' },
        request: jsonRequest({ name: 'Second profile' }),
      } as never),
    ).rejects.toMatchObject({ status: 405 });
  });
});
