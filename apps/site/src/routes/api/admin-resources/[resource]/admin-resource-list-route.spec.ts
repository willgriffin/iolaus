import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
  loadAdminResourcePageData: vi.fn(),
}));

vi.mock('$lib/server/admin-resource-route', () => ({
  loadAdminResourcePageData: mocks.loadAdminResourcePageData,
}));

describe('admin resource list API', () => {
  beforeEach(() => {
    mocks.loadAdminResourcePageData.mockReset();
  });

  it('returns authenticated admin list records in a smrt-web list shape', async () => {
    const records = [{ id: 'opp-1', title: 'Platform Engineer' }];
    const pagination = {
      end: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      offset: 0,
      page: 1,
      pageSize: 250,
      recordCount: 1,
      start: 1,
      totalPages: 1,
      totalRecords: 1,
    };
    mocks.loadAdminResourcePageData.mockResolvedValue({
      activeReviewFilter: 'apply',
      activeTaskOwnerFilter: 'all',
      activeTaskStatusFilter: 'all',
      candidateSkills: ['svelte'],
      comboOptions: {},
      opportunityFilterOptions: {
        employmentTypes: [],
        freshness: [],
        seniorities: [],
        skills: [],
        statuses: [],
        workModes: [],
      },
      pagination,
      records,
      referenceOptions: {},
    });

    const url = new URL(
      'https://iolaus.localhost/api/admin-resources/opportunities?review=apply',
    );
    const response = await GET({
      locals: { user: { id: 'user-1' } },
      params: { resource: 'opportunities' },
      url,
    } as Parameters<typeof GET>[0]);

    await expect(response.json()).resolves.toEqual({
      activeReviewFilter: 'apply',
      activeTaskOwnerFilter: 'all',
      activeTaskStatusFilter: 'all',
      candidateSkills: ['svelte'],
      comboOptions: {},
      count: 1,
      data: records,
      items: records,
      opportunityFilterOptions: {
        employmentTypes: [],
        freshness: [],
        seniorities: [],
        skills: [],
        statuses: [],
        workModes: [],
      },
      pagination,
      records,
      referenceOptions: {},
    });
    expect(mocks.loadAdminResourcePageData).toHaveBeenCalledWith(
      'opportunities',
      url,
    );
  });

  it('fails closed without an authenticated admin session', async () => {
    const response = await GET({
      locals: {},
      params: { resource: 'opportunities' },
      url: new URL(
        'https://iolaus.localhost/api/admin-resources/opportunities',
      ),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.loadAdminResourcePageData).not.toHaveBeenCalled();
  });
});
