import './manifest-preload.js';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  publicFacetsSchema,
  publicMatchInputSchema,
  publicMatchResultSchema,
  publicOpportunityDetailSchema,
  publicOpportunityInputSchema,
  publicOpportunityOpenApi,
  publicSearchInputSchema,
  publicSearchPageSchema,
} from '$lib/public-opportunity-contract.js';
import { requireCurrentPrivateWorkspaceSubject } from './agent-audit-subject.js';
import {
  IOLAUS_MCP_APP_RESOURCE,
  mcpAppServer,
  resolveMcpAppPrincipal,
} from './mcp-app-server.js';

const workflows = vi.hoisted(() => ({
  database: undefined as DatabaseInterface | undefined,
  publicSearch: vi.fn(),
  publicFacets: vi.fn(),
  publicMatch: vi.fn(),
  publicGet: vi.fn(),
  publicBudget: vi.fn(async () => 599),
  getProfile: vi.fn(),
  inspectApplication: vi.fn(),
}));

// Keep live identity, membership, role permissions, executeAsPrincipal and the
// workspace verifier native. Only candidate storage and the workflow body are
// bounded fixtures for this native-context regression.
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: workflows.getProfile })),
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: workflows.database })),
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
  getSmrtOptions: () => ({ db: workflows.database }),
}));

vi.mock('./public-search/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./public-search/index.js')>()),
  searchPublicOpportunities: workflows.publicSearch,
  listPublicFacets: workflows.publicFacets,
  matchPublicSkills: workflows.publicMatch,
  getPublicOpportunity: workflows.publicGet,
  consumePublicSearchBudget: workflows.publicBudget,
}));

vi.mock('./application-inspect-webmcp.js', () => ({
  inspectJobApplication: workflows.inspectApplication,
}));

const owner = {
  id: 'owner-1',
  kind: 'human',
  permissions: ['opportunities.read'],
  tenantId: 'tenant-1',
};

function subjectLocals(subject: {
  profileId: string;
  tenantId: string;
  userId: string;
}): App.Locals {
  return {
    membership: {
      roleId: 'member',
      status: 'active',
      tenantId: subject.tenantId,
      userId: subject.userId,
    },
    permissions: ['opportunities.read'],
    tenantId: subject.tenantId,
    user: { id: subject.userId },
    workspaceSubject: subject,
  } as App.Locals;
}

function toolsListRequest() {
  return new Request('https://jobs.example.test/api/mcp', {
    body: JSON.stringify({
      id: 'tools-list',
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'mcp-method': 'tools/list',
      'mcp-protocol-version': '2026-07-28',
    },
    method: 'POST',
  });
}

async function callPublicToolOverHttp(
  name: string,
  input: Record<string, unknown>,
) {
  const base = toolsListRequest();
  const headers = new Headers(base.headers);
  headers.set('mcp-method', 'tools/call');
  headers.set('mcp-name', name);
  const request = new Request(base, {
    headers,
    body: JSON.stringify({
      id: 'public-tool-call',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: input,
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    }),
  });
  const route = mountMcpRoute(mcpAppServer, { resolvePrincipal: () => null });
  const response = await route({ request, url: new URL(request.url) });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as {
    result: { structuredContent: unknown };
    error?: unknown;
  };
}

describe('Iolaus MCP Apps server', () => {
  let nativeSubject: { profileId: string; tenantId: string; userId: string };
  let membershipId: string;
  let roleId: string;
  let permissionId: string;

  beforeEach(async () => {
    workflows.getProfile.mockReset();
    workflows.inspectApplication.mockReset();
    workflows.publicSearch.mockReset();
    workflows.publicFacets.mockReset();
    workflows.publicMatch.mockReset();
    workflows.publicGet.mockReset();
    workflows.publicBudget.mockClear();
    workflows.database = await getTestDatabase({
      classes: [
        'Group',
        'GroupMember',
        'GroupRole',
        'Membership',
        'MembershipOverride',
        'Permission',
        'Role',
        'RolePermission',
        'Session',
        'Tenant',
        'TenantPermissionOverride',
        'User',
      ],
    });
    const options = { db: workflows.database };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const user = await users.create({
      email: 'mcp-owner@example.invalid',
      status: UserStatus.ACTIVE,
    });
    const tenant = await tenants.create({
      name: 'MCP workspace fixture',
      status: TenantStatus.ACTIVE,
    });
    const role = await roles.create({ name: 'MCP inspector' });
    if (!user.id || !tenant.id || !role.id)
      throw new Error('Missing native MCP identity ID');
    roleId = role.id;
    nativeSubject = {
      profileId: 'profile-1',
      tenantId: tenant.id,
      userId: user.id,
    };
    const memberships = await MembershipCollection.create(options);
    const membership = await memberships.create({
      roleId,
      tenantId: tenant.id,
      userId: user.id,
      status: MembershipStatus.ACTIVE,
    });
    if (!membership.id) throw new Error('Missing native membership ID');
    membershipId = membership.id;
    const permissions = await PermissionCollection.create(options);
    const permission = await permissions.create({
      name: 'Inspect application',
      slug: 'workflow.application.inspect',
    });
    if (!permission.id) throw new Error('Missing native permission ID');
    permissionId = permission.id;
    await (await RolePermissionCollection.create(options)).addPermission(
      roleId,
      permissionId,
    );
  });

  afterEach(async () => {
    await workflows.database?.close?.();
    workflows.database = undefined;
  });

  it('rebinds the verified selected profile inside the fresh native principal context', async () => {
    const subject = { ...nativeSubject };
    const locals = {
      ...subjectLocals(subject),
      permissions: ['workflow.application.inspect'],
    };
    workflows.getProfile.mockResolvedValue({
      active: true,
      id: subject.profileId,
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
    });
    workflows.inspectApplication.mockImplementation(async () => {
      expect(requireCurrentPrivateWorkspaceSubject()).toEqual(subject);
      expect(getCurrentTenant()?.metadata?.workspaceSubject).toEqual(subject);
      return { application: { id: '11111111-1111-4111-8111-111111111111' } };
    });
    const principal = resolveMcpAppPrincipal(locals);
    const result = await withTenant(
      {
        tenantId: subject.tenantId,
        userId: subject.userId,
        metadata: {
          workspaceSubject: {
            ...subject,
            profileId: 'untrusted-prior-profile',
          },
        },
      },
      async () =>
        await mcpAppServer.callTool({
          name: 'job_search_inspect_application',
          arguments: { applicationId: '11111111-1111-4111-8111-111111111111' },
          principal,
        }),
    );
    expect(result.isError).not.toBe(true);
    expect(workflows.getProfile).toHaveBeenCalledWith(subject.profileId);
    expect(workflows.inspectApplication).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'job_search_open_application',
      { opportunityId: '11111111-1111-4111-8111-111111111111' },
    ],
    ['refresh_my_matches', {}],
  ])('does not expand a linked read grant into %s', async (name, input) => {
    const principal = resolveMcpAppPrincipal({
      ...subjectLocals(nativeSubject),
      permissions: ['workflow.application.inspect'],
    });
    await expect(
      mcpAppServer.callTool({
        name: String(name),
        arguments: input as Record<string, unknown>,
        principal,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'The granted scope does not permit this operation.',
    });
    expect(workflows.inspectApplication).not.toHaveBeenCalled();
  });

  it('resolves a human-review destination with read authority without approving it', async () => {
    workflows.getProfile.mockResolvedValue({
      active: true,
      id: nativeSubject.profileId,
      ownerUserId: nativeSubject.userId,
      tenantId: nativeSubject.tenantId,
    });
    const reviewUrl =
      '/admin/applications/11111111-1111-4111-8111-111111111111/review';
    workflows.inspectApplication.mockResolvedValue({
      application: { reviewUrl },
      approval: { approved: false },
      submission: { submitted: false },
    });
    const result = await mcpAppServer.callTool({
      name: 'iolaus_open_human_review',
      arguments: { url: reviewUrl },
      principal: resolveMcpAppPrincipal({
        ...subjectLocals(nativeSubject),
        permissions: ['workflow.application.inspect'],
      }),
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain(reviewUrl);
    expect(JSON.stringify(result)).toContain('"approved":false');
    expect(workflows.inspectApplication).toHaveBeenCalledOnce();
  });

  it.each([
    'foreign user',
    'foreign tenant',
    'inactive profile',
  ])('rejects a selected profile that no longer belongs to the active principal (%s)', async (kind) => {
    const locals = {
      ...subjectLocals(nativeSubject),
      permissions: ['workflow.application.inspect'],
    };
    workflows.getProfile.mockResolvedValue({
      id: nativeSubject.profileId,
      ownerUserId:
        kind === 'foreign user' ? 'foreign-user' : nativeSubject.userId,
      tenantId:
        kind === 'foreign tenant' ? 'foreign-tenant' : nativeSubject.tenantId,
      active: kind !== 'inactive profile',
    });
    const result = await mcpAppServer.callTool({
      name: 'job_search_inspect_application',
      arguments: { applicationId: '11111111-1111-4111-8111-111111111111' },
      principal: resolveMcpAppPrincipal(locals),
    });
    expect(result.isError).toBe(true);
    expect(workflows.inspectApplication).not.toHaveBeenCalled();
  });

  it.each([
    'membership',
    'permission',
  ])('denies a request-minted principal after native %s revocation despite its stale permission snapshot', async (kind) => {
    const locals = {
      ...subjectLocals(nativeSubject),
      permissions: ['workflow.application.inspect'],
    };
    const principal = resolveMcpAppPrincipal(locals);
    expect(principal).not.toBeNull();
    workflows.getProfile.mockResolvedValue({
      id: nativeSubject.profileId,
      active: true,
      tenantId: nativeSubject.tenantId,
      ownerUserId: nativeSubject.userId,
    });
    await withSystemContext(async () => {
      const options = { db: workflows.database };
      if (kind === 'permission') {
        await (await RolePermissionCollection.create(options)).removePermission(
          roleId,
          permissionId,
        );
      } else {
        const membership = await (
          await MembershipCollection.create(options)
        ).get(membershipId);
        if (!membership) throw new Error('Missing native membership');
        membership.status = MembershipStatus.INACTIVE;
        await membership.save();
      }
    });
    const result = await mcpAppServer.callTool({
      name: 'job_search_inspect_application',
      arguments: { applicationId: '11111111-1111-4111-8111-111111111111' },
      principal,
    });
    expect(result.isError).toBe(true);
    expect(workflows.inspectApplication).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {
      roleId: 'member',
      status: 'suspended',
      tenantId: 'tenant-1',
      userId: 'owner-1',
    },
  ])('does not mint workflow authority without active membership (%j)', async (membership) => {
    const locals = {
      ...subjectLocals({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'owner-1',
      }),
      membership,
      permissions: ['workflow.application.inspect'],
    } as App.Locals;
    const principal = resolveMcpAppPrincipal(locals);
    expect(principal).toBeNull();
    await expect(
      mcpAppServer.callTool({
        name: 'job_search_inspect_application',
        arguments: { applicationId: '11111111-1111-4111-8111-111111111111' },
        principal,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(workflows.getProfile).not.toHaveBeenCalled();
    expect(workflows.inspectApplication).not.toHaveBeenCalled();
  });

  it('mints a principal only from the hook-verified workspace subject', () => {
    const locals = {
      membership: {
        roleId: 'member',
        status: 'active',
        tenantId: 'tenant-1',
        userId: 'owner-1',
      },
      permissions: ['opportunities.read'],
      tenantId: 'tenant-1',
      user: { id: 'owner-1' },
      workspaceSubject: {
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'owner-1',
      },
    } as App.Locals;

    expect(resolveMcpAppPrincipal(locals)).toMatchObject({
      id: 'owner-1',
      profileId: 'profile-1',
      tenantId: 'tenant-1',
    });
    expect(
      resolveMcpAppPrincipal({
        ...locals,
        workspaceSubject: {
          profileId: 'profile-2',
          tenantId: 'tenant-1',
          userId: 'other-user',
        },
      }),
    ).toBeNull();
  });

  it('serves the native HTTP catalog independently to two verified subjects', async () => {
    const route = mountMcpRoute(mcpAppServer, {
      resolvePrincipal: ({ locals }) =>
        resolveMcpAppPrincipal((locals ?? {}) as unknown as App.Locals),
    });
    const [first, second] = await Promise.all(
      [
        { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'owner-1' },
        { profileId: 'profile-2', tenantId: 'tenant-2', userId: 'owner-2' },
      ].map(
        async (subject) =>
          await route({
            locals: subjectLocals(subject) as unknown as Record<
              string,
              unknown
            >,
            request: toolsListRequest(),
            url: new URL('https://jobs.example.test/api/mcp'),
          }),
      ),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCatalog = (await first.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const secondCatalog = (await second.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(firstCatalog.result.tools.map((tool) => tool.name)).toEqual([
      'explain_match',
      'get_opportunity',
      'iolaus_open_human_review',
      'iolaus_open_opportunity_board',
      'job_search_browse_opportunities',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_open_application',
      'list_facets',
      'match_my_profile',
      'refresh_my_matches',
      'search_opportunities',
    ]);
    expect(secondCatalog.result.tools).toEqual(firstCatalog.result.tools);
    const forged = {
      ...subjectLocals({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'owner-1',
      }),
      membership: { status: 'active', tenantId: 'tenant-1', userId: 'owner-2' },
      user: { id: 'owner-2' },
    } as unknown as App.Locals;
    expect(resolveMcpAppPrincipal(forged)).toBeNull();
  });

  it('exposes exactly the public catalog tools without exposing a workspace resource', async () => {
    await expect(
      mcpAppServer.listTools({ principal: null }),
    ).resolves.toMatchObject([
      {
        name: 'explain_match',
        annotations: { openWorldHint: true, readOnlyHint: true },
      },
      {
        name: 'get_opportunity',
        annotations: { openWorldHint: true, readOnlyHint: true },
      },
      {
        name: 'list_facets',
        annotations: { openWorldHint: true, readOnlyHint: true },
      },
      {
        name: 'search_opportunities',
        annotations: { openWorldHint: true, readOnlyHint: true },
      },
    ]);
    await expect(
      mcpAppServer.listResources?.({ principal: null }),
    ).resolves.toEqual([]);
    await expect(
      mcpAppServer.readResource?.({
        principal: null,
        uri: IOLAUS_MCP_APP_RESOURCE,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('exposes only the bounded Iolaus workflows to a verified principal', async () => {
    const tools = await mcpAppServer.listTools({ principal: owner });

    expect(tools.map((tool) => tool.name)).toEqual([
      'explain_match',
      'get_opportunity',
      'iolaus_open_human_review',
      'iolaus_open_opportunity_board',
      'job_search_browse_opportunities',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_open_application',
      'list_facets',
      'match_my_profile',
      'refresh_my_matches',
      'search_opportunities',
    ]);
    expect(
      tools.find((tool) => tool.name === 'job_search_browse_opportunities')
        ?._meta,
    ).toMatchObject({ ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE } });

    const resource = await mcpAppServer.readResource?.({
      principal: owner,
      uri: IOLAUS_MCP_APP_RESOURCE,
    });
    expect(resource).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      uri: IOLAUS_MCP_APP_RESOURCE,
    });
    expect(resource?._meta.ui.csp).toEqual({
      baseUriDomains: [],
      connectDomains: [],
      frameDomains: [],
      resourceDomains: [],
    });
  });
});

// Catalog contract tests do not construct private identity tables; native auth
// and revocation fixtures remain in the independent describe above.
describe('public MCP contract parity', () => {
  beforeEach(() => {
    workflows.publicSearch.mockReset();
    workflows.publicFacets.mockReset();
    workflows.publicMatch.mockReset();
    workflows.publicGet.mockReset();
    workflows.publicBudget.mockClear();
  });
  it('advertises public REST Zod contracts verbatim through tools/list', async () => {
    const route = mountMcpRoute(mcpAppServer, { resolvePrincipal: () => null });
    const response = await route({
      request: toolsListRequest(),
      url: new URL('https://jobs.example.test/api/mcp'),
    });
    const catalog = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: unknown;
          outputSchema: unknown;
        }>;
      };
    };
    for (const [name, input, output] of [
      ['search_opportunities', publicSearchInputSchema, publicSearchPageSchema],
      ['list_facets', publicSearchInputSchema, publicFacetsSchema],
      [
        'get_opportunity',
        publicOpportunityInputSchema,
        publicOpportunityDetailSchema,
      ],
      ['explain_match', publicMatchInputSchema, publicMatchResultSchema],
    ] as const) {
      const tool = catalog.result.tools.find((tool) => tool.name === name);
      expect(tool?.inputSchema).toEqual(z.toJSONSchema(input, { io: 'input' }));
      expect(tool?.outputSchema).toEqual(
        z.toJSONSchema(output, { io: 'output' }),
      );
    }
    expect(
      publicOpportunityOpenApi.paths['/api/public/v1/opportunities/{id}'].get
        .parameters[0].schema,
    ).toEqual(
      z.toJSONSchema(publicOpportunityInputSchema, { io: 'input' }).properties
        ?.id,
    );
  });

  it('executes all advertised snake_case search filters and defaulted input without a second contract', async () => {
    const facets = {
      skills: [],
      seniority: [],
      function: [],
      work_mode: [],
      employment_type: [],
      country: [],
    };
    const page = { items: [], next_cursor: null, total_estimate: 0, facets };
    workflows.publicSearch.mockResolvedValue(page);
    workflows.publicFacets.mockResolvedValue(facets);
    const input = {
      q: 'software engineer',
      skills: ['typescript'],
      seniority: ['senior'],
      function: ['engineering'],
      work_mode: ['remote'],
      employment_type: ['full-time'],
      country: ['CA'],
      remote_ok: true,
      company: 'example',
      source: 'source-1',
      posted_since: '2026-01-01T00:00:00Z',
      salary_min: 100000,
      salary_currency: 'CAD',
      salary_period: 'year',
      cursor: 'cursor',
      limit: 10,
      sort: 'salary',
    };
    expect(
      (await callPublicToolOverHttp('search_opportunities', input)).result
        .structuredContent,
    ).toEqual(page);
    expect(workflows.publicSearch).toHaveBeenLastCalledWith(
      publicSearchInputSchema.parse(input),
    );
    expect(
      (
        await mcpAppServer.callTool({
          name: 'list_facets',
          arguments: input,
          principal: null,
        })
      ).structuredContent,
    ).toEqual(facets);
    expect(workflows.publicFacets).toHaveBeenLastCalledWith(
      publicSearchInputSchema.parse(input),
    );
    await mcpAppServer.callTool({
      name: 'search_opportunities',
      arguments: {},
      principal: null,
    });
    expect(workflows.publicSearch).toHaveBeenLastCalledWith(
      publicSearchInputSchema.parse({}),
    );
    await expect(
      mcpAppServer.callTool({
        name: 'search_opportunities',
        arguments: { workMode: ['remote'] },
        principal: null,
      }),
    ).rejects.toThrow();
  });

  it.each([
    {},
    { id: '' },
    { id: 'x'.repeat(129) },
    { id: 'opportunity-1', private: true },
  ])('rejects invalid get_opportunity input before reading catalog data: %j', async (input) => {
    await expect(
      mcpAppServer.callTool({
        name: 'get_opportunity',
        arguments: input,
        principal: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(workflows.publicGet).not.toHaveBeenCalled();
  });

  it('accepts all optional match inputs and advertises bounded required skills', async () => {
    workflows.publicMatch.mockResolvedValue({ items: [], model_calls: 0 });
    const input = {
      skills: ['typescript'],
      seniority: 'senior',
      countries: ['CA'],
      remote_ok: true,
      years: 8,
      opportunity_ids: ['opportunity-1'],
    };
    const result = await callPublicToolOverHttp('explain_match', input);
    expect(result.result.structuredContent).toEqual({
      items: [],
      model_calls: 0,
    });
    expect(workflows.publicMatch).toHaveBeenLastCalledWith(
      publicMatchInputSchema.parse(input),
    );
    await expect(
      mcpAppServer.callTool({
        name: 'explain_match',
        arguments: { skills: [], years: 101 },
        principal: null,
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      mcpAppServer.callTool({
        name: 'explain_match',
        arguments: { countries: ['CA'] },
        principal: null,
      }),
    ).resolves.toMatchObject({ isError: true });
  });
});
