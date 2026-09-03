import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminHydratedResourcePage from './AdminHydratedResourcePage.svelte';

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(() => Promise.resolve()),
  createSmrtCollection: vi.fn(() => ({ cleanup: mocks.cleanup })),
  createSmrtWebClient: vi.fn(() => ({})),
  liveCollection: vi.fn(() => {
    throw new Error('liveCollection must not run during SSR');
  }),
}));

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/tasks') },
}));
vi.mock('@happyvertical/smrt-svelte/web', () => ({
  liveCollection: mocks.liveCollection,
}));
vi.mock('@happyvertical/smrt-virt-web', () => ({
  getCollectionDefinition: vi.fn(() => ({})),
  manifestHash: 'test-manifest',
}));
vi.mock('@happyvertical/smrt-web', () => ({
  createSmrtCollection: mocks.createSmrtCollection,
  createSmrtWebClient: mocks.createSmrtWebClient,
  createSmrtWebEventSubscriber: vi.fn(),
  liveInvalidation: vi.fn(),
}));

describe('AdminHydratedResourcePage SSR', () => {
  beforeEach(() => {
    mocks.createSmrtCollection.mockClear();
    mocks.createSmrtWebClient.mockClear();
    mocks.cleanup.mockClear();
    mocks.liveCollection.mockClear();
  });

  for (const slug of ['applications', 'opportunities', 'tasks'] as const) {
    it(`renders ${slug} from server data without creating a live query`, () => {
      const resource = getAdminResource(slug);
      if (!resource) throw new Error(`Expected ${slug} admin resource fixture`);

      expect(() =>
        render(AdminHydratedResourcePage, {
          props: {
            data: {
              activeReviewFilter: 'all',
              activeTaskOwnerFilter: 'all',
              activeTaskStatusFilter: 'all',
              candidateSkills: [],
              comboOptions: {},
              opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
              pagination: createAdminListPagination(0, 1, 250),
              records: [],
              referenceOptions: {},
              resource,
            },
          },
        }),
      ).not.toThrow();
      expect(mocks.liveCollection).not.toHaveBeenCalled();
    });
  }
});
