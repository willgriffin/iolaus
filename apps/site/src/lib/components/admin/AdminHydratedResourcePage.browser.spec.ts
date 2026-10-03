// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_DOCK_CONTEXT } from '$lib/admin/dock';
import { createAdminListPagination } from '$lib/admin/pagination';
import { getAdminResource } from '$lib/admin/resources';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import AdminHydratedResourcePage from './AdminHydratedResourcePage.svelte';
import {
  adminResourceQueryScope,
  getCachedAdminResourceListPayload,
  rememberAdminResourceListPayload,
} from './admin-resource-hydration';

const mocks = vi.hoisted(() => ({
  started: false,
  fetchers: undefined as undefined | { list: () => Promise<unknown> },
  cleanup: vi.fn(async () => {}),
  preload: vi.fn(() => {
    if (!mocks.started) {
      mocks.started = true;
      void mocks.fetchers!.list().catch(() => {});
    }
    // Model the installed engine's pending first-ready promise after an async
    // fetch rejection. The component must observe the actual fetch instead.
    return new Promise<void>(() => {});
  }),
  invalidate: vi.fn(() => {
    void mocks.fetchers!.list().catch(() => {});
  }),
  page: { url: new URL('http://localhost/admin/opportunities') },
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
// These scenarios read/retry the list; enhanced form mutations are not invoked.
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => {} }) }));
vi.mock('@happyvertical/smrt-svelte/web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-svelte/web')>()),
  liveCollection: (handle: { preload: () => Promise<void> }) => {
    void handle.preload().catch(() => {});
    return { isReady: false, isError: false, error: null, rows: [] };
  },
}));
vi.mock('@happyvertical/smrt-virt-web', () => ({
  manifestHash: 'browser-test',
}));
vi.mock('@happyvertical/smrt-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-web')>()),
  createSmrtWebClient: () => ({}),
  createSmrtCollection: (
    _definition: unknown,
    options: { fetchers: typeof mocks.fetchers },
  ) => {
    mocks.fetchers = options.fetchers;
    return { preload: mocks.preload, cleanup: mocks.cleanup };
  },
  createSmrtWebEventSubscriber: () => ({}),
  liveInvalidation: () => ({ name: 'test-no-events' }),
  invalidateSmrtWebCollections: mocks.invalidate,
}));

let component: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  mocks.started = false;
  mocks.fetchers = undefined;
  mocks.preload.mockClear();
  mocks.cleanup.mockClear();
  mocks.invalidate.mockClear();
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function payload(title: string) {
  return {
    activeReviewFilter: 'all',
    activeTaskOwnerFilter: 'all',
    activeTaskStatusFilter: 'all',
    candidateSkills: [],
    comboOptions: {},
    referenceOptions: {},
    opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
    pagination: createAdminListPagination(1, 1, 250),
    records: [
      {
        id: 'opportunity',
        title,
        status: 'found',
        humanReviewStatus: 'needs_input',
      },
    ],
  };
}
function start(search: string) {
  mocks.page.url = new URL(`http://localhost/admin/opportunities${search}`);
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(AdminHydratedResourcePage, {
    target,
    context: new Map([
      [
        ADMIN_DOCK_CONTEXT,
        {
          close: () => {},
          open: () => {},
          setResourceContext: () => {},
        },
      ],
    ]),
    props: {
      data: {
        ...payload(''),
        records: [],
        pagination: createAdminListPagination(0, 1, 250),
        resource: getAdminResource('opportunities')!,
        loading: true,
        tenantId: 'tenant',
        user: { id: 'user' },
      },
    },
  });
  flushSync();
  return target;
}
function scope(search: string) {
  return adminResourceQueryScope('opportunities', search, 'tenant', 'user');
}

describe('AdminHydratedResourcePage rejected browser hydration', () => {
  it('ends a stalled HTTP500 load with an alert and retries the same query through native invalidation', async () => {
    const search = '?sort=cited_support&sortDirection=asc&q=terminal-retry';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unavailable', { status: 500 }))
      .mockResolvedValueOnce(Response.json(payload('Recovered opportunity')));
    vi.stubGlobal('fetch', fetchMock);
    const target = start(search);
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'HTTP 500',
      ),
    );
    expect(target.querySelector('[aria-busy="true"]')).toBeNull();
    const retry = Array.from(target.querySelectorAll('button')).find((button) =>
      /^(Retry|Try again)$/.test(button.textContent?.trim() ?? ''),
    );
    expect(retry).toBeTruthy();
    retry!.click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Recovered opportunity'),
    );
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.invalidate).toHaveBeenCalledWith(expect.anything(), [
      'opportunities',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((args) => args[0])).toEqual([
      `/api/admin-resources/opportunities${search}`,
      `/api/admin-resources/opportunities${search}`,
    ]);
  });
  it('preserves cached rows and pagination while failed revalidation surfaces an alert', async () => {
    const search = '?sort=cited_support&sortDirection=asc&q=cached-failure';
    const cached = payload('Cached opportunity');
    rememberAdminResourceListPayload(scope(search), cached);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 500 })),
    );
    const target = start(search);
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'HTTP 500',
      ),
    );
    expect(target.textContent).toContain('Cached opportunity');
    expect(getCachedAdminResourceListPayload(scope(search))).toEqual(cached);
    expect(target.querySelector('[aria-busy="true"]')).toBeNull();
  });
  it('does not accept a late successful payload after disposal', async () => {
    const search = '?q=disposed-payload';
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    start(search);
    await unmount(component!);
    component = undefined;
    finish(Response.json(payload('Late opportunity')));
    await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getCachedAdminResourceListPayload(scope(search))).toBeNull();
  });
});
