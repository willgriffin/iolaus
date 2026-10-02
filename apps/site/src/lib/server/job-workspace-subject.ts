import {
  executeAsPrincipal,
  type PrincipalRun,
} from '@happyvertical/smrt-agents';
import {
  getActiveJobExecutionContext,
  isRunnerExecutionContext,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  TenantCollection,
  TenantStatus,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { getAppConfig, getAuthConfiguration } from './app-config.js';
import { getSmrtOptions } from './db.js';
import {
  getPrivateRecord,
  requireWorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';
import { requireCurrentWorkspaceSubject } from './workspace-subject.js';
import {
  type WorkspaceWorkflowCapability,
  workspaceWorkflowOperation,
} from './workspace-workflow-capabilities.js';

/** Durable, canonical owner tuple stored in candidate-owned job arguments. */
export interface RuntimeWorkspaceSubject {
  profileId: string;
  tenantId: string;
  userId: string;
}

export const RUNTIME_WORKSPACE_SUBJECT_KEY = 'runtimeWorkspaceSubject';

export class JobWorkspaceSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobWorkspaceSubjectError';
  }
}

type UnknownRecord = Record<string, unknown>;

type UserCollectionLike = {
  get: (id: string) => Promise<{
    email?: unknown;
    id?: unknown;
    status?: unknown;
  } | null>;
};

type MembershipCollectionLike = {
  findByUserAndTenant: (
    userId: string,
    tenantId: string,
  ) => Promise<{
    roleId?: unknown;
    status?: unknown;
    tenantId?: unknown;
    userId?: unknown;
  } | null>;
};

export interface JobWorkspaceSubjectDependencies {
  candidateProfiles?: {
    get: (id: string) => Promise<UnknownRecord | null>;
  };
  memberships?: MembershipCollectionLike;
  tenants?: {
    get: (id: string) => Promise<{ id?: unknown; status?: unknown } | null>;
  };
  users?: UserCollectionLike;
}

function exactIdentifier(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value : '';
  if (
    !id ||
    id !== id.trim() ||
    id.length > 160 ||
    Array.from(id).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new JobWorkspaceSubjectError(`A valid ${label} is required.`);
  }
  return id;
}

function equalId(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value === expected;
}

function subjectFrom(value: unknown): RuntimeWorkspaceSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobWorkspaceSubjectError(
      'Candidate-owned jobs require a runtime workspace subject.',
    );
  }
  const candidate = value as UnknownRecord;
  const subject = requireWorkspaceSubject({
    profileId: exactIdentifier(candidate.profileId, 'candidate profile ID'),
    tenantId: exactIdentifier(candidate.tenantId, 'tenant ID'),
    userId: exactIdentifier(candidate.userId, 'user ID'),
  });
  return Object.freeze({ ...subject });
}

/** Read the canonical envelope from a durable job argument object. */
export function runtimeWorkspaceSubjectFromJobArgs(
  args: Record<string, unknown> | null | undefined,
): RuntimeWorkspaceSubject {
  return subjectFrom(args?.[RUNTIME_WORKSPACE_SUBJECT_KEY]);
}

function rejectSpoofedSubjectValues(args: Record<string, unknown>): void {
  const reserved = [
    RUNTIME_WORKSPACE_SUBJECT_KEY,
    'candidateProfileId',
    'ownerUserId',
    'profileId',
    'tenantId',
    'userId',
  ];
  for (const key of reserved) {
    if (key in args) {
      throw new JobWorkspaceSubjectError(
        `Job argument ${key} cannot set workspace ownership.`,
      );
    }
  }
}

/**
 * Capture the current server-verified subject for a new candidate-owned job.
 * Callers cannot pass a subject value: queued authority is derived only here.
 */
export function captureRuntimeWorkspaceSubject(): RuntimeWorkspaceSubject {
  return subjectFrom(requireCurrentWorkspaceSubject());
}

/**
 * Add the canonical job envelope while rejecting ownership fields supplied by a
 * route, tool, or caller. This must run before `SmrtJobCollection.create()`.
 */
export function withRuntimeWorkspaceSubject<T extends Record<string, unknown>>(
  args: T,
): T & { runtimeWorkspaceSubject: RuntimeWorkspaceSubject } {
  rejectSpoofedSubjectValues(args);
  return {
    ...args,
    [RUNTIME_WORKSPACE_SUBJECT_KEY]: captureRuntimeWorkspaceSubject(),
  };
}

/**
 * Reject a stored object whose physical ownership tuple does not exactly match
 * the freshly resolved job subject. This is intentionally usable for Task and
 * AgentRun as soon as their ownership fields are available in the runtime.
 */
export function requireJobResourceOwnedBySubject(
  resource: UnknownRecord | null | undefined,
  subject: RuntimeWorkspaceSubject,
  label = 'job resource',
): UnknownRecord {
  if (
    !resource ||
    !equalId(resource.tenantId, subject.tenantId) ||
    !equalId(resource.ownerUserId, subject.userId) ||
    !equalId(resource.candidateProfileId, subject.profileId)
  ) {
    throw new JobWorkspaceSubjectError(
      `${label} is outside the queued workspace subject.`,
    );
  }
  return resource;
}

/**
 * The queue row's tenant is independent durable state. A candidate envelope
 * cannot move a claimed job across tenants by merely changing JSON arguments.
 */
export function assertJobTenantMatchesRuntimeWorkspaceSubject(
  job: { tenantId?: unknown } | null | undefined,
  subject: RuntimeWorkspaceSubject,
): void {
  if (!job || !equalId(job.tenantId, subject.tenantId)) {
    throw new JobWorkspaceSubjectError(
      'Queued job tenant does not match its workspace subject.',
    );
  }
}

/**
 * A shape-compatible JSON object is never enough to grant queued authority.
 * SMRT brands contexts in the runner and keeps the active one in its own ALS;
 * requiring both prevents direct method calls from forging a durable job row.
 */
export function requireActiveRunnerExecutionContext(
  context: unknown,
): JobExecutionContext {
  if (
    !isRunnerExecutionContext(context) ||
    getActiveJobExecutionContext() !== context
  ) {
    throw new JobWorkspaceSubjectError(
      'Candidate-owned jobs require an active TaskRunner execution context.',
    );
  }
  return context;
}

/** Load a candidate-owned resource only after worker context has been restored. */
export async function getJobPrivateResource(
  className: string,
  id: string,
  subject: RuntimeWorkspaceSubject,
): Promise<UnknownRecord> {
  const resource = await getPrivateRecord(
    className,
    id,
    requireWorkspaceSubject(subject),
  );
  return requireJobResourceOwnedBySubject(resource, subject, className);
}

interface IdentityDependencies {
  memberships: MembershipCollectionLike;
  tenants: NonNullable<JobWorkspaceSubjectDependencies['tenants']>;
  users: UserCollectionLike;
}

async function liveIdentityDependencies(
  dependencies: JobWorkspaceSubjectDependencies,
): Promise<IdentityDependencies> {
  return {
    memberships:
      dependencies.memberships ??
      ((await MembershipCollection.create(
        getSmrtOptions(),
      )) as unknown as MembershipCollectionLike),
    tenants:
      dependencies.tenants ??
      ((await TenantCollection.create(
        getSmrtOptions(),
      )) as unknown as IdentityDependencies['tenants']),
    users:
      dependencies.users ??
      ((await UserCollection.create(
        getSmrtOptions(),
      )) as unknown as UserCollectionLike),
  };
}

async function validateLiveUserAndMembership(
  subject: RuntimeWorkspaceSubject,
  dependencies: IdentityDependencies,
): Promise<{ email?: unknown; id?: unknown; status?: unknown }> {
  const [tenant, user, membership] = await Promise.all([
    dependencies.tenants.get(subject.tenantId),
    dependencies.users.get(subject.userId),
    dependencies.memberships.findByUserAndTenant(
      subject.userId,
      subject.tenantId,
    ),
  ]);
  if (
    !tenant ||
    !equalId(tenant.id, subject.tenantId) ||
    tenant.status !== TenantStatus.ACTIVE
  ) {
    throw new JobWorkspaceSubjectError('Queued job tenant is not active.');
  }
  if (
    !user ||
    !equalId(user.id, subject.userId) ||
    user.status !== UserStatus.ACTIVE
  ) {
    throw new JobWorkspaceSubjectError('Queued job user is not active.');
  }
  if (
    !membership ||
    membership.status !== MembershipStatus.ACTIVE ||
    !equalId(membership.userId, subject.userId) ||
    !equalId(membership.tenantId, subject.tenantId) ||
    !exactIdentifier(membership.roleId, 'membership role ID')
  ) {
    throw new JobWorkspaceSubjectError(
      'Queued job membership is not active for this workspace.',
    );
  }
  const app = getAppConfig();
  if (app.runtimeProfile !== 'local' && app.workspaceMode === 'private') {
    const authentication = getAuthConfiguration();
    const email =
      typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (
      authentication.kind !== 'self-hosted' ||
      !email ||
      !authentication.oidc.adminEmails.includes(email)
    ) {
      throw new JobWorkspaceSubjectError(
        'Queued job owner is no longer authorized in this private workspace.',
      );
    }
  }
  return user;
}

async function validateOwnedActiveProfile(
  subject: RuntimeWorkspaceSubject,
  candidateProfiles: NonNullable<
    JobWorkspaceSubjectDependencies['candidateProfiles']
  >,
): Promise<void> {
  const profile = await candidateProfiles.get(subject.profileId);
  if (
    !profile ||
    profile.active !== true ||
    !equalId(profile.id, subject.profileId) ||
    !equalId(profile.tenantId, subject.tenantId) ||
    !equalId(profile.ownerUserId, subject.userId)
  ) {
    throw new JobWorkspaceSubjectError(
      'Queued job candidate profile is not active in this workspace.',
    );
  }
}

/**
 * Recheck a previously accepted subject at a write fence. Call this inside the
 * native principal/tenant context after long-running work and before a private
 * reload or mutation, so suspension, role revocation, profile reassignment,
 * and private-hosted owner removal take effect before persistence.
 */
export async function revalidateRuntimeWorkspaceSubject(
  subject: RuntimeWorkspaceSubject,
  dependencies: JobWorkspaceSubjectDependencies = {},
): Promise<RuntimeWorkspaceSubject> {
  const revalidated = subjectFrom(subject);
  const context = getCurrentTenant();
  if (
    !context ||
    context.tenantId !== revalidated.tenantId ||
    context.userId !== revalidated.userId
  ) {
    throw new JobWorkspaceSubjectError(
      'Queued job could not restore its native workspace context.',
    );
  }
  const identity = await liveIdentityDependencies(dependencies);
  const user = await validateLiveUserAndMembership(revalidated, identity);
  context.metadata = {
    ...context.metadata,
    workspaceSubject: revalidated,
  };
  context.user = user;
  const candidateProfiles =
    dependencies.candidateProfiles ??
    ((await getCollection('CandidateProfile')) as unknown as NonNullable<
      JobWorkspaceSubjectDependencies['candidateProfiles']
    >);
  await validateOwnedActiveProfile(revalidated, candidateProfiles);
  return revalidated;
}

async function executeAsRevalidatedWorkspaceSubject<T>(
  subject: RuntimeWorkspaceSubject,
  capability: WorkspaceWorkflowCapability | undefined,
  work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
  dependencies: JobWorkspaceSubjectDependencies,
): Promise<T> {
  const identity = await liveIdentityDependencies(dependencies);
  const user = await validateLiveUserAndMembership(subject, identity);
  return await executeAsPrincipal(
    {
      ...getSmrtOptions(),
      action: 'jobs.workspace_subject.execute',
      onBehalfOfUserId: subject.userId,
      postgresRls: false,
      principal: {
        allowedTools: [],
        runAsUserId: subject.userId,
        tenantId: subject.tenantId,
      },
    },
    async (run) => {
      const context = getCurrentTenant();
      if (
        !context ||
        context.tenantId !== subject.tenantId ||
        context.userId !== subject.userId
      ) {
        throw new JobWorkspaceSubjectError(
          'Queued job could not restore its native workspace context.',
        );
      }
      // Preserve the actual freshly loaded principal; a queued ID or a stale
      // request user must never become the context's user object.
      context.user = user;
      const revalidated = await revalidateRuntimeWorkspaceSubject(
        subject,
        dependencies,
      );
      if (capability) {
        const operation = workspaceWorkflowOperation(capability);
        await run.assertOperation(operation.collection, operation.action);
      }
      return await work(revalidated, run);
    },
  );
}

/**
 * Enter a new native principal scope for the final write fence. The entire
 * callback runs under that new context, after current identity/profile checks
 * and the explicit workflow capability assertion have succeeded.
 */
export async function runAsRevalidatedJobWorkspaceSubject<T>(
  subject: RuntimeWorkspaceSubject,
  capability: WorkspaceWorkflowCapability,
  work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
  dependencies: JobWorkspaceSubjectDependencies = {},
): Promise<T> {
  return await executeAsRevalidatedWorkspaceSubject(
    subjectFrom(subject),
    capability,
    work,
    dependencies,
  );
}

/**
 * Revalidate one durable envelope and run work inside SMRT's native tenant and
 * principal contexts. The profile is intentionally loaded only after those
 * contexts are installed; this avoids an unscoped private collection lookup.
 */
export async function runAsResolvedJobWorkspaceSubject<T>(
  args: Record<string, unknown> | null | undefined,
  work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
  dependencies: JobWorkspaceSubjectDependencies = {},
): Promise<T> {
  const subject = runtimeWorkspaceSubjectFromJobArgs(args);
  return await executeAsRevalidatedWorkspaceSubject(
    subject,
    undefined,
    work,
    dependencies,
  );
}
