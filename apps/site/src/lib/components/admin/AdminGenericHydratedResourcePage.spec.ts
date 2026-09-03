import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_DOCK_CONTEXT } from '$lib/admin/dock';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminGenericHydratedResourcePage from './AdminGenericHydratedResourcePage.svelte';

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/skills') },
}));

describe('AdminGenericHydratedResourcePage', () => {
  it('renders a generic resource shell without waiting for its list request', () => {
    const resource = getAdminResource('skills');
    if (!resource) throw new Error('Expected skills admin resource fixture');

    const { body } = render(AdminGenericHydratedResourcePage, {
      props: {
        data: {
          activeReviewFilter: 'all',
          activeTaskOwnerFilter: 'all',
          activeTaskStatusFilter: 'all',
          candidateSkills: [],
          comboOptions: {},
          loading: true,
          opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
          pagination: createAdminListPagination(0, 1, 250),
          records: [],
          referenceOptions: {},
          resource,
        },
      },
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('Loading records');
    expect(body).toContain('Loading skills');
  });
});
