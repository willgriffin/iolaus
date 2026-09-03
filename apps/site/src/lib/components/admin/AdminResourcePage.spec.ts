import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { ADMIN_DOCK_CONTEXT } from '$lib/admin/dock';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminResourcePage from './AdminResourcePage.svelte';

describe('AdminResourcePage task loading', () => {
  it('shows a retryable error instead of empty workflow lanes', () => {
    const resource = getAdminResource('tasks');
    if (!resource) throw new Error('Expected tasks admin resource fixture');

    const { body } = render(AdminResourcePage, {
      props: {
        data: {
          activeReviewFilter: 'all',
          activeTaskOwnerFilter: 'all',
          activeTaskStatusFilter: 'all',
          candidateSkills: [],
          comboOptions: {},
          error: 'Unable to load tasks.',
          opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
          pagination: createAdminListPagination(0, 1, 250),
          records: [],
          referenceOptions: {},
          resource,
        },
        onRetry: () => undefined,
      },
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('Unable to load tasks.');
    expect(body).toContain('Try again');
    expect(body).not.toContain('No tasks');
    expect(body.match(/Unable to load tasks\./g)).toHaveLength(1);
  });

  it('keeps stale generic rows visible with an error and retry control', () => {
    const resource = getAdminResource('skills');
    if (!resource) throw new Error('Expected skills admin resource fixture');

    const { body } = render(AdminResourcePage, {
      props: {
        data: {
          activeReviewFilter: 'all',
          activeTaskOwnerFilter: 'all',
          activeTaskStatusFilter: 'all',
          candidateSkills: [],
          comboOptions: {},
          error: 'Unable to refresh skills.',
          opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
          pagination: createAdminListPagination(1, 1, 250),
          records: [{ id: 'skill-1', label: 'TypeScript' }],
          referenceOptions: {},
          resource,
          stale: true,
        },
        onRetry: () => undefined,
      },
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('Unable to refresh skills.');
    expect(body).toContain('Try again');
    expect(body).toContain('TypeScript');
  });
});
