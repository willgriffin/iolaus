import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_DOCK_CONTEXT } from '$lib/admin/dock';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminResourcePage from './AdminResourcePage.svelte';

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/tasks') },
}));

describe('AdminResourcePage task loading', () => {
  it('makes Screening Questions discoverable from the actual Preferences list', () => {
    const resource = getAdminResource('preferences');
    if (!resource) throw new Error('Expected Preferences resource');
    const { body } = render(AdminResourcePage, {
      props: {
        data: {
          activeTaskOwnerFilter: 'all',
          activeTaskStatusFilter: 'all',
          activeReviewFilter: 'all',
          candidateSkills: [],
          comboOptions: {},
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
    expect(body).toContain('href="/admin/preferences/screening-questions"');
    expect(body).toContain('Screening Questions</a>');
  });

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
    expect(body).toContain('resource-record-metadata');
    expect(body).toContain('href="/admin/skills/skill-1/edit"');
    expect(body).toContain('aria-label="Hide from resume"');
  });

  it('renders configured generic fields as labelled card metadata', () => {
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
          opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
          pagination: createAdminListPagination(1, 1, 250),
          referenceOptions: {},
          resource,
          records: [{ id: 'skill-1', label: 'TypeScript', useOnResume: false }],
        },
      },
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('>Label</dt>');
    expect(body).toContain('TypeScript');
    expect(body).toContain('aria-label="Show on resume"');
    expect(body).not.toContain('<table');
  });

  it('keeps application status filtering in the neutral filter dialog', () => {
    const resource = getAdminResource('applications');
    if (!resource)
      throw new Error('Expected applications admin resource fixture');

    const { body } = render(AdminResourcePage, {
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
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('aria-label="Filters"');
    expect(body).toContain('id="application-filters-title"');
    expect(body).toContain('Application status');
    expect(body).toContain('value="archived"');
    expect(body).not.toContain('application-header-filters');
  });

  it('keeps Sources controls compact when no workspace header is available', () => {
    const resource = getAdminResource('sources');
    if (!resource) throw new Error('Expected Sources admin resource fixture');

    const { body } = render(AdminResourcePage, {
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
      context: new Map([
        [ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined }],
      ]),
    });

    expect(body).toContain('aria-label="Sources controls"');
    expect(body).toContain('aria-label="Add URL"');
    expect(body).toContain('aria-label="Filters"');
    expect(body).toContain('aria-label="New job source"');
    expect(body).not.toContain('<h1>Sources</h1>');
    expect(body).not.toContain('Your job sources');
    expect(body).not.toContain('Add a job source');
  });
});
