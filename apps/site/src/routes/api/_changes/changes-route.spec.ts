import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
  db: { query: vi.fn() },
  ensureChangeFeedTable: vi.fn(),
  getDbConfig: vi.fn(),
  getDatabaseUrl: vi.fn(),
  getTenantScopedChangesSince: vi.fn(),
  resolveDatabase: vi.fn(),
  shared: false,
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  ensureChangeFeedTable: mocks.ensureChangeFeedTable,
  getTenantScopedChangesSince: mocks.getTenantScopedChangesSince,
  resolveDatabase: mocks.resolveDatabase,
}));

vi.mock('$lib/server/app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/app-config')>()),
  isSharedHosted: () => mocks.shared,
}));

vi.mock('$lib/server/smrt', () => ({ getCollection: vi.fn() }));

vi.mock('$lib/server/db', () => ({
  getDbConfig: mocks.getDbConfig,
  getDatabaseUrl: mocks.getDatabaseUrl,
}));

describe('SMRT changes API', () => {
  beforeEach(() => {
    mocks.shared = false;
    mocks.db.query.mockReset();
    mocks.ensureChangeFeedTable.mockReset();
    mocks.getDbConfig.mockReset();
    mocks.getDatabaseUrl.mockReset();
    mocks.getTenantScopedChangesSince.mockReset();
    mocks.resolveDatabase.mockReset();
    mocks.getDbConfig.mockReturnValue({
      type: 'postgres',
      url: 'postgresql://localhost/test',
    });
    mocks.getDatabaseUrl.mockReturnValue('postgresql://localhost/test');
    mocks.resolveDatabase.mockResolvedValue(mocks.db);
    mocks.getTenantScopedChangesSince.mockResolvedValue({
      changes: [{ operation: 'update', rowId: 'task-1', table: 'tasks' }],
      cursor: 8,
    });
  });

  it('returns tenant-scoped changes for authenticated polling clients', async () => {
    const response = await GET({
      locals: { user: { id: 'user-1' } },
      url: new URL(
        'https://iolaus.localhost/api/_changes?since=5&limit=10&tables=tasks,applications',
      ),
    } as Parameters<typeof GET>[0]);

    await expect(response.json()).resolves.toEqual({
      changes: [{ operation: 'update', rowId: 'task-1', table: 'tasks' }],
      cursor: 8,
    });
    expect(mocks.resolveDatabase).toHaveBeenCalledWith(
      { type: 'postgres', url: 'postgresql://localhost/test' },
      { dbid: 'smrt:postgresql://localhost/test' },
    );
    expect(mocks.ensureChangeFeedTable).toHaveBeenCalledWith(mocks.db);
    expect(mocks.getTenantScopedChangesSince).toHaveBeenCalledWith(mocks.db, {
      limit: 10,
      since: 5,
      tables: ['tasks', 'applications'],
    });
  });

  it('fails closed without an authenticated session', async () => {
    const response = await GET({
      locals: {},
      url: new URL('https://iolaus.localhost/api/_changes?since=0'),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.resolveDatabase).not.toHaveBeenCalled();
  });

  it('rejects malformed cursors before touching the database', async () => {
    const response = await GET({
      locals: { user: { id: 'user-1' } },
      url: new URL('https://iolaus.localhost/api/_changes?since=-1'),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "'since' must be a non-negative number",
    });
    expect(mocks.resolveDatabase).not.toHaveBeenCalled();
  });

  it('polls a shared feed only inside the native verified tenant context', async () => {
    mocks.shared = true;
    const subject = { tenantId: 'tenant-1', userId: 'user-1' };
    mocks.getTenantScopedChangesSince.mockImplementation(async () => {
      expect(getCurrentTenant()).toMatchObject({
        ...subject,
        metadata: { workspaceSubject: subject },
      });
      return { changes: [], cursor: 5 };
    });

    const response = await withTenant(
      { ...subject, metadata: { workspaceSubject: subject } },
      async () =>
        await GET({
          locals: { user: { id: subject.userId } },
          url: new URL('https://iolaus.localhost/api/_changes?since=5'),
        } as Parameters<typeof GET>[0]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ changes: [], cursor: 5 });
    expect(getCurrentTenant()).toBeUndefined();
  });

  it.each([
    ['missing', {}],
    [
      'foreign',
      { workspaceSubject: { tenantId: 'tenant-2', userId: 'user-1' } },
    ],
  ])('rejects a shared feed with a %s subject before database access', async (_label, metadata) => {
    mocks.shared = true;

    await expect(
      withTenant(
        { tenantId: 'tenant-1', userId: 'user-1', metadata },
        async () =>
          await GET({
            locals: { user: { id: 'user-1' } },
            url: new URL('https://iolaus.localhost/api/_changes?since=0'),
          } as Parameters<typeof GET>[0]),
      ),
    ).rejects.toMatchObject({
      status: 403,
      body: { message: 'A verified workspace is required for live updates.' },
    });
    expect(mocks.resolveDatabase).not.toHaveBeenCalled();
  });
});
