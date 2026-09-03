import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
  db: { query: vi.fn() },
  ensureChangeFeedTable: vi.fn(),
  getDbConfig: vi.fn(),
  getDatabaseUrl: vi.fn(),
  getTenantScopedChangesSince: vi.fn(),
  resolveDatabase: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ensureChangeFeedTable: mocks.ensureChangeFeedTable,
  getTenantScopedChangesSince: mocks.getTenantScopedChangesSince,
  resolveDatabase: mocks.resolveDatabase,
}));

vi.mock('$lib/server/db', () => ({
  getDbConfig: mocks.getDbConfig,
  getDatabaseUrl: mocks.getDatabaseUrl,
}));

describe('SMRT changes API', () => {
  beforeEach(() => {
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
});
