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

  it('lists only the two bounded source-read extensions for authenticated MCP clients', async () => {
    const anonymous = await listMcpTools({ authenticated: false });
    expect(anonymous.map((tool) => tool.name)).not.toContain(
      'job_search_list_source_health',
    );

    const authenticated = await listMcpTools({ authenticated: true });
    const names = authenticated.map((tool) => tool.name);
    // Decorator `mcp` includes decide which generated tools survive the filter.
    expect(names).toContain('resumeprofile_list');
    expect(names).toContain('resumeprofile_update');
    expect(names).not.toContain('candidateanswer_list');
    expect(names).not.toContain('user_list');
    const extensions = authenticated.filter((tool) =>
      tool.name.startsWith('job_search_'),
    );
    expect(extensions.map((tool) => tool.name)).toEqual([
      'job_search_list_source_health',
      'job_search_source_crawl_status',
    ]);
    expect(extensions).toMatchObject([
      {
        inputSchema: {
          properties: {
            historyLimit: { maximum: 20 },
            limit: { maximum: 25 },
            query: { maxLength: 120 },
          },
        },
        name: 'job_search_list_source_health',
      },
      {
        inputSchema: {
          anyOf: [{ required: ['crawlId'] }, { required: ['sourceId'] }],
          properties: { limit: { maximum: 20 } },
        },
        name: 'job_search_source_crawl_status',
      },
    ]);
  });

  it('delegates permitted source health reads with the request tenant and permission snapshot', async () => {
    sourceReadMocks.sourceHealth.mockResolvedValueOnce({
      items: [{ id: 'source-1', provider: 'greenhouse' }],
      providers: [{ created: 3, provider: 'greenhouse' }],
    });

    const response = await callMcpTool({
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

    const response = await callMcpTool({
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
      callMcpTool({
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
      callMcpTool({
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
      callMcpTool({
        arguments: { accountStatus: 'needs_2fa', id: 'source-1' },
        name: 'source_update',
        permissions: ['sources.read'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();

    await expect(
      callMcpTool({
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

    await expect(
      assertMcpWorkflowPayload(
        'preferencerule_create',
        {
          ruleJson: { generatedAt: new Date() },
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError('JSON fields must be serializable JSON.');
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

  it('rejects unsafe MCP resume variant updates before tool execution', async () => {
    resumeVariantWorkflowMocks.resumeVariantWriteViolation.mockResolvedValueOnce(
      'Submitted or closed applications cannot have selected resume variants changed.',
    );

    await expect(
      assertMcpWorkflowPayload(
        'resumevariant_update',
        {
          id: 'variant-1',
          name: 'Changed variant',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Submitted or closed applications cannot have selected resume variants changed.',
    );

    expect(
      resumeVariantWorkflowMocks.resumeVariantWriteViolation,
    ).toHaveBeenCalledWith('variant-1');
    await expect(
      assertMcpWorkflowPayload(
        'resumevariant_update',
        { name: 'Missing id' },
        { id: 'user-1' },
      ),
    ).rejects.toThrowError(
      'Resume variant update requires a resume variant id.',
    );
  });

  it('rejects invalid MCP source account status before calling the generator', async () => {
    await expect(
      callMcpTool({
        arguments: {
          accountStatus: 'needs_magic',
          id: 'source-1',
        },
        name: 'source_update',
        ...owner,
      }),
    ).rejects.toThrowError('Invalid account status.');

    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    expect(mcpMocks.sources.get('source-1')).toMatchObject({
      accountStatus: 'needs_2fa',
    });
    expect(scheduleMocks.syncSourceSchedule).not.toHaveBeenCalled();
  });

  it('rejects non-object MCP tool arguments before calling the generator', async () => {
    await expect(
      callMcpTool({
        arguments: [],
        name: 'source_update',
        ...owner,
      }),
    ).rejects.toThrowError('MCP tool arguments must be a JSON object.');

    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    expect(scheduleMocks.syncSourceSchedule).not.toHaveBeenCalled();
  });

  it('syncs selected application approvals after successful MCP resume variant writes', async () => {
    await callMcpTool({
      arguments: {
        id: 'variant-1',
        name: 'Renamed variant',
      },
      name: 'resumevariant_update',
      ...owner,
    });

    expect(
      resumeVariantWorkflowMocks.resumeVariantWriteViolation,
    ).toHaveBeenCalledWith('variant-1');
    expect(
      resumeVariantWorkflowMocks.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('variant-1');

    await callMcpTool({
      arguments: {
        name: 'New variant',
      },
      name: 'resumevariant_create',
      ...owner,
    });

    expect(
      resumeVariantWorkflowMocks.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('resumevariant_create-created');
  });

  it('declares the workflow side-effect operations of every generated mutation tool', () => {
    const slugs = (name: string) =>
      (mcpToolOperations(name) ?? []).map(
        (operation) => `${operation.collection}.${operation.action}`,
      );

    expect(slugs('application_update')).toEqual([
      'applications.update',
      'applications.read',
      'tasks.read',
      'tasks.create',
      'tasks.update',
      'opportunities.read',
      'opportunities.update',
    ]);
    expect(slugs('application_create')).toContain('tasks.create');
    expect(slugs('opportunity_update')).toEqual([
      'opportunities.update',
      'opportunities.read',
      'tasks.read',
      'tasks.create',
      'tasks.update',
    ]);
    expect(slugs('source_create')).toEqual([
      'sources.create',
      'sources.read',
      'sources.update',
      'tasks.read',
      'tasks.create',
      'tasks.update',
    ]);
    expect(slugs('resumevariant_update')).toEqual([
      'resumevariants.update',
      'applications.read',
      'applications.update',
      'tasks.read',
      'tasks.create',
      'tasks.update',
      'opportunities.read',
      'opportunities.update',
    ]);
    expect(slugs('resumeasset_update')).toEqual([
      'resumeassets.update',
      'resumeassets.read',
    ]);
    // Deletes and classes without workflow hooks keep the primary operation.
    expect(slugs('application_delete')).toEqual(['applications.delete']);
    expect(slugs('resumeasset_create')).toEqual(['resumeassets.create']);
    expect(slugs('company_update')).toEqual(['companies.update']);
    expect(slugs('task_get')).toEqual(['tasks.read']);
    expect(slugs('resumeprofile_update')).toEqual(['resumeprofiles.update']);
    expect(slugs('resumeposition_list')).toEqual(['resumepositions.read']);
    expect(mcpToolOperations('candidateanswer_list')).toBeNull();
  });

  it('refuses an application update whose task sync the principal may not perform', async () => {
    await expect(
      callMcpTool({
        arguments: { id: 'app-approved', status: 'approved' },
        name: 'application_update',
        permissions: without('tasks.create', 'tasks.read', 'tasks.update'),
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });

    expect(mcpMocks.tasks).toEqual([]);
    expect(
      applicationConcurrencyMocks.commitApplicationIfCurrent,
    ).not.toHaveBeenCalled();
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
    expect(mcpMocks.applications.get('app-approved')).toMatchObject({
      status: 'approved',
    });

    // A submitted application's sync re-statuses its opportunity.
    await expect(
      callMcpTool({
        arguments: { id: 'app-approved', notes: 'Follow up' },
        name: 'application_update',
        permissions: without('opportunities.update'),
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(
      applicationConcurrencyMocks.commitApplicationIfCurrent,
    ).not.toHaveBeenCalled();
  });

  it('refuses opportunity and source writes whose side effects the principal may not perform', async () => {
    await expect(
      callMcpTool({
        arguments: { id: 'opp-1', status: 'recommended' },
        name: 'opportunity_update',
        permissions: ['opportunities.read', 'opportunities.update'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(
      workflowMocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();

    await expect(
      callMcpTool({
        arguments: { accountStatus: 'needs_2fa', id: 'source-1' },
        name: 'source_update',
        permissions: ['sources.read', 'sources.update'],
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(scheduleMocks.syncSourceSchedule).not.toHaveBeenCalled();

    await expect(
      callMcpTool({
        arguments: { name: 'Greenhouse' },
        name: 'source_create',
        permissions: without('sources.update'),
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });

    await expect(
      callMcpTool({
        arguments: { id: 'variant-1', name: 'Renamed variant' },
        name: 'resumevariant_update',
        permissions: without('applications.update'),
        tenantId: 'tenant-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    expect(
      resumeVariantWorkflowMocks.reserveResumeVariantApplicationWrite,
    ).not.toHaveBeenCalled();

    expect(mcpMocks.tasks).toEqual([]);
    expect(mcpMocks.generatorHandleToolCall).not.toHaveBeenCalled();
  });

  it('syncs workflow side effects after MCP writes by a principal holding the composite operation set', async () => {
    await callMcpTool({
      arguments: {
        id: 'app-approved',
        status: 'approved',
      },
      name: 'application_update',
      ...owner,
    });

    expect(mcpMocks.tasks).toContainEqual(
      expect.objectContaining({
        applicationId: 'app-approved',
        taskType: 'submit_application',
      }),
    );

    await callMcpTool({
      arguments: {
        accountStatus: 'needs_2fa',
        id: 'source-1',
      },
      name: 'source_update',
      ...owner,
    });

    expect(mcpMocks.tasks).toContainEqual(
      expect.objectContaining({
        sourceId: 'source-1',
        taskType: 'account_setup',
      }),
    );
    expect(scheduleMocks.syncSourceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStatus: 'needs_2fa',
        id: 'source-1',
      }),
    );

    await callMcpTool({
      arguments: {
        id: 'opp-1',
        status: 'recommended',
      },
      name: 'opportunity_update',
      ...owner,
    });

    expect(
      workflowMocks.syncRecommendedOpportunityDecisionTasks,
    ).toHaveBeenCalled();
  });

  it('does not let a stale MCP application update restore final approval', async () => {
    applicationConcurrencyMocks.commitApplicationIfCurrent.mockResolvedValueOnce(
      false,
    );

    await expect(
      callMcpTool({
        arguments: { id: 'app-approved', notes: 'Stale edit' },
        name: 'application_update',
        ...owner,
      }),
    ).rejects.toMatchObject({
      message:
        'Application changed before this update could be saved. Reload and review the current application.',
      status: 409,
    });
    expect(mcpMocks.applications.get('app-approved')).toMatchObject({
      finalApprovalKind: 'final_submission',
      status: 'approved',
    });
  });
});
