// @vitest-environment happy-dom

import type { Snippet } from 'svelte';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminHeaderActions } from '$lib/admin/header-actions';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminResourcePageHeaderHarness from './AdminResourcePageHeaderHarness.svelte';

const page = vi.hoisted(() => ({
  url: new URL('http://localhost/admin/tasks'),
}));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => {} }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/state', () => ({ page }));
vi.mock('./admin-resource-hydration', () => ({
  ADMIN_RESOURCE_REFRESH_EVENT: 'iolaus:admin-resource-refresh',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('AdminResourcePage header actions', () => {
  it('replaces and clears route controls when a reused page changes resources', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    );
    const registrations: Snippet[] = [];
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const header: AdminHeaderActions = {
      register(actions) {
        registrations.push(actions);
        const cleanup = vi.fn();
        cleanups.push(cleanup);
        return cleanup;
      },
    };
    const tasks = getAdminResource('tasks');
    const sources = getAdminResource('sources');
    const skills = getAdminResource('skills');
    if (!tasks || !sources || !skills) throw new Error('Expected resources');

    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(AdminResourcePageHeaderHarness, {
      context: new Map(),
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
          resource: tasks,
        },
        header,
      },
      target,
    });
    flushSync();
    expect(registrations).toHaveLength(1);

    component.setResource(sources);
    flushSync();
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(registrations).toHaveLength(2);

    component.setResource(skills);
    flushSync();
    expect(cleanups[1]).toHaveBeenCalledOnce();
    unmount(component);
  });
});
