import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browser: true,
  createSmrtWebClient: vi.fn(() => ({})),
  createSmrtWebEventSubscriber: vi.fn(() => ({})),
  liveInvalidation: vi.fn(() => ({})),
}));

vi.mock('$app/environment', () => ({
  get browser() {
    return mocks.browser;
  },
}));
vi.mock('@happyvertical/smrt-virt-web', () => ({
  manifestHash: 'test-manifest',
}));
vi.mock('@happyvertical/smrt-web', () => ({
  createSmrtWebClient: mocks.createSmrtWebClient,
  createSmrtWebEventSubscriber: mocks.createSmrtWebEventSubscriber,
  liveInvalidation: mocks.liveInvalidation,
}));

describe('admin live invalidation', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.browser = true;
    mocks.createSmrtWebClient.mockClear();
    mocks.createSmrtWebEventSubscriber.mockClear();
    mocks.liveInvalidation.mockClear();
  });

  it('shares one lazy SMRT client across resources', async () => {
    const { getAdminSmrtWebClient } = await import(
      './admin-resource-hydration'
    );

    const firstClient = getAdminSmrtWebClient();
    const secondClient = getAdminSmrtWebClient();

    expect(firstClient).toBe(secondClient);
    expect(mocks.createSmrtWebClient).toHaveBeenCalledTimes(1);
  });

  it('does not create the client during SSR', async () => {
    mocks.browser = false;
    const { getAdminSmrtWebClient } = await import(
      './admin-resource-hydration'
    );

    expect(getAdminSmrtWebClient()).toBeNull();
    expect(mocks.createSmrtWebClient).not.toHaveBeenCalled();
  });

  it('scopes cached admin lists by authenticated identity and canonical URL state', async () => {
    const {
      adminResourceQueryScope,
      getCachedAdminResourceListPayload,
      rememberAdminResourceListPayload,
    } = await import('./admin-resource-hydration');
    const firstScope = adminResourceQueryScope(
      'opportunities',
      '?sort=best&review=apply',
      'tenant-a',
      'user-a',
    );
    const sameQueryDifferentOrder = adminResourceQueryScope(
      'opportunities',
      '?review=apply&sort=best',
      'tenant-a',
      'user-a',
    );
    const differentUser = adminResourceQueryScope(
      'opportunities',
      '?review=apply&sort=best',
      'tenant-a',
      'user-b',
    );
    const payload = {
      activeReviewFilter: 'apply',
      activeTaskOwnerFilter: 'all',
      activeTaskStatusFilter: 'all',
      candidateSkills: [],
      comboOptions: {},
      opportunityFilterOptions: {
        employmentTypes: [],
        freshness: [],
        seniorities: [],
        skills: [],
        statuses: [],
        workModes: [],
      },
      pagination: {
        end: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        offset: 0,
        page: 1,
        pageSize: 100,
        recordCount: 1,
        start: 1,
        totalPages: 1,
        totalRecords: 1,
      },
      records: [{ id: 'opp-1' }],
      referenceOptions: {},
    };

    rememberAdminResourceListPayload(firstScope, payload);

    expect(sameQueryDifferentOrder).toBe(firstScope);
    expect(getCachedAdminResourceListPayload(sameQueryDifferentOrder)).toBe(
      payload,
    );
    expect(getCachedAdminResourceListPayload(differentUser)).toBeNull();
  });

  it('uses EventSource by default and shares one subscriber across resources', async () => {
    const { createAdminLiveInvalidationCapabilities } = await import(
      './admin-resource-hydration'
    );

    createAdminLiveInvalidationCapabilities('applications');
    createAdminLiveInvalidationCapabilities('tasks');

    expect(mocks.createSmrtWebEventSubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.createSmrtWebEventSubscriber).toHaveBeenCalledWith({
      changesUrl: '/api/_changes',
      eventsUrl: '/api/_events',
      manifestHash: 'test-manifest',
      pollIntervalMs: 5000,
    });
    expect(mocks.liveInvalidation).toHaveBeenNthCalledWith(1, {
      subscriber: {},
      tableName: 'applications',
    });
    expect(mocks.liveInvalidation).toHaveBeenNthCalledWith(2, {
      subscriber: {},
      tableName: 'tasks',
    });
  });
});

describe('readAdminResourceListPayload', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.browser = true;
  });

  const listResponse = (extra: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        pagination: { page: 1, pageSize: 100, totalRecords: 300 },
        records: [{ id: 'opp-1' }],
        ...extra,
      }),
      { headers: { 'content-type': 'application/json' } },
    );

  it('carries the opportunity query fingerprint through normalization', async () => {
    // The hydrated list is the only path that reaches the browser, and the
    // normalizer rebuilds the payload from an explicit key list. A fingerprint
    // dropped here leaves the client sending '' and every all-matching bulk
    // action refused as stale_query_fingerprint.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse({ opportunityQueryFingerprint: 'fp-abc123' }),
      ),
    );
    const { readAdminResourceListPayload } = await import(
      './admin-resource-hydration'
    );

    const payload = await readAdminResourceListPayload('/api/x', {});

    expect(payload.opportunityQueryFingerprint).toBe('fp-abc123');
    vi.unstubAllGlobals();
  });

  it('omits the fingerprint when the response has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => listResponse({})),
    );
    const { readAdminResourceListPayload } = await import(
      './admin-resource-hydration'
    );

    const payload = await readAdminResourceListPayload('/api/x', {});

    expect(payload.opportunityQueryFingerprint).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('ignores a fingerprint that is not a string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => listResponse({ opportunityQueryFingerprint: 42 })),
    );
    const { readAdminResourceListPayload } = await import(
      './admin-resource-hydration'
    );

    const payload = await readAdminResourceListPayload('/api/x', {});

    expect(payload.opportunityQueryFingerprint).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
