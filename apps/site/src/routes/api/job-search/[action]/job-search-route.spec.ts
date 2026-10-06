import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  effectivePermissions: [] as string[],
  browse: vi.fn(async () => ({ items: [] })),
  digDeeper: vi.fn(async () => ({
    failed: [],
    humanReviewStatus: 'maybe',
    opportunityId: 'opp-1',
    steps: [],
  })),
  nextTriageCandidate: vi.fn(async () => ({
    candidate: { id: 'opp-1' },
    position: 1,
    remaining: 3,
    total: 3,
  })),
  importOpportunity: vi.fn(async () => ({ created: true })),
  inspect: vi.fn(async () => ({ id: 'opp-1' })),
  openApplication: vi.fn(async () => ({ created: false })),
  recordDecision: vi.fn(async () => ({ status: 'maybe' })),
  sourceHealth: vi.fn(async () => ({ items: [] })),
  sourceCrawlStatus: vi.fn(async () => ({ items: [] })),
  createSource: vi.fn(async () => ({ id: 'source-1' })),
  setSourceActive: vi.fn(async () => ({ active: true })),
  crawlSource: vi.fn(async () => ({ jobId: 'job-1', crawlId: 'crawl-1' })),
  inspectApplication: vi.fn(async () => ({ application: { id: 'app-1' } })),
  readResume: vi.fn(async () => ({ profile: { name: 'Example' } })),
  sweep: vi.fn(async () => ({ applied: false, count: 3, dryRun: true })),
  verifyPosting: vi.fn(async () => ({ preflight: { state: 'live' } })),
}));

// The native principal, context, operation gate and profile verifier stay real;
// live identity and permission resolution are explicit route-unit fixtures.
// owner-principal.spec.ts and mcp-app-server.spec.ts cover native RBAC rows.
vi.mock('@happyvertical/smrt-users', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-users')>();
  return {
    ...actual,
    UserCollection: {
      create: async () => ({
        get: async ({ id }: { id: string }) =>
          id === 'user-1' ? { id, isActive: () => true } : null,
      }),
    },
    TenantCollection: {
      create: async () => ({
        get: async ({ id }: { id: string }) =>
          id === 'tenant-1' ? { id, isActive: () => true } : null,
      }),
    },
    MembershipCollection: {
      create: async () => ({
        findByUserAndTenant: async (userId: string, tenantId: string) =>
          userId === 'user-1' && tenantId === 'tenant-1'
            ? { roleId: 'role-1', status: 'active', userId, tenantId }
            : null,
      }),
    },
  };
});

vi.mock('$lib/server/smrt', () => ({
  getCollection: async (className: string) => {
    if (className !== 'CandidateProfile')
      throw new Error(`Unexpected fixture collection: ${className}`);
    return {
      get: async (id: string) =>
        id === 'profile-1'
          ? { id, active: true, ownerUserId: 'user-1', tenantId: 'tenant-1' }
          : null,
    };
  },
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: ':memory:' })),
}));

vi.mock('$lib/server/job-search-webmcp', () => ({
  browseJobOpportunities: mocks.browse,
  digDeeperOnJobOpportunity: mocks.digDeeper,
  nextJobTriageCandidate: mocks.nextTriageCandidate,
  importJobOpportunity: mocks.importOpportunity,
  inspectJobOpportunity: mocks.inspect,
  openJobApplication: mocks.openApplication,
  recordJobOpportunityDecision: mocks.recordDecision,
  sweepJobOpportunities: mocks.sweep,
  verifyJobPosting: mocks.verifyPosting,
}));

vi.mock('$lib/server/application-inspect-webmcp', () => ({
  inspectJobApplication: mocks.inspectApplication,
}));

vi.mock('$lib/server/resume-webmcp', () => ({
  readJobSearchResume: mocks.readResume,
}));

vi.mock('$lib/server/source-webmcp', () => ({
  createRootSourceFromWebMcp: mocks.createSource,
  enqueueRootSourceCrawl: mocks.crawlSource,
  listRootSourceHealth: mocks.sourceHealth,
  listSourceCrawlStatus: mocks.sourceCrawlStatus,
  setRootSourceActive: mocks.setSourceActive,
}));

/** Exact catalog permissions asserted by this route. Private records use workflow capabilities. */
const ownerPermissions = [
  'companies.create',
  'companies.read',
  'companies.update',
  'opportunities.create',
  'opportunities.delete',
  'opportunities.read',
  'opportunities.update',
  'sourcecrawls.read',
  'sourcecrawlitems.read',
  'sources.create',
  'sources.read',
  'sources.update',
  'workflow.application.inspect',
  'workflow.application.prepare',
  'workflow.application.review',
  'workflow.audit.record',
  'workflow.profile.manage',
];

/** Schema-valid local identifiers; the tool schemas declare `format: 'uuid'`. */
const opportunityId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const missingApplicationId = '44444444-4444-4444-8444-444444444444';

function without(...denied: string[]): string[] {
  return ownerPermissions.filter((slug) => !denied.includes(slug));
}

function event({
  action,
  body,
  method = 'GET',
  query = '',
  user = { id: 'user-1' },
  permissions = ownerPermissions,
  tenantId = 'tenant-1',
}: {
  action: string;
  body?: unknown;
  method?: string;
  query?: string;
  permissions?: string[];
  tenantId?: string | null;
  user?: { id: string } | null;
}) {
  mocks.effectivePermissions = [...permissions];
  return {
    locals: {
      membership: {
        roleId: 'role-1',
        status: 'active',
        tenantId,
        userId: user?.id ?? null,
      },
      permissions,
      sessionId: 'session-1',
      tenantId,
      user,
      workspaceSubject:
        tenantId && user
          ? { profileId: 'profile-1', tenantId, userId: user.id }
          : undefined,
    },
    params: { action },
    request: new Request(`https://iolaus.localhost/api/job-search/${action}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      method,
    }),
    url: new URL(`https://iolaus.localhost/api/job-search/${action}${query}`),
  };
}

// SMRT dependencies load their native runtime outside the app module mock, so
// intercept its actual resolver method, rather than replacing the app export.
// Its result is fixture-owned; the native context and exact operation catalog
// assertion still run, and each deny case removes its required capability.
beforeEach(async () => {
  const { PermissionResolver } = await import('@happyvertical/smrt-users');
  vi.spyOn(
    PermissionResolver.prototype,
    'resolvePermissions',
  ).mockImplementation(async (userId: string, tenantId: string) => ({
    permissions: new Set(
      userId === 'user-1' && tenantId === 'tenant-1'
        ? mocks.effectivePermissions
        : [],
    ),
    membershipId: 'membership-fixture',
    roleId: 'role-1',
    groupIds: [],
    deniedPermissionIds: [],
    inheritedFromTenantId: null,
    ancestorReadFromTenantIds: [],
  }));
});

describe('job-search WebMCP route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('requires an authenticated user before reading or mutating', async () => {
    const { GET, POST } = await import('./+server');

    const getResponse = await GET(
      event({ action: 'browse', user: null }) as never,
    );
    const postResponse = await POST(
      event({
        action: 'import',
        body: {},
        method: 'POST',
        user: null,
      }) as never,
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mocks.browse).not.toHaveBeenCalled();
    expect(mocks.importOpportunity).not.toHaveBeenCalled();
  });

  it('maps browse query parameters to the bounded read service', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({ action: 'browse', query: '?query=platform&limit=5' }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.browse).toHaveBeenCalledWith(
      { limit: '5', query: 'platform' },
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
  });

  it('serves one triage candidate through the same bounded context read', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({
        action: 'next-triage-candidate',
        query: '?offset=2&workMode=remote',
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.nextTriageCandidate).toHaveBeenCalledWith(
      { offset: '2', workMode: 'remote' },
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
    await expect(response.json()).resolves.toMatchObject({ position: 1 });
  });

  it('refuses a triage candidate read without opportunity-read permission', async () => {
    const { GET } = await import('./+server');

    const refused = await GET(
      event({
        action: 'next-triage-candidate',
        permissions: without('opportunities.read'),
      }) as never,
    );

    expect(refused.status).toBe(403);
  });

  it('rejects a triage candidate argument outside the published schema', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({
        action: 'next-triage-candidate',
        query: '?decision=unsorted',
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.nextTriageCandidate).not.toHaveBeenCalled();
  });

  it('records the maybe verdict and queues the deep dive as the owner', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };

    const response = await POST(
      event({
        action: 'dig-deeper',
        body: { opportunityId, reason: 'Worth a look.' },
        method: 'POST',
        user: actor,
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.digDeeper).toHaveBeenCalledWith(
      { opportunityId, reason: 'Worth a look.' },
      actor,
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
    await expect(response.json()).resolves.toMatchObject({
      humanReviewStatus: 'maybe',
    });
  });

  it.each([
    'companies.read',
    'opportunities.read',
    'workflow.application.review',
  ])('refuses dig-deeper without %s, rather than half-queuing the deep dive', async (permission) => {
    const { POST } = await import('./+server');

    const refused = await POST(
      event({
        action: 'dig-deeper',
        body: { opportunityId },
        method: 'POST',
        permissions: without(permission),
      }) as never,
    );

    expect(refused.status).toBe(403);
    expect(mocks.digDeeper).not.toHaveBeenCalled();
  });

  it('rejects a dig-deeper argument outside the published schema', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event({
        action: 'dig-deeper',
        body: { decision: 'apply', opportunityId },
        method: 'POST',
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.digDeeper).not.toHaveBeenCalled();
  });

  it('audits every tool execution as the owner on behalf of the owner', async () => {
    const { GET } = await import('./+server');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await GET(event({ action: 'browse' }) as never);

    const entries = info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        action: 'webmcp.job_search_browse_opportunities',
        actorUserId: 'user-1',
        agentClass: 'iolaus/owner',
        event: 'owner_principal.audit',
        metadata: { tool: 'job_search_browse_opportunities' },
        onBehalfOfUserId: 'user-1',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('maps bounded source health and crawl status reads with source permissions', async () => {
    const { GET } = await import('./+server');

    const health = await GET(
      event({
        action: 'source-health',
        permissions: ['sources.read', 'sourcecrawls.read'],
        query: '?query=greenhouse&limit=5&historyLimit=3',
      }) as never,
    );
    const status = await GET(
      event({
        action: 'source-crawl-status',
        permissions: ['sources.read', 'sourcecrawls.read'],
        query: '?sourceId=11111111-1111-4111-8111-111111111111&limit=2',
      }) as never,
    );
    const refused = await GET(
      event({
        action: 'source-crawl-status',
        permissions: ['sources.read'],
        query: '?sourceId=11111111-1111-4111-8111-111111111111&limit=2',
      }) as never,
    );

    expect(health.status).toBe(200);
    expect(status.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(mocks.sourceHealth).toHaveBeenCalledWith({
      historyLimit: '3',
      limit: '5',
      query: 'greenhouse',
    });
    expect(mocks.sourceCrawlStatus).toHaveBeenCalledTimes(1);
    expect(mocks.sourceCrawlStatus).toHaveBeenCalledWith({
      limit: '2',
      sourceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('maps explicit source mutations with the authenticated actor', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };
    const sourceId = '11111111-1111-4111-8111-111111111111';

    const activation = await POST(
      event({
        action: 'set-source-active',
        body: { active: true, reason: 'QA', sourceId },
        method: 'POST',
        user: actor,
      }) as never,
    );
    const crawl = await POST(
      event({
        action: 'crawl-source',
        body: {
          idempotencyKey: 'qa-run-2026-08-31',
          reason: 'QA',
          sourceId,
        },
        method: 'POST',
        user: actor,
      }) as never,
    );

    expect(activation.status).toBe(200);
    expect(crawl.status).toBe(200);
    expect(mocks.setSourceActive).toHaveBeenCalledWith(
      { active: true, reason: 'QA', sourceId },
      actor,
    );
    expect(mocks.crawlSource).toHaveBeenCalledWith(
      { idempotencyKey: 'qa-run-2026-08-31', reason: 'QA', sourceId },
      actor,
    );
  });

  it('creates one validated root source as the owner without a crawl request', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };

    const response = await POST(
      event({
        action: 'create-source',
        body: {
          name: 'OpenAI Careers',
          provider: 'ashby',
          url: 'https://jobs.ashbyhq.com/openai',
        },
        method: 'POST',
        user: actor,
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.createSource).toHaveBeenCalledWith(
      {
        name: 'OpenAI Careers',
        provider: 'ashby',
        url: 'https://jobs.ashbyhq.com/openai',
      },
      actor,
    );
    expect(mocks.crawlSource).not.toHaveBeenCalled();
  });

  it('refuses a source creation without source-create permission', async () => {
    const { POST } = await import('./+server');
    const response = await POST(
      event({
        action: 'create-source',
        body: {
          name: 'OpenAI Careers',
          provider: 'ashby',
          url: 'https://jobs.ashbyhq.com/openai',
        },
        method: 'POST',
        permissions: without('sources.create'),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.createSource).not.toHaveBeenCalled();
  });

  it('refuses crawl enqueue when a downstream write permission is absent', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event({
        action: 'crawl-source',
        body: {
          idempotencyKey: 'qa-run-2026-08-31',
          reason: 'QA',
          sourceId: '11111111-1111-4111-8111-111111111111',
        },
        method: 'POST',
        permissions: without('opportunities.create'),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(mocks.crawlSource).not.toHaveBeenCalled();
  });

  it('refuses source activation without the sources update permission', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event({
        action: 'set-source-active',
        body: {
          active: true,
          reason: 'QA',
          sourceId: '11111111-1111-4111-8111-111111111111',
        },
        method: 'POST',
        permissions: ['sources.read'],
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.setSourceActive).not.toHaveBeenCalled();
  });

  it('maps a decision mutation with the authenticated actor', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };

    const response = await POST(
      event({
        action: 'record-decision',
        body: { decision: 'maybe', opportunityId },
        method: 'POST',
        user: actor,
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      { decision: 'maybe', opportunityId },
      actor,
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
  });

  it('forbids reads and mutations when the session holds no operation permissions', async () => {
    const { GET, POST } = await import('./+server');

    const getResponse = await GET(
      event({ action: 'browse', permissions: [] }) as never,
    );
    const postResponse = await POST(
      event({
        action: 'open-application',
        body: { opportunityId },
        method: 'POST',
        permissions: [],
      }) as never,
    );

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(mocks.browse).not.toHaveBeenCalled();
    expect(mocks.openApplication).not.toHaveBeenCalled();
  });

  it('forbids execution without a tenant even when permissions are present', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({ action: 'browse', tenantId: null }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.browse).not.toHaveBeenCalled();
  });

  it('requires the declared inspection capability before returning opportunity context', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({
        action: 'browse',
        permissions: without('workflow.application.inspect'),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.browse).not.toHaveBeenCalled();
  });

  it('requires the declared review capability for decisions and rejects untrimmed values', async () => {
    const { POST } = await import('./+server');

    const untrimmed = await POST(
      event({
        action: 'record-decision',
        body: { decision: ' apply ', opportunityId },
        method: 'POST',
      }) as never,
    );
    expect(untrimmed.status).toBe(400);
    expect((await untrimmed.json()).error).toBe(
      'Invalid arguments for job_search_record_decision: property "decision" must be one of "apply", "maybe", "reject"',
    );

    const refused = await POST(
      event({
        action: 'record-decision',
        body: { decision: 'apply', opportunityId },
        method: 'POST',
        permissions: without('workflow.application.review'),
      }) as never,
    );
    const maybe = await POST(
      event({
        action: 'record-decision',
        body: { decision: 'maybe', opportunityId },
        method: 'POST',
        permissions: without('workflow.application.review'),
      }) as never,
    );

    expect(refused.status).toBe(403);
    expect(maybe.status).toBe(403);
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied profile authority hint', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event({
        action: 'record-decision',
        body: {
          decision: 'maybe',
          opportunityId,
          reviewedByProfileId: '11111111-1111-4111-8111-111111111111',
        },
        method: 'POST',
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('reviewedByProfileId'),
    });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('requires the declared preparation capability before opening an application', async () => {
    const { POST } = await import('./+server');

    const refused = await POST(
      event({
        action: 'open-application',
        body: { opportunityId },
        method: 'POST',
        permissions: without('workflow.application.prepare'),
      }) as never,
    );

    expect(refused.status).toBe(403);
    expect(mocks.openApplication).not.toHaveBeenCalled();
  });

  it('inspects one opportunity only with the declared inspection capability', async () => {
    const { GET } = await import('./+server');

    const allowed = await GET(
      event({
        action: 'inspect',
        query: `?opportunityId=${opportunityId}`,
      }) as never,
    );
    const refused = await GET(
      event({
        action: 'inspect',
        permissions: without('workflow.application.inspect'),
        query: `?opportunityId=${opportunityId}`,
      }) as never,
    );

    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).toHaveBeenCalledWith(
      { opportunityId },
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
  });

  it.each([
    {
      action: 'set-source-active',
      body: {
        active: true,
        reason: 'QA',
        sourceId: '11111111-1111-4111-8111-111111111111',
      },
      handler: 'setSourceActive',
    },
    {
      action: 'crawl-source',
      body: {
        idempotencyKey: 'qa-run-2026-08-31',
        reason: 'QA',
        sourceId: '11111111-1111-4111-8111-111111111111',
      },
      handler: 'crawlSource',
    },
    {
      action: 'import',
      body: { url: 'https://jobs.example.com/roles/1' },
      handler: 'importOpportunity',
    },
    {
      action: 'verify-posting',
      body: { opportunityId },
      handler: 'verifyPosting',
    },
  ] as const)('refuses $action without the declared audit capability', async ({
    action,
    body,
    handler,
  }) => {
    const { POST } = await import('./+server');

    const refused = await POST(
      event({
        action,
        body,
        method: 'POST',
        permissions: without('workflow.audit.record'),
      }) as never,
    );

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Forbidden' });
    expect(mocks[handler]).not.toHaveBeenCalled();

    const allowed = await POST(
      event({ action, body, method: 'POST' }) as never,
    );

    expect(allowed.status).toBe(200);
    expect(mocks[handler]).toHaveBeenCalledTimes(1);
  });

  it('does not require the audit capability for a decision workflow', async () => {
    const { POST } = await import('./+server');

    for (const decision of ['maybe', 'reject']) {
      const response = await POST(
        event({
          action: 'record-decision',
          body: { decision, opportunityId },
          method: 'POST',
          permissions: without('workflow.audit.record'),
        }) as never,
      );
      expect(response.status, decision).toBe(200);
    }
    expect(mocks.recordDecision).toHaveBeenCalledTimes(2);
  });

  it('verifies a posting as the owner and requires the audit capability', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };

    const allowed = await POST(
      event({
        action: 'verify-posting',
        body: { opportunityId },
        method: 'POST',
        user: actor,
      }) as never,
    );
    const refused = await POST(
      event({
        action: 'verify-posting',
        body: { opportunityId },
        method: 'POST',
        permissions: without('workflow.audit.record'),
        user: actor,
      }) as never,
    );
    const noOverride = await POST(
      event({
        action: 'verify-posting',
        body: { opportunityId, preflightOverrideReason: 'trust me' },
        method: 'POST',
        user: actor,
      }) as never,
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ preflight: { state: 'live' } });
    expect(refused.status).toBe(403);
    // An override reason is not in the published schema, so the route rejects
    // it by name before the handler runs. The audit entry records the tool only.
    expect(noOverride.status).toBe(400);
    expect(await noOverride.json()).toEqual({
      error:
        'Invalid arguments for job_search_verify_posting: unexpected property "preflightOverrideReason"',
      details: [
        {
          code: 'unexpected_property',
          message: 'unexpected property "preflightOverrideReason"',
          path: 'preflightOverrideReason',
        },
      ],
    });
    expect(mocks.verifyPosting).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPosting).toHaveBeenCalledWith({ opportunityId }, actor);
    const entries = vi
      .mocked(console.info)
      .mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    expect(entries).toContainEqual(
      expect.objectContaining({
        action: 'webmcp.job_search_verify_posting',
        metadata: { tool: 'job_search_verify_posting' },
      }),
    );
  });

  it('sweeps inactive-source opportunities dry-run-first under owner authority', async () => {
    const { POST } = await import('./+server');
    const actor = { id: 'user-1' };

    const preview = await POST(
      event({
        action: 'sweep',
        body: {},
        method: 'POST',
        user: actor,
      }) as never,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      applied: false,
      count: 3,
      dryRun: true,
    });
    expect(mocks.sweep).toHaveBeenCalledWith({}, actor);

    const applied = await POST(
      event({
        action: 'sweep',
        body: { dryRun: false, notSeenDays: 60 },
        method: 'POST',
        user: actor,
      }) as never,
    );
    expect(applied.status).toBe(200);
    expect(mocks.sweep).toHaveBeenLastCalledWith(
      { dryRun: false, notSeenDays: 60 },
      actor,
    );

    // The write authority gates the dry run too, so an owner who cannot
    // archive never receives a count.
    for (const denied of [
      'opportunities.read',
      'opportunities.update',
      'sources.read',
      'workflow.audit.record',
    ]) {
      const refused = await POST(
        event({
          action: 'sweep',
          body: {},
          method: 'POST',
          permissions: without(denied),
          user: actor,
        }) as never,
      );
      expect(refused.status, denied).toBe(403);
    }

    const invalid = await POST(
      event({
        action: 'sweep',
        body: { notSeenDays: 0, status: 'found' },
        method: 'POST',
        user: actor,
      }) as never,
    );
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as {
      details: { path: string }[];
      error: string;
    };
    expect(body.error).toContain('job_search_sweep_opportunities');
    expect(body.details.map((detail) => detail.path).sort()).toEqual([
      'notSeenDays',
      'status',
    ]);
    expect(mocks.sweep).toHaveBeenCalledTimes(2);

    const entries = vi
      .mocked(console.info)
      .mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    expect(entries).toContainEqual(
      expect.objectContaining({
        action: 'webmcp.job_search_sweep_opportunities',
        metadata: { tool: 'job_search_sweep_opportunities' },
      }),
    );
  });

  it('inspects one application only with the declared inspection capability', async () => {
    const { GET } = await import('./+server');

    const allowed = await GET(
      event({
        action: 'inspect-application',
        query: `?applicationId=${applicationId}`,
      }) as never,
    );
    expect(allowed.status).toBe(200);
    expect(mocks.inspectApplication).toHaveBeenCalledWith({
      applicationId,
    });

    for (const denied of ['workflow.application.inspect']) {
      const refused = await GET(
        event({
          action: 'inspect-application',
          permissions: without(denied),
          query: `?applicationId=${applicationId}`,
        }) as never,
      );
      expect(refused.status, denied).toBe(403);
    }
    expect(mocks.inspectApplication).toHaveBeenCalledTimes(1);
  });

  it('propagates a not-found application from the bounded read', async () => {
    const { error } = await import('@sveltejs/kit');
    mocks.inspectApplication.mockImplementationOnce(async () =>
      error(404, 'Application not found.'),
    );
    const { GET } = await import('./+server');

    await expect(
      GET(
        event({
          action: 'inspect-application',
          query: `?applicationId=${missingApplicationId}`,
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('reads the resume only with the declared profile capability', async () => {
    const { GET } = await import('./+server');

    const allowed = await GET(
      event({ action: 'read-resume', query: '?tailoring=canonical' }) as never,
    );
    expect(allowed.status).toBe(200);
    expect(mocks.readResume).toHaveBeenCalledWith({ tailoring: 'canonical' });

    for (const denied of ['workflow.profile.manage']) {
      const refused = await GET(
        event({
          action: 'read-resume',
          permissions: without(denied),
        }) as never,
      );
      expect(refused.status, denied).toBe(403);
    }
    expect(mocks.readResume).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('passes a bounded profile key through to the resume read', async () => {
    const { GET } = await import('./+server');

    const selected = await GET(
      event({
        action: 'read-resume',
        query: '?tailoring=canonical&profileKey=consulting',
      }) as never,
    );
    expect(selected.status).toBe(200);
    expect(mocks.readResume).toHaveBeenCalledWith({
      profileKey: 'consulting',
      tailoring: 'canonical',
    });

    const oversized = await GET(
      event({
        action: 'read-resume',
        query: `?profileKey=${'x'.repeat(121)}`,
      }) as never,
    );
    expect(oversized.status).toBe(400);
    expect((await oversized.json()).error).toContain('profileKey');
    expect(mocks.readResume).toHaveBeenCalledTimes(1);
  });

  it('propagates an unknown profile key from the bounded resume read', async () => {
    const { error } = await import('@sveltejs/kit');
    mocks.readResume.mockImplementationOnce(async () =>
      error(404, 'Resume profile not found.'),
    );
    const { GET } = await import('./+server');

    await expect(
      GET(
        event({ action: 'read-resume', query: '?profileKey=missing' }) as never,
      ),
    ).rejects.toMatchObject({
      body: { message: 'Resume profile not found.' },
      status: 404,
    });
  });

  it('names both the unexpected and the missing property for a wrong argument key', async () => {
    const { GET } = await import('./+server');

    const response = await GET(
      event({ action: 'inspect', query: `?id=${opportunityId}` }) as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Invalid arguments for job_search_inspect_opportunity: unexpected property "id"; missing required property "opportunityId"',
      details: [
        {
          code: 'unexpected_property',
          message: 'unexpected property "id"',
          path: 'id',
        },
        {
          code: 'missing_required',
          message: 'missing required property "opportunityId"',
          path: 'opportunityId',
        },
      ],
    });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('rejects a POST body carrying a property outside the tool schema', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event({
        action: 'open-application',
        body: { opportunityId, submit: true },
        method: 'POST',
      }) as never,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(
      'Invalid arguments for job_search_open_application: unexpected property "submit"',
    );
    expect(body.details).toEqual([
      {
        code: 'unexpected_property',
        message: 'unexpected property "submit"',
        path: 'submit',
      },
    ]);
    expect(mocks.openApplication).not.toHaveBeenCalled();
  });

  it('coerces declared integers from the query string before validating', async () => {
    const { GET } = await import('./+server');

    const accepted = await GET(
      event({ action: 'browse', query: '?limit=2' }) as never,
    );
    const rejected = await GET(
      event({ action: 'browse', query: '?limit=abc' }) as never,
    );
    const tooLarge = await GET(
      event({ action: 'browse', query: '?limit=26' }) as never,
    );

    expect(accepted.status).toBe(200);
    // The handler still receives the raw query value and applies its own bounds.
    expect(mocks.browse).toHaveBeenCalledWith(
      { limit: '2' },
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe(
      'Invalid arguments for job_search_browse_opportunities: property "limit" must be an integer, received string',
    );
    expect(tooLarge.status).toBe(400);
    expect((await tooLarge.json()).details).toEqual([
      {
        code: 'too_large',
        message: 'property "limit" must be at most 25',
        path: 'limit',
      },
    ]);
    expect(mocks.browse).toHaveBeenCalledTimes(1);
  });

  it('keeps authority denials non-descriptive after arguments validate', async () => {
    const { GET, POST } = await import('./+server');

    const read = await GET(
      event({
        action: 'inspect',
        permissions: [],
        query: `?opportunityId=${opportunityId}`,
      }) as never,
    );
    const write = await POST(
      event({
        action: 'record-decision',
        body: { decision: 'maybe', opportunityId },
        method: 'POST',
        permissions: without('workflow.application.review'),
      }) as never,
    );

    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: 'Forbidden' });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'Forbidden' });
  });

  it('answers unauthenticated invalid arguments with a bare 401', async () => {
    const { GET, POST } = await import('./+server');

    const read = await GET(
      event({ action: 'inspect', query: '?id=x', user: null }) as never,
    );
    const write = await POST(
      event({
        action: 'record-decision',
        body: { id: 'x', decision: 'nope' },
        method: 'POST',
        user: null,
      }) as never,
    );

    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: 'Unauthorized' });
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('rejects unsupported actions and non-object JSON bodies', async () => {
    const { GET, POST } = await import('./+server');

    const unsupported = await GET(event({ action: 'delete-all' }) as never);
    expect(unsupported.status).toBe(404);

    await expect(
      POST(event({ action: 'import', body: [], method: 'POST' }) as never),
    ).rejects.toMatchObject({ status: 400 });
  });
});
