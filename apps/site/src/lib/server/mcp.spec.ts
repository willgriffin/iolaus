import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertMcpWorkflowPayload,
  callMcpTool,
  configuredPublicMcpToolPatterns,
  isPublicMcpTool,
  listMcpTools,
  McpAccessError,
  matchesToolPattern,
} from './mcp';
import { mcpToolOperations } from './mcp-tools';

/**
 * Every generated permission the exercised mutation tools need: the primary
 * write plus the workflow side effects each write runs (task sync, the
 * opportunity re-status of a submitted application, the source re-save).
 */
const ownerPermissions = [
  'applications.read',
  'applications.update',
  'opportunities.read',
  'opportunities.update',
  'resumevariants.create',
  'resumevariants.update',
  'sources.read',
  'sources.update',
  'sourcecrawls.read',
  'tasks.create',
  'tasks.read',
  'tasks.update',
];

const owner = {
  permissions: ownerPermissions,
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
};

function without(...denied: string[]): string[] {
  return ownerPermissions.filter((slug) => !denied.includes(slug));
}

const mcpMocks = vi.hoisted(() => {
  function seedApplications() {
    return new Map<string, Record<string, unknown>>([
      [
        'app-approved',
        {
          approvedAt: '2026-06-04T10:00:00.000Z',
          approvedByUserId: 'user-1',
          finalApprovalAt: '2026-06-04T10:00:00.000Z',
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          id: 'app-approved',
          status: 'approved',
        },
      ],
      [
        'app-approved-new',
        {
          approvedAt: null,
          approvedByUserId: 'user-1',
          finalApprovalAt: '2026-06-04T10:00:00.000Z',
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          id: 'app-approved-new',
          status: 'approved',
        },
      ],
      [
        'app-submitted',
        {
          approvedAt: '2026-06-04T10:00:00.000Z',
          approvedByUserId: 'user-1',
          finalApprovalAt: '2026-06-04T10:00:00.000Z',
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          id: 'app-submitted',
          status: 'submitted',
          submittedAt: '2026-06-04T12:00:00.000Z',
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
      ],
      [
        'app-draft',
        {
          approvedAt: null,
          approvedByUserId: '',
          id: 'app-draft',
          status: 'draft',
        },
      ],
    ]);
  }

  function seedSources() {
    return new Map<string, Record<string, unknown>>([
      [
        'source-1',
        { accountStatus: 'needs_2fa', id: 'source-1', name: 'Greenhouse' },
      ],
    ]);
  }

  function seedOpportunities() {
    return new Map<string, Record<string, unknown>>([
      ['opp-1', { id: 'opp-1', status: 'found', title: 'Platform Engineer' }],
    ]);
  }

  function seedResumeVariants() {
    return new Map<string, Record<string, unknown>>([
      [
        'variant-1',
        {
          id: 'variant-1',
          name: 'Approved variant',
          status: 'generated',
        },
      ],
    ]);
  }

  function seedResumeAssets() {
    return new Map<string, Record<string, unknown>>([
      ['asset-global', { applicationId: '', id: 'asset-global' }],
      ['asset-app', { applicationId: 'app-approved', id: 'asset-app' }],
    ]);
  }

  const state = {
    effectivePermissions: [] as string[],
    applications: seedApplications(),
    generatorHandleToolCall: vi.fn(),
    generatorTools: vi.fn(async () =>
      [
        'application_create',
        'application_update',
        'opportunity_create',
        'opportunity_update',
        'resumevariant_create',
        'resumevariant_update',
        'resumeprofile_list',
        'resumeprofile_update',
        'candidateanswer_list',
        'user_list',
        'source_create',
        'source_update',
        'candidateprofile_list',
        'candidateprofile_update',
        'experience_list',
        'experience_update',
        'achievement_delete',
      ].map((name) => ({
        description: name,
        inputSchema: { properties: {}, type: 'object' },
        name,
      })),
    ),
    opportunities: seedOpportunities(),
    resumeAssets: seedResumeAssets(),
    resumeVariants: seedResumeVariants(),
    sources: seedSources(),
    tasks: [] as Array<
      Record<string, unknown> & { id: string; save: ReturnType<typeof vi.fn> }
    >,
  };

  state.generatorHandleToolCall.mockImplementation(
    async (request: {
      params: { arguments: Record<string, unknown>; name: string };
    }) => {
      const args = request.params.arguments;
      const name = request.params.name;
      const records = name.startsWith('source_')
        ? state.sources
        : name.startsWith('opportunity_')
          ? state.opportunities
          : name.startsWith('resumevariant_')
            ? state.resumeVariants
            : state.applications;
      const id =
        typeof args.id === 'string' && args.id.trim()
          ? args.id
          : `${name}-created`;
      const record = { ...(records.get(id) ?? { id }), ...args, id };
      records.set(id, record);
      return { content: [{ text: JSON.stringify(record), type: 'text' }] };
    },
  );

  return {
    ...state,
    reset() {
      state.applications.clear();
      for (const [id, application] of seedApplications()) {
        state.applications.set(id, application);
      }
      state.sources.clear();
      for (const [id, source] of seedSources()) {
        state.sources.set(id, source);
      }
      state.opportunities.clear();
      for (const [id, opportunity] of seedOpportunities()) {
        state.opportunities.set(id, opportunity);
      }
      state.resumeVariants.clear();
      for (const [id, variant] of seedResumeVariants()) {
        state.resumeVariants.set(id, variant);
      }
      state.resumeAssets.clear();
      for (const [id, asset] of seedResumeAssets()) {
        state.resumeAssets.set(id, asset);
      }
      state.tasks.length = 0;
      state.generatorHandleToolCall.mockClear();
      state.generatorTools.mockClear();
    },
  };
});

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

vi.mock('@happyvertical/smrt-core/generators/mcp', () => {
  function MockMCPGenerator(this: {
    generateTools: typeof mcpMocks.generatorTools;
    handleToolCall: typeof mcpMocks.generatorHandleToolCall;
  }) {
    this.generateTools = mcpMocks.generatorTools;
    this.handleToolCall = mcpMocks.generatorHandleToolCall;
  }

  return { MCPGenerator: vi.fn(MockMCPGenerator) };
});

vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: ':memory:' })),
  getCollection: vi.fn(async (className: string) => {
    if (className === 'Task') {
      return {
        create: vi.fn(async (payload: Record<string, unknown>) => {
          const created = {
            id: `task-${mcpMocks.tasks.length + 1}`,
            save: vi.fn(async () => {}),
            ...payload,
          };
          mcpMocks.tasks.push(created);
          return created;
        }),
        get: vi.fn(
          async (id: string) =>
            mcpMocks.tasks.find((task) => task.id === id) ?? null,
        ),
        list: vi.fn(
          async ({ where }: { where?: Record<string, unknown> } = {}) =>
            where
              ? mcpMocks.tasks.filter((task) =>
                  Object.entries(where).every(
                    ([key, value]) => task[key] === value,
                  ),
                )
              : mcpMocks.tasks,
        ),
      };
    }

    if (className === 'Application') {
      return {
        get: vi.fn(async (id: string) => mcpMocks.applications.get(id) ?? null),
      };
    }

    if (className === 'Source') {
      return {
        get: vi.fn(async (id: string) => mcpMocks.sources.get(id) ?? null),
      };
    }

    if (className === 'ResumeAsset') {
      return {
        get: vi.fn(async (id: string) => mcpMocks.resumeAssets.get(id) ?? null),
      };
    }

    if (className === 'Tag') {
      return {
        list: vi.fn(async () => [
          {
            context: 'skill',
            id: 'tag-ts',
            name: 'TypeScript',
            slug: 'typescript',
          },
          { context: 'skill', id: 'tag-sv', name: 'Svelte', slug: 'svelte' },
          {
            context: 'domain',
            id: 'tag-ops',
            name: 'Operations',
            slug: 'operations',
          },
        ]),
      };
    }

    if (className === 'CandidateProfile') {
      return {
        get: vi.fn(async (id: string) =>
          id === 'profile-1'
            ? {
                active: true,
                id,
                ownerUserId: 'user-1',
                tenantId: 'tenant-1',
              }
            : null,
        ),
      };
    }

    throw new Error(`Unexpected collection: ${className}`);
  }),
}));

const scheduleMocks = vi.hoisted(() => ({
  syncSourceSchedule: vi.fn(async () => null),
}));
const sourceReadMocks = vi.hoisted(() => ({
  sourceCrawlStatus: vi.fn<() => Promise<Record<string, unknown>>>(
    async () => ({ items: [] }),
  ),
  sourceHealth: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
    items: [],
    providers: [],
  })),
}));
const workflowMocks = vi.hoisted(() => ({
  syncRecommendedOpportunityDecisionTasks: vi.fn(async () => ({
    closed: 0,
    created: 0,
    existing: 0,
    scanned: 0,
  })),
}));
const resumeVariantWorkflowMocks = vi.hoisted(() => ({
  releaseResumeVariantApplicationWrite: vi.fn(async () => ({
    applicationLocksReleased: true,
    workflowTasksSynced: true,
  })),
  reserveResumeVariantApplicationWrite: vi.fn(async () => ({
    reservation: null,
    violation: '',
  })),
  resumeVariantWriteViolation: vi.fn(async () => ''),
  syncResumeVariantApplicationApprovals: vi.fn(async () => ({
    invalidated: 0,
    selected: 0,
  })),
}));
const applicationConcurrencyMocks = vi.hoisted(() => ({
  applicationUpdatesFromPayload: vi.fn(
    (payload: Record<string, unknown>) => payload,
  ),
  commitApplicationIfCurrent: vi.fn(
    async (
      application: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => {
      Object.assign(application, updates);
      return true;
    },
  ),
}));

vi.mock('./source-schedules.js', () => ({
  syncSourceSchedule: scheduleMocks.syncSourceSchedule,
}));

/**
 * Owner-scoped CRUD stand-in. Writes merge into the same seeded record maps
 * the former generator stand-in used, so the approval and workflow tests
 * below keep observing persisted state through the scoped path.
 */
const scopedCrudMocks = vi.hoisted(() => {
  const mapFor = (className: string) =>
    className === 'Application'
      ? mcpMocks.applications
      : className === 'ResumeVariant'
        ? mcpMocks.resumeVariants
        : className === 'ResumeAsset'
          ? mcpMocks.resumeAssets
          : new Map<string, Record<string, unknown>>();
  return {
    createScopedRecord: vi.fn(
      async (className: string, payload: Record<string, unknown>) => {
        const id = `${className.toLowerCase()}_create-created`;
        const record = { ...payload, id };
        mapFor(className).set(id, record);
        return record;
      },
    ),
    deleteScopedRecord: vi.fn(async (className: string, id: string) => {
      mapFor(className).delete(id);
    }),
    getScopedRecord: vi.fn(
      async (className: string, id: string) =>
        mapFor(className).get(id) ?? null,
    ),
    listScopedRecords: vi.fn(async (className: string) => ({
      items: [...mapFor(className).values()],
      limit: 50,
      offset: 0,
      total: mapFor(className).size,
    })),
    updateScopedRecord: vi.fn(
      async (
        className: string,
        id: string,
        payload: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        const records = mapFor(className);
        const record = { ...(records.get(id) ?? { id }), ...payload, id };
        records.set(id, record);
        return record;
      },
    ),
  };
});
vi.mock('./scoped-resource-crud.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scoped-resource-crud.js')>()),
  ...scopedCrudMocks,
}));

const bridgeMocks = vi.hoisted(() => ({
  executeJobSearchTool: vi.fn(async () => ({ items: [] })),
  executeWorkflowTool: vi.fn(async () => ({ status: 'synced' })),
}));
vi.mock('./job-search-tool-dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./job-search-tool-dispatch.js')>()),
  executeJobSearchTool: bridgeMocks.executeJobSearchTool,
}));
vi.mock('./workflow-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workflow-tools.js')>()),
  executeWorkflowTool: bridgeMocks.executeWorkflowTool,
}));

const publicProfileMocks = vi.hoisted(() => ({
  enabled: true,
  getPublicProfileManager: vi.fn(),
  preparePublicProfile: vi.fn(),
  publishPublicProfile: vi.fn(),
  unpublishPublicProfile: vi.fn(),
}));
const hostedMocks = vi.hoisted(() => ({ shared: false }));
vi.mock('./app-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-config.js')>()),
  isSharedHosted: () => hostedMocks.shared,
  publicProfilesEnabled: () => publicProfileMocks.enabled,
}));
vi.mock('./public-profile-service.js', () => ({
  getPublicProfileManager: publicProfileMocks.getPublicProfileManager,
  preparePublicProfile: publicProfileMocks.preparePublicProfile,
  publishPublicProfile: publicProfileMocks.publishPublicProfile,
  unpublishPublicProfile: publicProfileMocks.unpublishPublicProfile,
}));

/** Hook-verified locals as the legacy bridge route now hands them over. */
const ownerLocals = {
  membership: {
    roleId: 'role-1',
    status: 'active',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: ownerPermissions,
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
  workspaceSubject: {
    profileId: 'profile-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
};

vi.mock('./source-webmcp.js', () => ({
  listRootSourceHealth: sourceReadMocks.sourceHealth,
  listSourceCrawlStatus: sourceReadMocks.sourceCrawlStatus,
}));

vi.mock('./application-workflow.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./application-workflow.js')>();
  return {
    ...actual,
    syncRecommendedOpportunityDecisionTasks:
      workflowMocks.syncRecommendedOpportunityDecisionTasks,
  };
});

vi.mock('./application-concurrency.js', () => ({
  applicationUpdatesFromPayload:
    applicationConcurrencyMocks.applicationUpdatesFromPayload,
  commitApplicationIfCurrent:
    applicationConcurrencyMocks.commitApplicationIfCurrent,
}));

vi.mock('./resume-variant-workflow.js', () => ({
  releaseResumeVariantApplicationWrite:
    resumeVariantWorkflowMocks.releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite:
    resumeVariantWorkflowMocks.reserveResumeVariantApplicationWrite,
  resumeVariantWriteViolation:
    resumeVariantWorkflowMocks.resumeVariantWriteViolation,
  syncResumeVariantApplicationApprovals:
    resumeVariantWorkflowMocks.syncResumeVariantApplicationApprovals,
}));

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
        ? mcpMocks.effectivePermissions
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

/** Install this call's explicit live permission fixture, then use the real service. */
function callMcpToolWithAuthorityFixture(
  options: Parameters<typeof callMcpTool>[0],
) {
  mcpMocks.effectivePermissions = [...(options.permissions ?? [])];
  return callMcpTool(options);
}

describe('MCP public tool policy', () => {
  beforeEach(() => {
    mcpMocks.reset();
    resumeVariantWorkflowMocks.resumeVariantWriteViolation.mockReset();
    resumeVariantWorkflowMocks.resumeVariantWriteViolation.mockResolvedValue(
      '',
    );
    resumeVariantWorkflowMocks.releaseResumeVariantApplicationWrite.mockClear();
    resumeVariantWorkflowMocks.reserveResumeVariantApplicationWrite.mockReset();
    resumeVariantWorkflowMocks.reserveResumeVariantApplicationWrite.mockResolvedValue(
      { reservation: null, violation: '' },
    );
    resumeVariantWorkflowMocks.syncResumeVariantApplicationApprovals.mockReset();
    resumeVariantWorkflowMocks.syncResumeVariantApplicationApprovals.mockResolvedValue(
      {
        invalidated: 0,
        selected: 0,
      },
    );
    scheduleMocks.syncSourceSchedule.mockClear();
    workflowMocks.syncRecommendedOpportunityDecisionTasks.mockClear();
    applicationConcurrencyMocks.applicationUpdatesFromPayload.mockClear();
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockReset();
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockImplementation(
      async (application, updates) => {
        Object.assign(application, updates);
        return true;
      },
    );
    sourceReadMocks.sourceHealth.mockReset();
    sourceReadMocks.sourceHealth.mockResolvedValue({
      items: [],
      providers: [],
    });
    sourceReadMocks.sourceCrawlStatus.mockReset();
    sourceReadMocks.sourceCrawlStatus.mockResolvedValue({ items: [] });
  });

  it('keeps private model CRUD out of the generated MCP catalog and adds only bounded source reads', async () => {
    const anonymous = await listMcpTools({ authenticated: false });
    expect(anonymous.map((tool) => tool.name)).not.toContain(
      'job_search_list_source_health',
    );

    const authenticated = await listMcpTools({ authenticated: true });
    const names = authenticated.map((tool) => tool.name);
    // Global source and catalog operations may be generated, but every
    // candidate-owned model stays behind the scoped workspace workflows.
    expect(names).toContain('source_update');
    expect(names).toContain('opportunity_update');
    // The owner-scoped career model (#259) and the public-profile lifecycle.
    expect(names).toContain('experience_update');
    expect(names).toContain('achievement_delete');
    expect(names).toContain('candidateprofile_update');
    expect(names).toContain('public_profile_prepare');
    expect(names).toContain('public_profile_status');
    // Tranche (b): the private workspace rides the same scoped path.
    expect(names).toContain('application_update');
    expect(names).toContain('resumevariant_update');
    expect(names).not.toContain('candidateanswer_list');
    expect(names).not.toContain('resumeprofile_list');
    expect(names).not.toContain('user_list');
    publicProfileMocks.enabled = false;
    try {
      const privateInstall = await listMcpTools({ authenticated: true });
      expect(
        privateInstall.some((tool) => tool.name.startsWith('public_profile_')),
      ).toBe(false);
    } finally {
      publicProfileMocks.enabled = true;
    }
    // Tranche (c): every job_search_* workflow tool rides the legacy bridge
    // so the CLI can call it; the two bounded source reads keep their caps.
    const extensions = authenticated.filter((tool) =>
      tool.name.startsWith('job_search_'),
    );
    expect(extensions.map((tool) => tool.name)).toEqual([
      'job_search_browse_opportunities',
      'job_search_crawl_source',
      'job_search_create_source',
      'job_search_dig_deeper',
      'job_search_import_opportunity',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_list_source_health',
      'job_search_next_triage_candidate',
      'job_search_open_application',
      'job_search_read_resume',
      'job_search_record_decision',
      'job_search_set_source_active',
      'job_search_source_crawl_status',
      'job_search_sweep_opportunities',
      'job_search_verify_posting',
    ]);
    expect(extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              historyLimit: expect.objectContaining({ maximum: 20 }),
              limit: expect.objectContaining({ maximum: 25 }),
              query: expect.objectContaining({ maxLength: 120 }),
            }),
          }),
          name: 'job_search_list_source_health',
        }),
        expect.objectContaining({
          inputSchema: expect.objectContaining({
            anyOf: [{ required: ['crawlId'] }, { required: ['sourceId'] }],
          }),
          name: 'job_search_source_crawl_status',
        }),
      ]),
    );
    for (const name of [
      'opportunity_review',
      'opportunity_assess',
      'recommendation_tasks_sync',
      'recommendation_task_process',
      'company_research_request',
      'fact_intake_create',
      'fact_candidate_accept',
      'application_archive',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('delegates permitted source health reads with the request tenant and permission snapshot', async () => {
    sourceReadMocks.sourceHealth.mockResolvedValueOnce({
      items: [{ id: 'source-1', provider: 'greenhouse' }],
      providers: [{ created: 3, provider: 'greenhouse' }],
    });

    const response = await callMcpToolWithAuthorityFixture({
      arguments: { historyLimit: 20, limit: 25, query: 'greenhouse' },
      name: 'job_search_list_source_health',
      permissions: ['sources.read', 'sourcecrawls.read'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });

    expect(sourceReadMocks.sourceHealth).toHaveBeenCalledWith({
      historyLimit: 20,
      limit: 25,
      query: 'greenhouse',
    });
    expect(response.structuredContent).toEqual({
      items: [{ id: 'source-1', provider: 'greenhouse' }],
      providers: [{ created: 3, provider: 'greenhouse' }],
    });
  });

  it('keeps source read failures, selector validation, and redacted crawl errors on the read-only path', async () => {
    sourceReadMocks.sourceCrawlStatus.mockResolvedValueOnce({
      items: [
        {
          errors: ['authorization=[redacted]', 'https://example.test/path'],
          id: 'crawl-1',
          sourceId: 'source-1',
        },
      ],
      limit: 20,
    });

    const response = await callMcpToolWithAuthorityFixture({
      arguments: {
        limit: 20,
        sourceId: '11111111-1111-4111-8111-111111111111',
      },
      name: 'job_search_source_crawl_status',
      permissions: ['sources.read', 'sourcecrawls.read'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    const text = response.content[0]?.text ?? '';
    expect(text).toContain('authorization=[redacted]');
    expect(text).not.toContain('super-secret');

    sourceReadMocks.sourceCrawlStatus.mockRejectedValueOnce({
      body: { message: 'crawlId or sourceId is required.' },
      status: 400,
    });
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {},
        name: 'job_search_source_crawl_status',
        permissions: ['sources.read', 'sourcecrawls.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      message: 'crawlId or sourceId is required.',
      status: 400,
    });
  });

  it('refuses source reads without both required read permissions', async () => {
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { limit: 1 },
        name: 'job_search_list_source_health',
        permissions: ['sources.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(sourceReadMocks.sourceHealth).not.toHaveBeenCalled();
  });

  it('refuses generated MCP writes the owner principal lacks permission for', async () => {
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { accountStatus: 'needs_2fa', id: 'source-1' },
        name: 'source_update',
        permissions: ['sources.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();

    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { accountStatus: 'needs_2fa', id: 'source-1' },
        name: 'source_update',
        permissions: ['sources.update'],
        tenantId: null,
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
  });

  it('matches exact tool names and simple wildcards', () => {
    expect(
      matchesToolPattern('companyresearch_list', 'companyresearch_list'),
    ).toBe(true);
    expect(
      matchesToolPattern('companyresearch_get', 'companyresearch_list'),
    ).toBe(false);
    expect(matchesToolPattern('companyresearch_get', 'companyresearch_*')).toBe(
      true,
    );
    expect(matchesToolPattern('preferencerule_get', '*_get')).toBe(true);
    expect(matchesToolPattern('opportunity_update', 'opportunity_*')).toBe(
      true,
    );
  });

  it('defaults to no public tools', () => {
    vi.stubEnv('SMRT_PUBLIC_MCP_TOOLS', '');
    expect(configuredPublicMcpToolPatterns()).toEqual([]);
    expect(isPublicMcpTool('companyresearch_list')).toBe(false);
    vi.unstubAllEnvs();
  });

  it('reads public tool patterns from configuration', () => {
    vi.stubEnv(
      'SMRT_PUBLIC_MCP_TOOLS',
      'companyresearch_list,opportunity_get,source_*',
    );
    expect(configuredPublicMcpToolPatterns()).toEqual([
      'companyresearch_list',
      'opportunity_get',
      'source_*',
    ]);
    expect(isPublicMcpTool('companyresearch_list')).toBe(true);
    expect(isPublicMcpTool('source_get')).toBe(true);
    expect(isPublicMcpTool('source_update')).toBe(false);
    expect(isPublicMcpTool('companyresearch_update')).toBe(false);
    vi.unstubAllEnvs();
  });

  it('normalizes MCP agent field payloads before tool execution', async () => {
    const args: Record<string, unknown> = {
      domainTags: ['platform', 'developer tooling'],
      requiredSkills: ' TypeScript \n\nSvelte ',
    };

    await assertMcpWorkflowPayload('opportunity_create', args, {
      id: 'user-1',
    });

    expect(args).toMatchObject({
      domainTags: 'platform\ndeveloper tooling',
      requiredSkills: 'TypeScript\nSvelte',
    });
  });

  it('rejects invalid MCP agent field payloads before tool execution', async () => {
    await expect(
      assertMcpWorkflowPayload(
        'opportunity_create',
        {
          requiredSkills: [{ label: 'TypeScript' }],
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'List fields must contain string, number, or boolean values.',
    );
  });

  it('rejects MCP mutations of AgentRun audit records', async () => {
    await expect(
      assertMcpWorkflowPayload(
        'agentrun_update',
        { id: 'run-1', status: 'failed' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Agent run audit records are system-authored and immutable.',
    );
  });

  it.each([
    'sourcecrawl_update',
    'sourcecrawlitem_delete',
  ])('rejects generic MCP mutation %s of crawl accounting', async (toolName) => {
    await expect(
      assertMcpWorkflowPayload(
        toolName,
        { id: 'accounting-1', outcome: 'pending' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Source crawl accounting records are system-authored and immutable.',
    );
  });

  it('rejects generic MCP writes to application-owned materials', async () => {
    await expect(
      assertMcpWorkflowPayload(
        'resumeasset_update',
        { id: 'asset-app', title: 'Changed after review' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application-owned materials are immutable through generic MCP writes. Regenerate or revise them through the application workflow.',
    );

    await expect(
      assertMcpWorkflowPayload(
        'resumeasset_create',
        { applicationId: 'app-approved', title: 'Bypass material' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application-owned materials are immutable through generic MCP writes. Regenerate or revise them through the application workflow.',
    );
    await expect(
      assertMcpWorkflowPayload(
        'resumeasset_update',
        { applicationId: 'app-approved', id: 'asset-global' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application-owned materials are immutable through generic MCP writes. Regenerate or revise them through the application workflow.',
    );
  });

  it('requires user approval before application approval/submission tools', async () => {
    await expect(
      assertMcpWorkflowPayload('application_create', { status: 'approved' }),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          finalApprovalAt: new Date(),
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          id: 'app-draft',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Final submission approval must be recorded from the application review page.',
    );
    await expect(
      assertMcpWorkflowPayload('application_create', {
        approvedByUserId: '   ',
        status: 'approved',
      }),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload('application_update', {
        approvedByUserId: true,
        id: 'app-approved',
        status: 'submitted',
      }),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload('application_update', {
        id: 'app-approved',
        status: 'missing',
      }),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          approvedByUserId: 'user-2',
          id: 'app-approved',
          status: 'submitted',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          id: 'app-approved',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'fax',
          status: 'submitted',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          id: 'app-approved',
          submissionMethod: 'company_site',
          submissionEvidenceUrl: 'https://example.com/receipt',
          status: 'submitted',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );

    const approvedCreateArgs: Record<string, unknown> = { status: 'approved' };
    await assertMcpWorkflowPayload('application_create', approvedCreateArgs, {
      id: 'user-1',
    });
    expect(approvedCreateArgs.approvedByUserId).toBe('user-1');

    const submittedUpdateArgs: Record<string, unknown> = {
      approvedByUserId: '   ',
      id: 'app-approved-new',
      submissionMethod: 'company_site',
      submissionEvidenceUrl: 'https://example.com/receipt',
      status: 'submitted',
    };
    await expect(
      assertMcpWorkflowPayload('application_update', submittedUpdateArgs, {
        id: 'user-1',
      }),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );

    const matchingApprovalArgs: Record<string, unknown> = {
      approvedByUserId: 'user-1',
      id: 'app-approved',
      submissionMethod: 'company_site',
      submissionEvidenceUrl: 'https://example.com/receipt',
      status: 'submitted',
    };
    await expect(
      assertMcpWorkflowPayload('application_update', matchingApprovalArgs, {
        id: 'user-1',
      }),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );

    await expect(
      assertMcpWorkflowPayload('application_update', {
        approvedByUserId: 'user-1',
        id: 'app-draft',
      }),
    ).rejects.toThrowError(McpAccessError);
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          approvedByUserId: 'user-1',
          id: 'app-draft',
        },
        { id: 'user-2' },
      ),
    ).rejects.toThrowError(McpAccessError);

    const matchingPartialArgs: Record<string, unknown> = {
      approvedByUserId: 'user-1',
      id: 'app-draft',
    };
    await assertMcpWorkflowPayload('application_update', matchingPartialArgs, {
      id: 'user-1',
    });
    expect(matchingPartialArgs.approvedByUserId).toBe('user-1');

    const nonApprovalPartialArgs: Record<string, unknown> = {
      id: 'app-approved',
      notes: 'Refresh notes only',
    };
    await assertMcpWorkflowPayload(
      'application_update',
      nonApprovalPartialArgs,
      { id: 'user-2' },
    );
    expect(nonApprovalPartialArgs).toEqual({
      id: 'app-approved',
      notes: 'Refresh notes only',
    });

    const materialChangeArgs: Record<string, unknown> = {
      id: 'app-approved',
      resumeAssetId: 'resume-new',
    };
    await assertMcpWorkflowPayload('application_update', materialChangeArgs, {
      id: 'user-2',
    });
    expect(materialChangeArgs).toMatchObject({
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      finalApprovalAt: null,
      finalApprovalKind: '',
      finalApprovedByUserId: '',
      resumeAssetId: 'resume-new',
      status: 'awaiting_user',
    });

    const preserveSubmittedApprovalArgs: Record<string, unknown> = {
      approvedByUserId: '',
      id: 'app-submitted',
      notes: 'Refresh notes only',
    };
    await assertMcpWorkflowPayload(
      'application_update',
      preserveSubmittedApprovalArgs,
      {
        id: 'user-1',
      },
    );
    expect(preserveSubmittedApprovalArgs.approvedByUserId).toBe('user-1');

    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          id: 'app-submitted',
          submissionEvidenceUrl: '',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );

    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          id: 'app-submitted',
          packetAssetId: 'packet-new',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Submitted or closed applications cannot have their approved materials changed.',
    );

    await expect(
      assertMcpWorkflowPayload('application_create', { status: 'draft' }),
    ).resolves.toBeUndefined();
  });

  it('uses the persisted application status to reject unsafe MCP update jumps', async () => {
    await expect(
      assertMcpWorkflowPayload(
        'application_update',
        {
          id: 'app-draft',
          status: 'submitted',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Application submission must be recorded from the application review page.',
    );
  });

  it('rejects invalid MCP source account status before generated execution', async () => {
    const args: Record<string, unknown> = {
      accountStatus: 'needs_magic',
      id: 'source-1',
    };
    await expect(
      assertMcpWorkflowPayload('source_update', args, { id: 'user-1' }),
    ).rejects.toThrowError('Invalid account status.');

    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    expect(mcpMocks.sources.get('source-1')).toMatchObject({
      accountStatus: 'needs_2fa',
    });
    expect(scheduleMocks.syncSourceSchedule).not.toHaveBeenCalled();
  });

  it('rejects non-object MCP tool arguments before calling the generator', async () => {
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: [],
        name: 'source_update',
        ...owner,
      }),
    ).rejects.toThrowError('MCP tool arguments must be a JSON object.');

    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    expect(scheduleMocks.syncSourceSchedule).not.toHaveBeenCalled();
  });

  it('maps only global generated operations and bounded source-read permissions', () => {
    const slugs = (name: string) =>
      (mcpToolOperations(name) ?? []).map(
        (operation) => `${operation.collection}.${operation.action}`,
      );

    expect(slugs('source_update')).toEqual([
      'sources.update',
      'sources.read',
      'tasks.read',
      'tasks.create',
      'tasks.update',
    ]);
    expect(slugs('opportunity_update')).toEqual(['opportunities.update']);
    // Candidate-owned classes assert the curated profile capability the
    // hosted member role actually holds, never a generated CRUD grant.
    expect(slugs('experience_update')).toEqual(['workflow.profile.manage']);
    expect(slugs('experience_list')).toEqual(['workflow.profile.manage']);
    expect(slugs('candidateprofile_update')).toEqual([
      'workflow.profile.manage',
    ]);
    expect(slugs('public_profile_publish')).toEqual([
      'workflow.public-profile.manage',
    ]);
    expect(slugs('tag_lookup')).toEqual(['workflow.profile.manage']);
    expect(slugs('job_search_list_source_health')).toEqual([
      'sources.read',
      'sourcecrawls.read',
    ]);
    expect(slugs('application_update')).toEqual(['workflow.profile.manage']);
    expect(slugs('resumevariant_update')).toEqual(['workflow.profile.manage']);
    expect(mcpToolOperations('candidateanswer_list')).toBeNull();
    expect(mcpToolOperations('resumeprofile_update')).toBeNull();
    expect(mcpToolOperations('resumeposition_list')).toBeNull();
  });

  it('runs career-model tools through the owner-scoped CRUD, never the generator', async () => {
    for (const mock of Object.values(scopedCrudMocks)) mock.mockClear();
    scopedCrudMocks.updateScopedRecord.mockResolvedValueOnce({
      id: 'exp-1',
      summary: 'Scoped',
    });
    const response = await callMcpToolWithAuthorityFixture({
      arguments: { id: 'exp-1', summary: 'Scoped' },
      locals: ownerLocals,
      name: 'experience_update',
      permissions: ['workflow.profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(response.structuredContent).toEqual({
      id: 'exp-1',
      summary: 'Scoped',
    });
    expect(scopedCrudMocks.updateScopedRecord).toHaveBeenCalledWith(
      'Experience',
      'exp-1',
      { summary: 'Scoped' },
    );
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();

    scopedCrudMocks.listScopedRecords.mockResolvedValueOnce({
      items: [{ id: 'exp-1' }],
      limit: 10,
      offset: 0,
      total: 1,
    });
    const listed = await callMcpToolWithAuthorityFixture({
      arguments: { limit: 10, where: { ownerUserId: 'someone-else' } },
      locals: ownerLocals,
      name: 'experience_list',
      permissions: ['workflow.profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(listed.structuredContent).toMatchObject({
      data: [{ id: 'exp-1' }],
      meta: { count: 1, limit: 10, offset: 0, total: 1 },
    });
    // The caller filter reaches the scoped list, which merges the owner
    // tuple over it; the generator (which would honour it) is never used.
    expect(scopedCrudMocks.listScopedRecords).toHaveBeenCalledWith(
      'Experience',
      expect.objectContaining({ where: { ownerUserId: 'someone-else' } }),
    );
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();

    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { id: 'exp-1', summary: 'Denied' },
        locals: ownerLocals,
        name: 'experience_update',
        permissions: ['experiences.update', 'opportunities.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(scopedCrudMocks.updateScopedRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects CandidateProfile fields outside the agent contract before the scoped write', async () => {
    for (const mock of Object.values(scopedCrudMocks)) mock.mockClear();
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { id: 'profile-1', ownerUserId: 'user-2', summary: 'x' },
        locals: ownerLocals,
        name: 'candidateprofile_update',
        permissions: ['workflow.profile.manage'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(scopedCrudMocks.updateScopedRecord).not.toHaveBeenCalled();
  });

  it('dispatches the public-profile lifecycle tools to the page service with the verified locals', async () => {
    publicProfileMocks.preparePublicProfile.mockResolvedValueOnce({
      baseRevision: 2,
      handle: 'synthetic-nurse',
      id: 'f32dcdee-f946-4a2f-a735-409617081d12',
      pdfBytes: 1234,
      snapshot: { name: 'Synthetic Nurse' },
    });
    const prepareArgs = {
      handle: 'synthetic-nurse',
      profileId: 'profile-1',
      visibility: {
        contacts: { email: false, links: true, location: false, phone: false },
        sections: {
          education: true,
          experience: true,
          other: false,
          skills: true,
        },
      },
    };
    const prepared = await callMcpToolWithAuthorityFixture({
      arguments: prepareArgs,
      locals: ownerLocals,
      name: 'public_profile_prepare',
      permissions: ['workflow.public-profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(publicProfileMocks.preparePublicProfile).toHaveBeenCalledWith(
      ownerLocals,
      prepareArgs,
    );
    expect(prepared.structuredContent).toMatchObject({
      baseRevision: 2,
      pdfBytes: 1234,
      previewUrl:
        '/admin/career/public-profile/preview/f32dcdee-f946-4a2f-a735-409617081d12',
      revisionId: 'f32dcdee-f946-4a2f-a735-409617081d12',
    });

    publicProfileMocks.publishPublicProfile.mockResolvedValueOnce({
      revision: 3,
    });
    const published = await callMcpToolWithAuthorityFixture({
      arguments: {
        expectedRevision: 2,
        revisionId: 'f32dcdee-f946-4a2f-a735-409617081d12',
      },
      locals: ownerLocals,
      name: 'public_profile_publish',
      permissions: ['workflow.public-profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(published.structuredContent).toEqual({
      published: true,
      revision: 3,
    });

    publicProfileMocks.getPublicProfileManager.mockResolvedValueOnce({
      identity: null,
      prepared: null,
      profiles: [],
      publicUrl: null,
    });
    const status = await callMcpToolWithAuthorityFixture({
      arguments: {},
      locals: ownerLocals,
      name: 'public_profile_status',
      permissions: ['workflow.public-profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(status.structuredContent).toEqual({
      identity: null,
      prepared: null,
      profiles: [],
      publicUrl: null,
    });

    // The page capability is required; nothing runs without it.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { expectedRevision: 3 },
        locals: ownerLocals,
        name: 'public_profile_unpublish',
        permissions: ['opportunities.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(publicProfileMocks.unpublishPublicProfile).not.toHaveBeenCalled();

    // Without hook-verified locals (no workspace subject) the tool refuses.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {},
        name: 'public_profile_status',
        permissions: ['workflow.public-profile.manage'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('resolves an application update through the owner once: a foreign row is a 404 before any guard, and the guards and the commit share one snapshot', async () => {
    hostedMocks.shared = true;
    try {
      // `app-submitted` carries no owner tuple: another owner's row in the
      // same tenant. A scope change would otherwise hit the "locked
      // materials" guard and disclose its state.
      await expect(
        callMcpToolWithAuthorityFixture({
          arguments: { id: 'app-submitted', resumeAssetId: 'asset-global' },
          locals: ownerLocals,
          name: 'application_update',
          permissions: ['workflow.profile.manage'],
          tenantId: 'tenant-1',
          user: { id: 'user-1' },
        }),
      ).rejects.toMatchObject({
        message: 'Application not found.',
        status: 404,
      });
      expect(
        applicationConcurrencyMocks.commitApplicationIfCurrent,
      ).not.toHaveBeenCalled();
      expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();

      // The owner's own draft: guards and commit run on the same object the
      // scoped lookup returned.
      const owned = {
        ...(mcpMocks.applications.get('app-draft') as Record<string, unknown>),
        candidateProfileId: 'profile-1',
        ownerUserId: 'user-1',
        tenantId: 'tenant-1',
      };
      mcpMocks.applications.set('app-draft', owned);
      const response = await callMcpToolWithAuthorityFixture({
        arguments: { id: 'app-draft', notes: 'Scoped update' },
        locals: ownerLocals,
        name: 'application_update',
        permissions: ['workflow.profile.manage'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      });
      expect(
        applicationConcurrencyMocks.commitApplicationIfCurrent,
      ).toHaveBeenCalledTimes(1);
      expect(
        applicationConcurrencyMocks.commitApplicationIfCurrent.mock.calls[0][0],
      ).toBe(mcpMocks.applications.get('app-draft'));
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        id: 'app-draft',
        notes: 'Scoped update',
      });
    } finally {
      hostedMocks.shared = false;
    }
  });

  it('bridges job_search_* tools to the CLI with the route’s operation sets and published schemas', async () => {
    bridgeMocks.executeJobSearchTool.mockClear();
    const slugs = (name: string) =>
      (mcpToolOperations(name) ?? []).map(
        (operation) => `${operation.collection}.${operation.action}`,
      );
    expect(slugs('job_search_browse_opportunities')).toEqual([
      'companies.read',
      'opportunities.read',
      'workflow.application.inspect',
    ]);
    expect(slugs('job_search_open_application')).toEqual([
      'companies.read',
      'opportunities.read',
      'workflow.application.prepare',
    ]);
    const response = await callMcpToolWithAuthorityFixture({
      arguments: { limit: 2 },
      locals: ownerLocals,
      name: 'job_search_browse_opportunities',
      permissions: [
        'companies.read',
        'opportunities.read',
        'workflow.application.inspect',
      ],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(response.structuredContent).toEqual({ items: [] });
    expect(bridgeMocks.executeJobSearchTool).toHaveBeenCalledWith(
      'job_search_browse_opportunities',
      { limit: 2 },
      expect.objectContaining({ locals: ownerLocals, user: { id: 'user-1' } }),
    );
    // Published schema enforced before execution; an unknown argument is 400.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { bogus: true },
        locals: ownerLocals,
        name: 'job_search_browse_opportunities',
        permissions: [
          'companies.read',
          'opportunities.read',
          'workflow.application.inspect',
        ],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    // The route's permission set is asserted on the bridge as well.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {},
        locals: ownerLocals,
        name: 'job_search_browse_opportunities',
        permissions: ['companies.read', 'opportunities.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(bridgeMocks.executeJobSearchTool).toHaveBeenCalledTimes(1);
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
  });

  it('runs the owner workflow tools under the capabilities their form actions assert', async () => {
    bridgeMocks.executeWorkflowTool.mockClear();
    const slugs = (name: string, args: Record<string, unknown> = {}) =>
      (mcpToolOperations(name, args) ?? []).map(
        (operation) => `${operation.collection}.${operation.action}`,
      );
    expect(slugs('opportunity_review')).toEqual([
      'workflow.application.review',
    ]);
    expect(slugs('recommendation_tasks_sync')).toEqual(['workflow.task.sync']);
    expect(
      slugs('recommendation_task_process', { decision: 'reject' }),
    ).toEqual(['workflow.application.review', 'workflow.task.sync']);
    expect(
      slugs('recommendation_task_process', { decision: 'accept_to_apply' }),
    ).toEqual([
      'workflow.application.review',
      'workflow.task.sync',
      'workflow.application.prepare',
    ]);
    // A padded or unknown decision never reaches the accept branch without
    // the prepare capability: the schema is an enum and the permission set
    // and the service see the same canonical value.
    expect(
      slugs('recommendation_task_process', { decision: ' accept_to_apply' }),
    ).toEqual(['workflow.application.review', 'workflow.task.sync']);
    expect(slugs('application_archive')).toEqual([
      'workflow.application.review',
      'workflow.task.sync',
    ]);
    expect(slugs('fact_intake_create')).toEqual(['workflow.profile.manage']);
    expect(slugs('company_research_request')).toEqual([
      'companies.read',
      'companies.update',
      'sources.read',
      'sources.create',
      'tasks.read',
      'tasks.create',
      'tasks.update',
    ]);

    const response = await callMcpToolWithAuthorityFixture({
      arguments: {},
      locals: ownerLocals,
      name: 'recommendation_tasks_sync',
      permissions: ['workflow.task.sync'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(response.structuredContent).toEqual({ status: 'synced' });
    expect(bridgeMocks.executeWorkflowTool).toHaveBeenCalledWith(
      'recommendation_tasks_sync',
      {},
      { id: 'user-1' },
    );
    // Accepting a recommendation needs the prepare capability too.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { decision: 'accept_to_apply', taskId: 'task-1' },
        locals: ownerLocals,
        name: 'recommendation_task_process',
        permissions: ['workflow.application.review', 'workflow.task.sync'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { decision: ' accept_to_apply', taskId: 'task-1' },
        locals: ownerLocals,
        name: 'recommendation_task_process',
        permissions: ['workflow.application.review', 'workflow.task.sync'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { companyId: 'co-1' },
        locals: ownerLocals,
        name: 'company_research_request',
        permissions: [
          'companies.read',
          'sources.read',
          'sources.create',
          'tasks.read',
          'tasks.create',
          'tasks.update',
        ],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: { humanReviewStatus: 'maybe' },
        locals: ownerLocals,
        name: 'opportunity_review',
        permissions: ['workflow.application.review'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(bridgeMocks.executeWorkflowTool).toHaveBeenCalledTimes(1);
    // Without hook-verified locals the tools refuse before any execution.
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {},
        name: 'recommendation_tasks_sync',
        permissions: ['workflow.task.sync'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('looks up the shared tag vocabulary read-only under the profile capability', async () => {
    const result = await callMcpToolWithAuthorityFixture({
      arguments: { limit: 1, query: 'sv' },
      locals: ownerLocals,
      name: 'tag_lookup',
      permissions: ['workflow.profile.manage'],
      tenantId: 'tenant-1',
      user: { id: 'user-1' },
    });
    expect(result.structuredContent).toEqual({
      items: [
        { context: 'skill', id: 'tag-sv', name: 'Svelte', slug: 'svelte' },
      ],
      limit: 1,
      query: 'sv',
      scanned: 3,
      truncated: false,
    });
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {},
        locals: ownerLocals,
        name: 'tag_lookup',
        permissions: ['opportunities.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(
      (await listMcpTools({ authenticated: false })).map((t) => t.name),
    ).not.toContain('tag_lookup');
  });

  it('maps public-profile service failures to the bridge error contract', async () => {
    const { PublicProfileStoreError } = await import(
      './public-profile-store.js'
    );
    publicProfileMocks.publishPublicProfile.mockRejectedValueOnce(
      new PublicProfileStoreError('conflict', 'Publication changed.'),
    );
    await expect(
      callMcpToolWithAuthorityFixture({
        arguments: {
          expectedRevision: 1,
          revisionId: 'f32dcdee-f946-4a2f-a735-409617081d12',
        },
        locals: ownerLocals,
        name: 'public_profile_publish',
        permissions: ['workflow.public-profile.manage'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Publication changed.', status: 409 });
  });

  it('rejects legacy private CRUD before authorization or execution', async () => {
    for (const name of [
      'resumeprofile_list',
      'resumeprofile_update',
      'resumeposition_list',
      'candidateanswer_list',
    ]) {
      await expect(
        callMcpToolWithAuthorityFixture({
          arguments: { id: 'private-record' },
          name,
          user: { id: 'user-1' },
        }),
      ).rejects.toMatchObject({
        message: `Unknown MCP tool: ${name}`,
        status: 404,
      });
    }
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
  });
});
