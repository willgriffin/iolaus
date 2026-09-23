import { describe, expect, it } from 'vitest';
import { load } from './+page';

type LoadEvent = Parameters<typeof load>[0];

function event(resource: string, href: string): LoadEvent {
  return {
    params: { resource },
    parent: async () => ({
      tenantId: 'tenant-a',
      user: { email: 'owner@example.test', id: 'user-a' },
    }),
    url: new URL(href),
  } as unknown as LoadEvent;
}

describe('admin list route load', () => {
  it('builds the list shell in the browser from layout identity', async () => {
    const data = await load(
      event(
        'tasks',
        'http://localhost/admin/tasks?owner=me&status=open&page=3',
      ),
    );

    expect(data).toMatchObject({
      activeTaskOwnerFilter: 'me',
      activeTaskStatusFilter: 'open',
      loading: true,
      pagination: { page: 3, pageSize: 250, totalRecords: 0 },
      records: [],
      resource: { slug: 'tasks' },
      tenantId: 'tenant-a',
      user: { id: 'user-a' },
    });
  });

  it('uses the opportunity defaults for the opportunity list', async () => {
    const data = await load(
      event('opportunities', 'http://localhost/admin/opportunities'),
    );

    expect(data).toMatchObject({
      activeReviewFilter: 'unsorted',
      pagination: { page: 1, pageSize: 100 },
      resource: { slug: 'opportunities' },
    });
  });

  it('returns 404 for an unknown resource', async () => {
    await expect(
      load(event('not-a-resource', 'http://localhost/admin/not-a-resource')),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('has no server load, so navigation needs no __data.json round trip', async () => {
    const server = await import('./+page.server');
    expect('load' in server).toBe(false);
    expect(Object.keys(server.actions).length).toBeGreaterThan(0);
  });
});
