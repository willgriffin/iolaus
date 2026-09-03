import { OperationPermissionError } from '@happyvertical/smrt-users';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { opportunityDataSurfaceToolNames } from '$lib/opportunity-bulk-workflows';
import { jobSearchWebMcpToolDefinitions } from '$lib/webmcp';
import {
  isOwnerAuthorityDenial,
  OWNER_AGENT_CLASS,
  OwnerPrincipalError,
  ownerPrincipalBinding,
  PrincipalToolNotAllowedError,
  resolveOwnerPrincipalBinding,
  runAsOwner,
} from './owner-principal';
import { listOwnerToolNames } from './tool-catalog';

// The real `executeAsPrincipal()` gate runs against an in-memory database so
// these specs exercise the fail-closed tool ceiling and the catalog permission
// check without Postgres.
vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: ':memory:' })),
}));

const owner = {
  permissions: ['opportunities.read', 'opportunities.update'],
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
};

describe('owner principal tool catalog', () => {
  it('derives a non-empty allow-list containing every job_search tool and the generated MCP tools', async () => {
    const tools = await listOwnerToolNames();

    expect(tools.length).toBeGreaterThan(9);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toEqual([...tools].sort((a, b) => a.localeCompare(b)));
    for (const definition of jobSearchWebMcpToolDefinitions) {
      expect(tools).toContain(definition.name);
    }
    // The data-surface bulk workflows are not MCP or WebMCP tools, but the
    // allow-list is fail-closed, so their capability names must be present or
    // the actions could never pass assertToolAllowed.
    for (const name of opportunityDataSurfaceToolNames) {
      expect(tools).toContain(name);
    }
    expect(tools).toEqual(
      expect.arrayContaining([
        'application_update',
        'opportunity_get',
        'opportunity_list',
        'opportunity_update',
        'resumeprofile_list',
        'resumeposition_update',
        'source_update',
      ]),
    );
    expect(tools).not.toContain('candidateanswer_list');
  });

  it('binds the signed-in user with the derived allow-list', async () => {
    const binding = await resolveOwnerPrincipalBinding(owner);

    expect(binding.runAsUserId).toBe('user-1');
    expect(binding.tenantId).toBe('tenant-1');
    expect(binding.allowedTools).toContain('job_search_import_opportunity');
    expect(ownerPrincipalBinding({ user: { id: 'u' } }, ['x'])).toEqual({
      allowedTools: ['x'],
      runAsUserId: 'u',
      tenantId: null,
    });
  });
});

describe('runAsOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('throws before executing when no user is signed in', async () => {
    const fn = vi.fn(async () => 'ran');

    await expect(runAsOwner({ user: null }, fn)).rejects.toBeInstanceOf(
      OwnerPrincipalError,
    );
    await expect(
      runAsOwner(
        { locals: { permissions: [], tenantId: null, user: null } },
        fn,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      resolveOwnerPrincipalBinding({ user: { id: '  ' } }),
    ).rejects.toBeInstanceOf(OwnerPrincipalError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses tools outside the derived allow-list and permits listed ones', async () => {
    const result = await runAsOwner(owner, async (run) => {
      run.assertToolAllowed('job_search_import_opportunity');
      run.assertToolAllowed('opportunity_update');
      expect(run.isToolAllowed('not_a_registered_tool')).toBe(false);

      let refused: unknown = null;
      try {
        run.assertToolAllowed('not_a_registered_tool');
      } catch (cause) {
        refused = cause;
      }
      return { allowedTools: run.allowedTools, refused };
    });

    expect(result.refused).toBeInstanceOf(PrincipalToolNotAllowedError);
    expect(isOwnerAuthorityDenial(result.refused)).toBe(true);
    expect(result.allowedTools).toEqual(await listOwnerToolNames());
  });

  it('asserts operations against the published session permission snapshot', async () => {
    const result = await runAsOwner(owner, async (run) => {
      const allowed = await run.assertOperation('opportunities', 'update');
      let denied: unknown = null;
      try {
        await run.assertOperation('opportunities', 'delete');
      } catch (cause) {
        denied = cause;
      }
      return { allowed, denied, permissions: run.permissions };
    });

    expect(result.allowed).toMatchObject({ allowed: true });
    expect(result.denied).toBeInstanceOf(OperationPermissionError);
    expect(isOwnerAuthorityDenial(result.denied)).toBe(true);
    expect(result.permissions).toEqual(owner.permissions);
    expect(isOwnerAuthorityDenial(new Error('other'))).toBe(false);
  });

  it('denies every operation without a tenant, matching the session gate', async () => {
    await expect(
      runAsOwner({ ...owner, tenantId: null }, (run) =>
        run.assertOperation('opportunities', 'read'),
      ),
    ).rejects.toBeInstanceOf(OperationPermissionError);
  });

  it('writes one structured on-behalf-of audit line per execution', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await runAsOwner(owner, async () => 'ok', {
      action: 'admin.reviewOpportunity',
      auditMetadata: { collection: 'opportunities' },
    });

    const audits = info.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === 'owner_principal.audit');
    expect(audits).toHaveLength(1);
    const entry = audits[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'admin.reviewOpportunity',
      actorUserId: 'user-1',
      agentClass: OWNER_AGENT_CLASS,
      event: 'owner_principal.audit',
      metadata: { collection: 'opportunities' },
      onBehalfOfUserId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(typeof entry.timestamp).toBe('string');
  });
});
