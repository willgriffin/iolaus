import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { describe, expect, it, vi } from 'vitest';
import {
  commandCenterWebMcpDefinitions,
  jobSearchWebMcpToolDefinitions,
} from '../webmcp.js';
import {
  createRuntimeDiagnosticsGet,
  runtimeDiagnosticsToolNames,
} from './runtime-diagnostics.js';

const activeOwnerLocals = {
  membership: {
    isActive: () => true,
    roleId: 'role-owner',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: [] as string[],
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
};

describe('deployed runtime diagnostics', () => {
  it('reports the exact mounted command-center WebMCP inventory', () => {
    const expected = [
      ...new Set([
        ...commandCenterWebMcpDefinitions([
          ...webMcpToolDefinitions,
          ...jobSearchWebMcpToolDefinitions,
        ]).map((definition) => definition.name),
      ]),
    ].sort((left, right) => left.localeCompare(right));

    expect(runtimeDiagnosticsToolNames()).toEqual(expected);
    expect(runtimeDiagnosticsToolNames()).toHaveLength(18);
    expect(runtimeDiagnosticsToolNames()).toContain(
      'job_search_next_triage_candidate',
    );
    expect(runtimeDiagnosticsToolNames()).not.toContain(
      'smrt.runtime.diagnostics.read',
    );
    expect(runtimeDiagnosticsToolNames()).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|[_-])(?:approve|submit)(?:$|[_-])/u),
      ]),
    );
  });

  it('finishes authentication and authorization before reading diagnostics', async () => {
    const readDiagnostics = vi.fn(async () => ({
      schemaVersion: 1,
      status: 'ready',
    }));
    const handler = createRuntimeDiagnosticsGet({
      readDiagnostics: readDiagnostics as never,
      resolveRoleSlug: vi.fn(async () => 'viewer'),
    });

    const unauthenticated = await handler({ locals: {} });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: { code: 'authentication_required' },
      schemaVersion: 1,
    });

    const denied = await handler({ locals: activeOwnerLocals });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: 'authorization_denied' },
      schemaVersion: 1,
    });
    expect(readDiagnostics).not.toHaveBeenCalled();
  });

  it('allows the explicit diagnostics permission without widening role access', async () => {
    const diagnostics = { schemaVersion: 1, status: 'ready' };
    const readDiagnostics = vi.fn(async () => diagnostics);
    const resolveRoleSlug = vi.fn(async () => 'viewer');
    const handler = createRuntimeDiagnosticsGet({
      readDiagnostics: readDiagnostics as never,
      resolveRoleSlug,
    });
    const response = await handler({
      locals: {
        ...activeOwnerLocals,
        permissions: ['runtime_diagnostics.read'],
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(diagnostics);
    expect(resolveRoleSlug).not.toHaveBeenCalled();
    expect(readDiagnostics).toHaveBeenCalledOnce();
  });
});
