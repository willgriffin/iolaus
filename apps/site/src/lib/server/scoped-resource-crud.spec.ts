import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  operator: false,
  shared: true,
  subject: {
    profileId: 'profile-a',
    tenantId: 'tenant-a',
    userId: 'user-a',
  } as { profileId?: string; tenantId: string; userId: string } | null,
}));

const sideEffects = vi.hoisted(() => ({
  invalidate: vi.fn(),
  queueRefresh: vi.fn(),
}));

type Row = Record<string, unknown> & {
  delete: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

const store = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const row = (payload: Record<string, unknown>): Row => {
    const record = {
      ...payload,
      delete: vi.fn(async () => {
        rows.delete(String(record.id));
      }),
      save: vi.fn(async () => {}),
    } as Row;
    return record;
  };
  const collection = {
    count: vi.fn(
      async ({ where = {} }: { where?: Record<string, unknown> }) =>
        [...rows.values()].filter((item) =>
          Object.entries(where).every(([key, value]) => item[key] === value),
        ).length,
    ),
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const record = row({ id: `new-${rows.size + 1}`, ...payload });
      rows.set(String(record.id), record);
      return record;
    }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    list: vi.fn(
      async ({
        where = {},
      }: {
        limit?: number;
        offset?: number;
        orderBy?: string;
        where?: Record<string, unknown>;
      }) =>
        [...rows.values()].filter((item) =>
          Object.entries(where).every(([key, value]) => item[key] === value),
        ),
    ),
  };
  return { collection, row, rows };
});

vi.mock('./app-config.js', () => ({ isSharedHosted: () => state.shared }));
vi.mock('./workspace-subject.js', () => ({
  getCurrentWorkspaceSubject: () => state.subject,
  isCurrentWorkspaceOperator: () => state.operator,
}));
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => store.collection),
}));
vi.mock('./resume-data.js', () => ({
  invalidatePublishedResumeCache: sideEffects.invalidate,
}));
vi.mock('./resume-source-refresh.js', () => ({
  queuePublishedCanonicalRefresh: sideEffects.queueRefresh,
}));

import {
  createScopedRecord,
  deleteScopedRecord,
  getScopedRecord,
  isScopedResourceClass,
  listScopedRecords,
  updateScopedRecord,
} from './scoped-resource-crud.js';

const mine = {
  candidateProfileId: 'profile-a',
  ownerUserId: 'user-a',
  tenantId: 'tenant-a',
};
const theirs = {
  candidateProfileId: 'profile-b',
  ownerUserId: 'user-b',
  tenantId: 'tenant-a',
};

describe('owner-scoped generic CRUD', () => {
  beforeEach(() => {
    state.shared = true;
    state.operator = false;
    state.subject = {
      profileId: 'profile-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
    };
    store.rows.clear();
    store.rows.set(
      'exp-mine',
      store.row({ id: 'exp-mine', summary: 'Mine', ...mine }),
    );
    store.rows.set(
      'exp-theirs',
      store.row({ id: 'exp-theirs', summary: 'Theirs', ...theirs }),
    );
    for (const mock of Object.values(sideEffects)) mock.mockClear();
    store.collection.list.mockClear();
  });

  it('classifies candidate-owned classes only', () => {
    expect(isScopedResourceClass('Experience')).toBe(true);
    expect(isScopedResourceClass('CandidateProfile')).toBe(true);
    expect(isScopedResourceClass('Opportunity')).toBe(false);
    expect(isScopedResourceClass('Source')).toBe(false);
  });

  it('lists only the owner tuple and lets the ownership predicate win over a caller filter', async () => {
    const page = await listScopedRecords('Experience', {
      limit: '500',
      offset: -3,
      orderBy: 'sortOrder ASC; DROP TABLE',
      where: { ownerUserId: 'user-b', candidateProfileId: 'profile-b' },
    });
    expect(page.items.map((item) => item.id)).toEqual(['exp-mine']);
    expect(page).toMatchObject({ limit: 200, offset: 0, total: 1 });
    const options = store.collection.list.mock.calls[0][0];
    expect(options.where).toEqual(mine);
    expect(options.orderBy).toBeUndefined();
    expect(page.items[0]).not.toHaveProperty('save');
  });

  it('reads, updates and deletes only owned records', async () => {
    expect(await getScopedRecord('Experience', 'exp-theirs')).toBeNull();
    expect(await getScopedRecord('Experience', 'exp-mine')).toMatchObject({
      id: 'exp-mine',
    });
    await expect(
      updateScopedRecord('Experience', 'exp-theirs', { summary: 'Taken' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateScopedRecord('Experience', 'exp-mine', { ownerUserId: 'user-b' }),
    ).rejects.toMatchObject({ status: 403 });
    const updated = await updateScopedRecord('Experience', 'exp-mine', {
      summary: 'Edited',
    });
    expect(updated).toMatchObject({
      id: 'exp-mine',
      summary: 'Edited',
      ...mine,
    });
    expect(store.rows.get('exp-mine')?.save).toHaveBeenCalledOnce();
    await expect(
      deleteScopedRecord('Experience', 'exp-theirs'),
    ).rejects.toMatchObject({ status: 404 });
    await deleteScopedRecord('Experience', 'exp-mine');
    expect(store.rows.has('exp-mine')).toBe(false);
    expect(store.rows.has('exp-theirs')).toBe(true);
  });

  it('stamps the verified owner tuple on create and refuses a forged one', async () => {
    const created = await createScopedRecord('Achievement', {
      title: 'Shipped',
    });
    expect(created).toMatchObject({ title: 'Shipped', ...mine });
    await expect(
      createScopedRecord('Achievement', { title: 'Forged', ...theirs }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('runs the admin résumé write side effect for résumé source classes only', async () => {
    await updateScopedRecord('Experience', 'exp-mine', { summary: 'A' });
    expect(sideEffects.invalidate).toHaveBeenCalledTimes(1);
    expect(sideEffects.queueRefresh).toHaveBeenCalledTimes(1);
    store.rows.set('task-1', store.row({ id: 'task-1', ...mine }));
    await updateScopedRecord('Task', 'task-1', { title: 'B' });
    expect(sideEffects.invalidate).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a verified candidate workspace in hosted mode', async () => {
    state.subject = { tenantId: 'tenant-a', userId: 'user-a' };
    await expect(listScopedRecords('Experience')).rejects.toMatchObject({
      status: 409,
    });
    state.subject = null;
    await expect(
      getScopedRecord('Experience', 'exp-mine'),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.collection.list).not.toHaveBeenCalled();
  });

  it('defaults the owner tuple in a private installation but keeps UI parity on reads', async () => {
    state.shared = false;
    const page = await listScopedRecords('Experience');
    expect(page.items.map((item) => item.id).sort()).toEqual([
      'exp-mine',
      'exp-theirs',
    ]);
    const created = await createScopedRecord('Experience', { summary: 'New' });
    expect(created).toMatchObject({ summary: 'New', ...mine });
  });

  it('never defaults ownership onto the profile itself', async () => {
    store.rows.set(
      'profile-a',
      store.row({
        id: 'profile-a',
        ownerUserId: 'user-a',
        tenantId: 'tenant-a',
      }),
    );
    expect(
      await getScopedRecord('CandidateProfile', 'profile-a'),
    ).toMatchObject({ id: 'profile-a' });
    expect(await getScopedRecord('CandidateProfile', 'profile-b')).toBeNull();
  });
});
