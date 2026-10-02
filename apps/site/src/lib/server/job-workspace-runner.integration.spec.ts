import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  type SmrtJob,
  SmrtJobCollection,
  TaskRunner,
} from '@happyvertical/smrt-jobs';
import {
  getCurrentTenant,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  deriveOperationPermissionSlug,
  MembershipCollection,
  MembershipStatus,
  PermissionCatalogService,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '../objects/Application.js';
import type { CandidateProfile } from '../objects/CandidateProfile.js';
import type { Opportunity } from '../objects/Opportunity.js';

const fixture = vi.hoisted(() => ({
  database: undefined as DatabaseInterface | undefined,
  autoSubmit: vi.fn(),
  processor: vi.fn(),
  workspaceMode: 'shared' as 'private' | 'shared',
}));

// The production handler dynamically loads these modules.  Keep the worker,
// object registry, job envelope, identities, and principal context native while
// replacing only the external/provider-facing intelligence implementation.
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
  getSmrtOptions: () => {
    if (!fixture.database)
      throw new Error('TaskRunner fixture is unavailable.');
    return { db: fixture.database };
  },
}));
vi.mock('./app-config.js', () => ({
  getAppConfig: () => ({
    runtimeProfile: 'local',
    workspaceMode: fixture.workspaceMode,
  }),
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  runOpportunityIntelligenceJob: fixture.processor,
}));
vi.mock('./auto-submit-application-job.js', () => ({
  runAutoSubmitApplicationJob: fixture.autoSubmit,
}));

// Registers the actual application Opportunity type that TaskRunner resolves.
import './smrt.js';
import { getCollection } from './smrt.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

interface Subject {
  profileId: string;
  tenantId: string;
  userId: string;
}

interface WorkspaceFixture {
  membershipId: string;
  roleId: string;
  subject: Subject;
}

function requiredId(value: { id?: string | null }, label: string): string {
  if (!value.id) throw new Error(`${label} fixture is missing an ID.`);
  return value.id;
}

function jobArgs(subject: Subject) {
  return {
    modes: 'assessment' as const,
    runtimeWorkspaceSubject: subject,
  };
}

function autoSubmitArgs(subject: Subject) {
  return { runtimeWorkspaceSubject: subject };
}

function registeredOpportunityType(): string {
  const registered = ObjectRegistry.getClass('Opportunity');
  if (!registered?.qualifiedName) {
    throw new Error('The application Opportunity type was not registered.');
  }
  return registered.qualifiedName;
}

function registeredApplicationType(): string {
  const registered = ObjectRegistry.getClass('Application');
  if (!registered?.qualifiedName) {
    throw new Error('The application Application type was not registered.');
  }
  return registered.qualifiedName;
}

function currentWorkspaceSubject(): Subject | undefined {
  const subject = getCurrentTenant()?.metadata?.workspaceSubject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    return undefined;
  }
  const record = subject as Record<string, unknown>;
  if (
    typeof record.profileId !== 'string' ||
    typeof record.tenantId !== 'string' ||
    typeof record.userId !== 'string'
  ) {
    return undefined;
  }
  return {
    profileId: record.profileId,
    tenantId: record.tenantId,
    userId: record.userId,
  };
}

function twoJobBarrier(): () => Promise<void> {
  let entered = 0;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const bothEntered = new Promise<void>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  const timeout = setTimeout(() => {
    reject(
      new Error(
        'Concurrent TaskRunner jobs did not both enter within one second.',
      ),
    );
  }, 1_000);
  return async () => {
    entered += 1;
    if (entered === 2) {
      clearTimeout(timeout);
      release();
    }
    await bothEntered;
  };
}

async function waitForTerminalJob(
  runner: TaskRunner,
  jobId: string,
): Promise<{ error?: Error; job: SmrtJob; result?: unknown }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for queued job ${jobId}.`));
    }, 3_000);
    const complete = (job: SmrtJob, result: unknown) => {
      if (job.id !== jobId) return;
      cleanup();
      resolve({ job, result });
    };
    const fail = (job: SmrtJob, error: Error) => {
      if (job.id !== jobId) return;
      cleanup();
      resolve({ error, job });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      runner.off('job:completed', complete);
      runner.off('job:failed', fail);
    };
    runner.on('job:completed', complete);
    runner.on('job:failed', fail);
  });
}

describe('TaskRunner workspace-subject dispatch (SQLite)', () => {
  let database: DatabaseInterface | undefined;
  let directory: string | undefined;
  let jobs: SmrtJobCollection | undefined;
  let runner: TaskRunner | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-job-workspace-runner-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'jobs.sqlite'),
    });
    fixture.database = database;
    fixture.workspaceMode = 'shared';
    fixture.autoSubmit.mockReset();
    fixture.autoSubmit.mockImplementation(async () => ({
      code: 'fixture',
      outcome: 'noop',
      reason: 'Synthetic auto-submit completed.',
    }));
    fixture.processor.mockReset();
    fixture.processor.mockImplementation(async () => ({
      message: 'Synthetic intelligence completed.',
      status: 'completed',
    }));

    await getTestDatabase({
      db: database,
      classes: [
        '@happyvertical/smrt-jobs:SmrtJob',
        '@happyvertical/smrt-jobs:SmrtJobEvent',
        '@happyvertical/smrt-jobs:SmrtWorker',
        'CandidateProfile',
        'Application',
        'Group',
        'GroupMember',
        'GroupRole',
        'Membership',
        'MembershipOverride',
        'Opportunity',
        'Permission',
        'Role',
        'RolePermission',
        'Tenant',
        'TenantPermissionOverride',
        'User',
      ],
    });
    jobs = await SmrtJobCollection.create({ db: database });
    await jobs.initialize();
    runner = new TaskRunner({
      concurrency: 2,
      heartbeatInterval: 50,
      idlePollInterval: 50,
      leaseTickMs: 50,
      leaseTtlMs: 500,
      pollInterval: 10,
      queues: ['workspace-subject-fixture'],
      retention: false,
      shutdownTimeout: 1_000,
    });
    await runner.initialize(database);
  });

  afterEach(async () => {
    await runner?.stop();
    await database?.close?.();
    fixture.database = undefined;
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  async function createWorkspace(label: string): Promise<WorkspaceFixture> {
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const [tenant, user] = await withSystemContext(async () => {
      const tenants = await TenantCollection.create({ db: database });
      const users = await UserCollection.create({ db: database });
      return await Promise.all([
        tenants.create({
          name: `Synthetic ${label} tenant`,
          status: TenantStatus.ACTIVE,
        }),
        users.create({
          email: `${label}@example.invalid`,
          status: UserStatus.ACTIVE,
        }),
      ]);
    });
    const tenantId = requiredId(tenant, 'Tenant');
    const userId = requiredId(user, 'User');
    const role = await withSystemContext(async () => {
      const roles = await RoleCollection.create({ db: database });
      return await roles.create({ name: `Synthetic ${label} role` });
    });
    const roleId = requiredId(role, 'Role');
    const assessmentOperation =
      workspaceWorkflowOperation('assessment.execute');
    const autoSubmitOperation = workspaceWorkflowOperation(
      'application-auto-submit.execute',
    );
    const requiredPermissionSlugs = [
      deriveOperationPermissionSlug('opportunities', 'read'),
      deriveOperationPermissionSlug(
        assessmentOperation.collection,
        assessmentOperation.action,
      ),
      deriveOperationPermissionSlug(
        autoSubmitOperation.collection,
        autoSubmitOperation.action,
      ),
    ];
    await withSystemContext(async () => {
      const catalog = PermissionCatalogService.create({ db: database });
      await catalog.syncPermissionCatalog();
      const permissions = await PermissionCollection.create({ db: database });
      const rolePermissions = await RolePermissionCollection.create({
        db: database,
      });
      for (const slug of requiredPermissionSlugs) {
        if (!catalog.hasPermissionSlug(slug)) {
          throw new Error(
            `Fixture permission is absent from the native catalog: ${slug}.`,
          );
        }
        const permission = await permissions.findBySlug(slug);
        if (!permission)
          throw new Error(`Catalog sync did not persist ${slug}.`);
        await rolePermissions.addPermission(
          roleId,
          requiredId(permission, 'Permission'),
        );
      }
    });
    const membership = await withSystemContext(async () => {
      const memberships = await MembershipCollection.create({ db: database });
      return await memberships.create({
        roleId,
        status: MembershipStatus.ACTIVE,
        tenantId,
        userId,
      });
    });
    const profile = await withTenant({ tenantId, userId }, async () => {
      const profiles = await getCollection<CandidateProfile>(
        'CandidateProfile',
        {
          db: database,
        },
      );
      return await profiles.create({
        name: `Synthetic ${label} profile`,
        ownerUserId: userId,
        profileKey: label,
        tenantId,
      });
    });
    return {
      membershipId: requiredId(membership, 'Membership'),
      roleId,
      subject: {
        profileId: requiredId(profile, 'Candidate profile'),
        tenantId,
        userId,
      },
    };
  }

  async function createOpportunity(label: string): Promise<string> {
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const opportunities = await getCollection<Opportunity>('Opportunity', {
      db: database,
    });
    const opportunity = await opportunities.create({
      title: `Synthetic ${label} opportunity`,
    });
    return requiredId(opportunity, 'Opportunity');
  }

  async function createOwnedProfile(
    subject: Subject,
    profileKey: string,
  ): Promise<Subject> {
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const profile = await withTenant(
      { tenantId: subject.tenantId, userId: subject.userId },
      async () => {
        const profiles = await getCollection<CandidateProfile>(
          'CandidateProfile',
          {
            db: database,
          },
        );
        return await profiles.create({
          name: `Synthetic ${profileKey} profile`,
          ownerUserId: subject.userId,
          profileKey,
          tenantId: subject.tenantId,
        });
      },
    );
    return { ...subject, profileId: requiredId(profile, 'Candidate profile') };
  }

  async function createApplication(subject: Subject): Promise<string> {
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const application = await withTenant(
      { tenantId: subject.tenantId, userId: subject.userId },
      async () => {
        const applications = await getCollection<Application>('Application', {
          db: database,
        });
        return await applications.create({
          candidateProfileId: subject.profileId,
          ownerUserId: subject.userId,
          tenantId: subject.tenantId,
        });
      },
    );
    return requiredId(application, 'Application');
  }

  async function enqueue(
    subject: Subject,
    opportunityId: string,
    tenantId = subject.tenantId,
  ) {
    if (!jobs) throw new Error('TaskRunner fixture is unavailable.');
    return await jobs.enqueueJob({
      args: jobArgs(subject),
      maxAttempts: 1,
      method: 'processIntelligence',
      objectId: opportunityId,
      objectType: registeredOpportunityType(),
      queue: 'workspace-subject-fixture',
      tenantId,
    });
  }

  async function startAndWait(job: SmrtJob) {
    if (!runner) throw new Error('TaskRunner fixture is unavailable.');
    const jobId = requiredId(job, 'Queued job');
    const terminal = waitForTerminalJob(runner, jobId);
    await runner.start();
    return await terminal;
  }

  async function enqueueAutoSubmit(
    subject: Subject,
    applicationId: string,
    tenantId = subject.tenantId,
  ) {
    if (!jobs) throw new Error('TaskRunner fixture is unavailable.');
    return await jobs.enqueueJob({
      args: autoSubmitArgs(subject),
      maxAttempts: 1,
      method: 'autoSubmit',
      objectId: applicationId,
      objectType: registeredApplicationType(),
      queue: 'workspace-subject-fixture',
      tenantId,
    });
  }

  it.each([
    'private',
    'shared',
  ] as const)('dispatches the registered Opportunity method in a %s workspace with its bound principal and native tenant context', async (workspaceMode) => {
    fixture.workspaceMode = workspaceMode;
    const workspace = await createWorkspace(`valid-${workspaceMode}`);
    const opportunityId = await createOpportunity(`valid-${workspaceMode}`);
    fixture.processor.mockImplementationOnce(
      async (_opportunity, _args, context) => ({
        contextJobTenant: context?.job?.tenantId,
        metadataSubject: currentWorkspaceSubject(),
        nativeTenantId: getCurrentTenant()?.tenantId,
        nativeUserId: getCurrentTenant()?.userId,
        status: 'completed',
      }),
    );

    const terminal = await startAndWait(
      await enqueue(workspace.subject, opportunityId),
    );

    expect(terminal.error).toBeUndefined();
    expect(fixture.processor).toHaveBeenCalledTimes(1);
    expect(terminal.result).toMatchObject({
      result: {
        contextJobTenant: workspace.subject.tenantId,
        metadataSubject: workspace.subject,
        nativeTenantId: workspace.subject.tenantId,
        nativeUserId: workspace.subject.userId,
      },
    });
  });

  it.each([
    'private',
    'shared',
  ] as const)('dispatches the registered Application auto-submit method in a %s workspace', async (workspaceMode) => {
    fixture.workspaceMode = workspaceMode;
    const workspace = await createWorkspace(`auto-submit-${workspaceMode}`);
    const applicationId = await createApplication(workspace.subject);
    fixture.autoSubmit.mockImplementationOnce(
      async (application, _args, context) => ({
        application,
        contextJobTenant: context?.job?.tenantId,
        metadataSubject: currentWorkspaceSubject(),
        nativeTenantId: getCurrentTenant()?.tenantId,
        nativeUserId: getCurrentTenant()?.userId,
        outcome: 'noop',
      }),
    );

    const terminal = await startAndWait(
      await enqueueAutoSubmit(workspace.subject, applicationId),
    );

    expect(terminal.error).toBeUndefined();
    expect(fixture.autoSubmit).toHaveBeenCalledTimes(1);
    expect(terminal.result).toMatchObject({
      result: {
        application: {
          candidateProfileId: workspace.subject.profileId,
          ownerUserId: workspace.subject.userId,
          tenantId: workspace.subject.tenantId,
        },
        contextJobTenant: workspace.subject.tenantId,
        metadataSubject: workspace.subject,
        nativeTenantId: workspace.subject.tenantId,
        nativeUserId: workspace.subject.userId,
      },
    });
  });

  it('stops a dispatched assessment at the fresh native permission fence after revocation', async () => {
    const workspace = await createWorkspace('revalidated-revocation');
    const persistence = vi.fn(async () => undefined);
    fixture.processor.mockImplementationOnce(async () => {
      if (!database) throw new Error('TaskRunner fixture is unavailable.');
      const permissions = await PermissionCollection.create({ db: database });
      const rolePermissions = await RolePermissionCollection.create({
        db: database,
      });
      const permission = await permissions.findBySlug(
        deriveOperationPermissionSlug(
          workspaceWorkflowOperation('assessment.execute').collection,
          workspaceWorkflowOperation('assessment.execute').action,
        ),
      );
      if (!permission?.id) throw new Error('Assessment capability is missing.');
      const grant = (await rolePermissions.findByRole(workspace.roleId)).find(
        (entry) => entry.permissionId === permission.id,
      );
      if (!grant) throw new Error('Assessment capability grant is missing.');
      await grant.delete();
      const { runAsRevalidatedJobWorkspaceSubject } = await import(
        './job-workspace-subject.js'
      );
      await runAsRevalidatedJobWorkspaceSubject(
        workspace.subject,
        'assessment.execute',
        persistence,
      );
      return { status: 'completed' };
    });

    const terminal = await startAndWait(
      await enqueue(
        workspace.subject,
        await createOpportunity('revalidated-revocation'),
      ),
    );

    expect(fixture.processor).toHaveBeenCalledTimes(1);
    expect(terminal.error).toBeDefined();
    expect(persistence).not.toHaveBeenCalled();
  });

  it('rejects an auto-submit application outside the bound workspace tuple', async () => {
    const workspace = await createWorkspace('auto-submit-owner');
    const foreign = await createWorkspace('auto-submit-foreign');

    const terminal = await startAndWait(
      await enqueueAutoSubmit(
        workspace.subject,
        await createApplication(foreign.subject),
      ),
    );

    expect(terminal.error?.message).toContain(
      'Application is outside the queued workspace subject',
    );
    expect(fixture.autoSubmit).not.toHaveBeenCalled();
  });

  it('rejects a JSON-shaped direct auto-submit context before workspace work', async () => {
    const workspace = await createWorkspace('auto-submit-forged-context');
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const applications = await getCollection<Application>('Application', {
      db: database,
    });
    const application = await applications.get(
      await createApplication(workspace.subject),
    );
    if (!application) throw new Error('Synthetic application is missing.');

    await expect(
      application.autoSubmit(autoSubmitArgs(workspace.subject), {
        job: { tenantId: workspace.subject.tenantId },
      } as never),
    ).rejects.toThrow('active TaskRunner execution context');

    expect(fixture.autoSubmit).not.toHaveBeenCalled();
  });

  it('rejects a JSON-shaped direct method context before any workspace work', async () => {
    const workspace = await createWorkspace('forged-context');
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const opportunities = await getCollection<Opportunity>('Opportunity', {
      db: database,
    });
    const opportunity = await opportunities.get(
      await createOpportunity('forged-context'),
    );
    if (!opportunity) throw new Error('Synthetic opportunity is missing.');

    await expect(
      opportunity.processIntelligence(jobArgs(workspace.subject), {
        job: { tenantId: workspace.subject.tenantId },
      } as never),
    ).rejects.toThrow('active TaskRunner execution context');

    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('rejects a foreign profile before the registered method can call business work', async () => {
    const valid = await createWorkspace('valid');
    const foreign = await createWorkspace('foreign');
    const opportunityId = await createOpportunity('foreign-profile');
    const forged = { ...valid.subject, profileId: foreign.subject.profileId };

    const terminal = await startAndWait(await enqueue(forged, opportunityId));

    expect(terminal.error?.message).toContain('candidate profile');
    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('rejects a revoked membership before the registered method can call business work', async () => {
    const workspace = await createWorkspace('revoked');
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const memberships = await MembershipCollection.create({ db: database });
    const membership = await memberships.get(workspace.membershipId);
    if (!membership) throw new Error('Synthetic membership is missing.');
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();

    const terminal = await startAndWait(
      await enqueue(workspace.subject, await createOpportunity('revoked')),
    );

    expect(terminal.error?.message).toContain('membership is not active');
    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('rejects a revoked user before the registered method can call business work', async () => {
    const workspace = await createWorkspace('revoked-user');
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    const users = await UserCollection.create({ db: database });
    const user = await users.get(workspace.subject.userId);
    if (!user) throw new Error('Synthetic user is missing.');
    user.status = UserStatus.SUSPENDED;
    await user.save();

    const terminal = await startAndWait(
      await enqueue(workspace.subject, await createOpportunity('revoked-user')),
    );

    expect(terminal.error?.message).toContain('user is not active');
    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('rejects an inactive owned profile before the registered method can call business work', async () => {
    const workspace = await createWorkspace('inactive-profile');
    if (!database) throw new Error('TaskRunner fixture is unavailable.');
    await withTenant(
      {
        tenantId: workspace.subject.tenantId,
        userId: workspace.subject.userId,
      },
      async () => {
        const profiles = await getCollection<CandidateProfile>(
          'CandidateProfile',
          {
            db: database,
          },
        );
        const profile = await profiles.get(workspace.subject.profileId);
        if (!profile)
          throw new Error('Synthetic candidate profile is missing.');
        profile.active = false;
        await profile.save();
      },
    );

    const terminal = await startAndWait(
      await enqueue(
        workspace.subject,
        await createOpportunity('inactive-profile'),
      ),
    );

    expect(terminal.error?.message).toContain(
      'candidate profile is not active',
    );
    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('rejects a durable queue-tenant mismatch before the registered method can call business work', async () => {
    const workspace = await createWorkspace('mismatch');
    const otherWorkspace = await createWorkspace('other-tenant');

    const terminal = await startAndWait(
      await enqueue(
        workspace.subject,
        await createOpportunity('tenant-mismatch'),
        otherWorkspace.subject.tenantId,
      ),
    );

    expect(terminal.error?.message).toContain(
      'Queued job tenant does not match',
    );
    expect(fixture.processor).not.toHaveBeenCalled();
  });

  it('keeps concurrent bound jobs in their own native tenant contexts', async () => {
    const first = await createWorkspace('first');
    const second = await createWorkspace('second');
    const seen: Subject[] = [];
    const waitForBoth = twoJobBarrier();
    fixture.processor.mockImplementation(async () => {
      await waitForBoth();
      const subject = currentWorkspaceSubject();
      if (!subject)
        throw new Error('Expected native workspace subject context.');
      seen.push(subject);
      return { status: 'completed' };
    });
    const firstJob = await enqueue(
      first.subject,
      await createOpportunity('first'),
    );
    const secondJob = await enqueue(
      second.subject,
      await createOpportunity('second'),
    );
    if (!runner) throw new Error('TaskRunner fixture is unavailable.');
    const firstTerminal = waitForTerminalJob(
      runner,
      requiredId(firstJob, 'First job'),
    );
    const secondTerminal = waitForTerminalJob(
      runner,
      requiredId(secondJob, 'Second job'),
    );
    await runner.start();
    const [firstResult, secondResult] = await Promise.all([
      firstTerminal,
      secondTerminal,
    ]);

    expect(firstResult.error).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    expect(seen).toEqual(
      expect.arrayContaining([first.subject, second.subject]),
    );
    expect(seen).toHaveLength(2);
  });

  it('keeps concurrent owned profiles for one user in their own workspace contexts', async () => {
    const workspace = await createWorkspace('same-user');
    const secondProfile = await createOwnedProfile(
      workspace.subject,
      'same-user-second',
    );
    const seen: Subject[] = [];
    const waitForBoth = twoJobBarrier();
    fixture.processor.mockImplementation(async () => {
      await waitForBoth();
      const subject = currentWorkspaceSubject();
      if (!subject)
        throw new Error('Expected native workspace subject context.');
      seen.push(subject);
      return { status: 'completed' };
    });
    const firstJob = await enqueue(
      workspace.subject,
      await createOpportunity('same-user-first'),
    );
    const secondJob = await enqueue(
      secondProfile,
      await createOpportunity('same-user-second'),
    );
    if (!runner) throw new Error('TaskRunner fixture is unavailable.');
    const firstTerminal = waitForTerminalJob(
      runner,
      requiredId(firstJob, 'First job'),
    );
    const secondTerminal = waitForTerminalJob(
      runner,
      requiredId(secondJob, 'Second job'),
    );
    await runner.start();
    const [firstResult, secondResult] = await Promise.all([
      firstTerminal,
      secondTerminal,
    ]);

    expect(firstResult.error).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    expect(seen).toEqual(
      expect.arrayContaining([workspace.subject, secondProfile]),
    );
    expect(seen).toHaveLength(2);
  });
});
