import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCurrentPrivateWorkspaceSubject } from './agent-audit-subject.js';
import {
  IOLAUS_MCP_APP_RESOURCE,
  mcpAppServer,
  resolveMcpAppPrincipal,
} from './mcp-app-server.js';

const workflows = vi.hoisted(() => ({
  getProfile: vi.fn(),
  inspectApplication: vi.fn(),
}));

// Keep executeAsPrincipal and the workspace verifier real; only storage and
// the workflow body are bounded fixtures for native-context regression.
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: workflows.getProfile })),
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: ':memory:' })),
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

describe('Iolaus MCP Apps server', () => {
  beforeEach(() => {
    workflows.getProfile.mockReset();
    workflows.inspectApplication.mockReset();
  });

  it('rebinds the verified selected profile inside the fresh native principal context', async () => {
    const subject = {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'owner-1',
    };
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
    { ownerUserId: 'foreign-user', tenantId: 'tenant-1', active: true },
    { ownerUserId: 'owner-1', tenantId: 'foreign-tenant', active: true },
    { ownerUserId: 'owner-1', tenantId: 'tenant-1', active: false },
  ])('rejects a selected profile that no longer belongs to the active principal (%j)', async (profile) => {
    const locals = {
      ...subjectLocals({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'owner-1',
      }),
      permissions: ['workflow.application.inspect'],
    };
    workflows.getProfile.mockResolvedValue({ id: 'profile-1', ...profile });
    const result = await mcpAppServer.callTool({
      name: 'job_search_inspect_application',
      arguments: { applicationId: '11111111-1111-4111-8111-111111111111' },
      principal: resolveMcpAppPrincipal(locals),
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
      'iolaus_open_human_review',
      'iolaus_open_opportunity_board',
      'job_search_browse_opportunities',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_open_application',
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

  it('keeps the catalog and portable resource private by default', async () => {
    await expect(mcpAppServer.listTools({ principal: null })).resolves.toEqual(
      [],
    );
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
      'iolaus_open_human_review',
      'iolaus_open_opportunity_board',
      'job_search_browse_opportunities',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_open_application',
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
