import './manifest-preload.js';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  OperationPermissionError,
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
import { generateResumeAsset } from './resume-admin';
import { listOwnerToolNames } from './tool-catalog';
import { WorkspaceSubjectError } from './workspace-subject';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities';

const fixture = vi.hoisted(() => ({
  database: undefined as DatabaseInterface | undefined,
  profile: {} as Record<string, unknown>,
  assets: [] as (Record<string, unknown> & {
    save: ReturnType<typeof vi.fn>;
  })[],
  renderer: vi.fn(),
  filesystem: { delete: vi.fn(async (_path: string) => {}) },
}));

// Identity, membership, roles, PermissionResolver and executeAsPrincipal stay
// native; only the external renderer and candidate record adapters are stand-ins.
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
  getSmrtOptions: () => ({ db: fixture.database }),
}));
vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: () => ({ db: fixture.database }),
  getCollection: async (name: string) => {
    if (name === 'CandidateProfile')
      return { get: async () => fixture.profile };
    if (name === 'ResumeAsset')
      return {
        create: async (data: Record<string, unknown>) => {
          const asset = { ...data, id: 'asset-1', save: vi.fn(async () => {}) };
          fixture.assets.push(asset);
          return asset;
        },
        delete: async () => {
          fixture.assets.length = 0;
        },
      };
    throw new Error(`Unexpected fixture collection: ${name}`);
  },
}));
vi.mock('./app-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-config.js')>()),
  getAppConfig: () => ({
    agentClass: 'owner-fixture',
    runtimeProfile: 'local',
    workspaceMode: 'shared',
  }),
  isSharedHosted: () => false,
}));
vi.mock('./resume-data.js', () => ({
  loadAdminResumeSource: async () => ({ profile: { name: 'Candidate' } }),
  getResumeTailoringConfig: async () => ({ id: 'tailoring-1', config: {} }),
}));
vi.mock('./resume-tailoring-configs.js', () => ({
  ensureCanonicalResumeTailoringConfig: async () => {
    throw new Error('The fixture requires explicit tailoring');
  },
}));
vi.mock('@willgriffin/iolaus-resume', () => ({
  generateResumeArtifacts: fixture.renderer,
  getDefaultPuppeteerExecutablePath: async () => undefined,
}));

const owner = {
  permissions: ['opportunities.read', 'opportunities.update'],
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
};

let membershipId: string;
let roleId: string;
let profilePermissionId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  fixture.assets = [];
  fixture.renderer.mockReset();
  fixture.renderer.mockResolvedValue({
    htmlPath: 'resume.html',
    markdownPath: 'resume.md',
    pdfPath: 'resume.pdf',
    textPath: 'resume.txt',
  });
  fixture.database = await getTestDatabase({
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
  const options = { db: fixture.database };
  const user = await (await UserCollection.create(options)).create({
    email: 'owner@example.invalid',
    status: UserStatus.ACTIVE,
  });
  const tenant = await (await TenantCollection.create(options)).create({
    name: 'Workspace',
    status: TenantStatus.ACTIVE,
  });
  const role = await (await RoleCollection.create(options)).create({
    name: 'Owner fixture',
  });
  if (!user.id || !tenant.id || !role.id)
    throw new Error('Missing identity fixture ID');
  owner.user = { id: user.id };
  owner.tenantId = tenant.id;
  roleId = role.id;
  const membership = await (await MembershipCollection.create(options)).create({
    userId: user.id,
    tenantId: tenant.id,
    roleId,
    status: MembershipStatus.ACTIVE,
  });
  if (!membership.id) throw new Error('Missing membership fixture ID');
  membershipId = membership.id;
  const permissions = await PermissionCollection.create(options);
  const rolePermissions = await RolePermissionCollection.create(options);
  for (const slug of [...owner.permissions, 'workflow.profile.manage']) {
    const permission = await permissions.create({ name: slug, slug });
    if (!permission.id) throw new Error('Missing permission fixture ID');
    await rolePermissions.addPermission(roleId, permission.id);
    if (slug === 'workflow.profile.manage') profilePermissionId = permission.id;
  }
  fixture.profile = {
    id: 'profile-1',
    active: true,
    tenantId: tenant.id,
    ownerUserId: user.id,
  };
});

afterEach(async () => {
  await fixture.database?.close?.();
  fixture.database = undefined;
});

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
        'opportunity_get',
        'opportunity_list',
        'opportunity_update',
        'source_update',
      ]),
    );
    expect(tools).not.toContain('candidateanswer_list');
    expect(tools).not.toContain('resumeposition_update');
  });

  it('binds the signed-in user with the derived allow-list', async () => {
    const binding = await resolveOwnerPrincipalBinding(owner);

    expect(binding.runAsUserId).toBe(owner.user.id);
    expect(binding.tenantId).toBe(owner.tenantId);
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

  it('asserts operations against live native role permissions', async () => {
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
    expect(result.permissions.sort()).toEqual(
      [...owner.permissions, 'workflow.profile.manage'].sort(),
    );
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
      actorUserId: owner.user.id,
      agentClass: OWNER_AGENT_CLASS,
      event: 'owner_principal.audit',
      metadata: { collection: 'opportunities' },
      onBehalfOfUserId: owner.user.id,
      tenantId: owner.tenantId,
    });
    expect(typeof entry.timestamp).toBe('string');
  });
});

describe('owner authority write fences (native SQLite RBAC)', () => {
  function locals() {
    return {
      ...owner,
      permissions: [...owner.permissions, 'workflow.profile.manage'],
      membership: {
        roleId,
        status: 'active',
        tenantId: owner.tenantId,
        userId: owner.user.id,
      },
      workspaceSubject: {
        profileId: 'profile-1',
        tenantId: owner.tenantId,
        userId: owner.user.id,
      },
    };
  }

  async function revoke(kind: string) {
    await withSystemContext(async () => {
      const options = { db: fixture.database };
      if (kind === 'permission') {
        await (await RolePermissionCollection.create(options)).removePermission(
          roleId,
          profilePermissionId,
        );
      } else {
        const membership = await (
          await MembershipCollection.create(options)
        ).get(membershipId);
        if (!membership) throw new Error('Missing membership');
        membership.status = MembershipStatus.INACTIVE;
        await membership.save();
      }
    });
  }

  it.each([
    'membership',
    'permission',
  ])('denies %s revoked after the hook despite its stale snapshot', async (kind) => {
    const requestLocals = locals();
    const write = vi.fn();
    await revoke(kind);
    const operation = workspaceWorkflowOperation('profile.manage');
    await expect(
      runAsOwner(requestLocals, async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        write();
      }),
    ).rejects.toBeInstanceOf(
      kind === 'permission' ? OperationPermissionError : WorkspaceSubjectError,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves the selected owned profile and fresh user in the native callback', async () => {
    const requestLocals = locals();
    await runAsOwner(requestLocals, async (run) => {
      const operation = workspaceWorkflowOperation('profile.manage');
      await run.assertOperation(operation.collection, operation.action);
      expect(getCurrentTenant()?.metadata?.workspaceSubject).toEqual(
        requestLocals.workspaceSubject,
      );
      expect(getCurrentTenant()?.user).toMatchObject({
        id: owner.user.id,
        email: 'owner@example.invalid',
      });
    });
    fixture.profile.ownerUserId = 'other-owner';
    await expect(
      runAsOwner(requestLocals, async () => 'unexpected'),
    ).rejects.toBeInstanceOf(WorkspaceSubjectError);
  });

  it.each([
    'membership',
    'permission',
  ])('cleans rendered artifacts and denies metadata persistence when %s is revoked during rendering', async (kind) => {
    const requestLocals = locals();
    const operation = workspaceWorkflowOperation('profile.manage');
    const assertWriteAllowed = async () =>
      await runAsOwner(requestLocals, async (run) => {
        await run.assertOperation(operation.collection, operation.action);
      });
    fixture.renderer.mockImplementationOnce(async () => {
      await revoke(kind);
      return {
        htmlPath: 'resume.html',
        markdownPath: 'resume.md',
        pdfPath: 'resume.pdf',
        textPath: 'resume.txt',
      };
    });
    await expect(
      runAsOwner(requestLocals, async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        return await generateResumeAsset({
          subject: requestLocals.workspaceSubject,
          tailoringId: 'tailoring-1',
          filesystem: fixture.filesystem as never,
          assertWriteAllowed,
        });
      }),
    ).rejects.toBeInstanceOf(
      kind === 'permission' ? OperationPermissionError : WorkspaceSubjectError,
    );
    expect(fixture.renderer).toHaveBeenCalledTimes(1);
    expect(fixture.assets[0]?.save).not.toHaveBeenCalled();
    expect(fixture.assets[0]).not.toHaveProperty('pdfPath');
    expect(
      fixture.filesystem.delete.mock.calls.map(([path]) => path).sort(),
    ).toEqual(['resume.html', 'resume.md', 'resume.pdf', 'resume.txt']);
  });
});
