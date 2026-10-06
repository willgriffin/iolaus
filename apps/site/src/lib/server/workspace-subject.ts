import type { SmrtObject } from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionResolver,
  TenantCollection,
  type User,
  UserCollection,
} from '@happyvertical/smrt-users';
import { isConfiguredOidcAdminEmail } from './administrative-auth.js';
import { getAppConfig } from './app-config.js';
import { getSmrtOptions } from './db.js';
import { isEmailInvited } from './hosted-invite.js';
import { getCollection, getRequestScopedSmrtOptions } from './smrt.js';

/**
 * Server-verified identity for a private workspace request. This is the only
 * source of tenant, user, and selected-profile authority for app services.
 */
export interface WorkspaceSubject {
  profileId?: string;
  tenantId: string;
  userId: string;
}

/**
 * A workspace identity whose selected candidate profile has been verified.
 * Private record helpers accept the broader identity subject, then return this
 * type only after rejecting a missing profile selector.
 */
export interface CandidateWorkspaceSubject extends WorkspaceSubject {
  profileId: string;
}

export interface WorkspaceSubjectLocals {
  invitationRequired?: boolean;
  membership?: {
    roleId?: string | null;
    status?: string | null;
    tenantId?: string | null;
    userId?: string | null;
  } | null;
  permissions?: readonly string[] | null;
  tenantId?: string | null;
  user?: Pick<User, 'id'> | null;
  workspaceSubject?: WorkspaceSubject;
}

export class WorkspaceSubjectError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'WorkspaceSubjectError';
    this.status = status;
  }
}

/** A shared-mode identity whose operator invitation is missing or revoked. */
export class WorkspaceNotInvitedError extends WorkspaceSubjectError {
  constructor() {
    super(403, 'Workspace invitation is not active.');
    this.name = 'WorkspaceNotInvitedError';
  }
}

/**
 * Narrow an authenticated workspace identity for candidate-owned operations.
 * This validates shape only; callers that accept a new selector must still use
 * `resolveWorkspaceSubjectForProfile` to prove profile ownership in storage.
 */
export function requireCandidateWorkspaceSubject(
  subject: WorkspaceSubject | null | undefined,
): CandidateWorkspaceSubject {
  const tenantId = identifier(subject?.tenantId);
  const userId = identifier(subject?.userId);
  const profileId = identifier(subject?.profileId);
  if (!tenantId || !userId || !profileId) {
    throw new WorkspaceSubjectError(
      403,
      'A verified candidate profile workspace subject is required.',
    );
  }
  return { profileId, tenantId, userId };
}

function identifier(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isActiveMembership(
  membership: WorkspaceSubjectLocals['membership'],
  userId: string,
  tenantId: string,
): boolean {
  return Boolean(
    membership &&
      membership.status === MembershipStatus.ACTIVE &&
      membership.userId === userId &&
      membership.tenantId === tenantId &&
      identifier(membership.roleId),
  );
}

/** Re-read identity at a mutation boundary without changing the selected profile. */
export async function revalidateWorkspaceIdentity(
  subject: Pick<WorkspaceSubject, 'tenantId' | 'userId'>,
) {
  const { tenantId, userId } = subject;
  const [users, tenants, memberships] = await Promise.all([
    UserCollection.create(getRequestScopedSmrtOptions()),
    TenantCollection.create(getRequestScopedSmrtOptions()),
    MembershipCollection.create(getRequestScopedSmrtOptions()),
  ]);
  const [user, tenant, membership] = await Promise.all([
    users.get({ id: userId }),
    tenants.get({ id: tenantId }),
    memberships.findByUserAndTenant(userId, tenantId),
  ]);
  if (
    !user ||
    user.id !== userId ||
    user.isActive() !== true ||
    !tenant ||
    tenant.id !== tenantId ||
    tenant.isActive() !== true ||
    !membership ||
    membership.status !== MembershipStatus.ACTIVE ||
    !identifier(membership.roleId) ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId
  ) {
    throw new WorkspaceSubjectError(
      403,
      'Workspace identity is no longer active.',
    );
  }

  if (
    getAppConfig().runtimeProfile !== 'local' &&
    getAppConfig().workspaceMode === 'private' &&
    !isConfiguredOidcAdminEmail(user.email)
  ) {
    throw new WorkspaceSubjectError(
      403,
      'Workspace owner is no longer authorized.',
    );
  }
  // A shared installation is invite-only. Re-read the operator's invite list on
  // every revalidation (browser, CLI, MCP, jobs) so a revocation ends existing
  // sessions at their next use, exactly as private-mode admin emails do.
  if (
    getAppConfig().runtimeProfile !== 'local' &&
    getAppConfig().workspaceMode === 'shared' &&
    !(await isEmailInvited(user.email))
  ) {
    throw new WorkspaceNotInvitedError();
  }
  return { membership, user };
}

/**
 * Re-read the live membership and permission set. Session snapshots are never
 * sufficient workspace authority: suspension and role changes take effect on
 * the next request, for both browser cookies and CLI bearer sessions.
 */
export async function verifyWorkspaceSubject(
  locals: WorkspaceSubjectLocals,
): Promise<WorkspaceSubject | null> {
  const userId = identifier(locals.user?.id);
  const tenantId = identifier(locals.tenantId);
  if (!userId || !tenantId) return null;

  let identity: Awaited<ReturnType<typeof revalidateWorkspaceIdentity>>;
  try {
    identity = await revalidateWorkspaceIdentity({ tenantId, userId });
  } catch (cause) {
    if (!(cause instanceof WorkspaceSubjectError)) throw cause;
    // Lets the request guard send a browser to the invite page instead of a
    // bare 403. Never set for any other failure.
    if (cause instanceof WorkspaceNotInvitedError) {
      locals.invitationRequired = true;
    }
    locals.membership = null;
    locals.permissions = [];
    return null;
  }
  const { membership, user } = identity;

  const resolver = await PermissionResolver.create(getSmrtOptions());
  const permissions = await resolver.resolvePermissions(userId, tenantId, {
    membership,
  });
  const baseSubject = { tenantId, userId };
  const profileId = await resolveDefaultWorkspaceProfileId(baseSubject);
  const subject = Object.freeze(
    profileId ? { ...baseSubject, profileId } : baseSubject,
  );
  locals.user = user;
  locals.membership = membership;
  locals.permissions = [...permissions.permissions];
  locals.workspaceSubject = subject;

  // `withSessionPermissionContext` has already installed the public SMRT
  // tenant context. Enrich its application metadata instead of introducing a
  // second AsyncLocalStorage channel that could drift from tenancy/RLS.
  const context = getCurrentTenant();
  if (context?.tenantId === tenantId && context.userId === userId) {
    context.metadata = { ...context.metadata, workspaceSubject: subject };
  }
  return subject;
}

/**
 * The default profile key is a server-side selector, narrowed by the verified
 * tenant and owner. No first-row fallback is permitted: a profile-less user is
 * routed to onboarding and private record services must deny access.
 */
async function resolveDefaultWorkspaceProfileId(
  subject: Pick<WorkspaceSubject, 'tenantId' | 'userId'>,
): Promise<string | undefined> {
  const profiles = await getCollection<SmrtObject>('CandidateProfile');
  const records = await profiles.list({
    limit: 2,
    where: {
      active: true,
      ownerUserId: subject.userId,
      profileKey: 'default',
      tenantId: subject.tenantId,
    },
  });
  if (records.length !== 1) return undefined;
  const profile = records[0] as unknown as Record<string, unknown> | undefined;
  if (
    !profile ||
    profile.active !== true ||
    String(profile.tenantId ?? '') !== subject.tenantId ||
    String(profile.ownerUserId ?? '') !== subject.userId ||
    String(profile.profileKey ?? '') !== 'default'
  ) {
    return undefined;
  }
  const id = identifier(String(profile.id ?? ''));
  return id ?? undefined;
}

/**
 * Read the request's already-verified subject from SMRT's public tenant
 * context. Services use this rather than accepting tenant or user IDs from a
 * route, tool, or form payload.
 */
/** Return the verified SMRT-bound workspace subject, if this is a request scope. */
export function getCurrentWorkspaceSubject(): WorkspaceSubject | null {
  const context = getCurrentTenant();
  const candidate = context?.metadata?.workspaceSubject;
  if (!isRecord(candidate) || !context?.tenantId || !context.userId) {
    return null;
  }
  const tenantId = identifier(
    typeof candidate.tenantId === 'string' ? candidate.tenantId : undefined,
  );
  const userId = identifier(
    typeof candidate.userId === 'string' ? candidate.userId : undefined,
  );
  const profileId = identifier(
    typeof candidate.profileId === 'string' ? candidate.profileId : undefined,
  );
  if (
    !tenantId ||
    !userId ||
    tenantId !== context.tenantId ||
    userId !== context.userId
  ) {
    return null;
  }
  return profileId ? { profileId, tenantId, userId } : { tenantId, userId };
}

export function requireCurrentWorkspaceSubject(): WorkspaceSubject {
  const subject = getCurrentWorkspaceSubject();
  if (!subject) {
    throw new WorkspaceSubjectError(
      401,
      'A verified workspace subject is required.',
    );
  }
  return subject;
}

/** Return the current server-bound subject only when it includes a profile. */
export function requireCurrentCandidateWorkspaceSubject(): CandidateWorkspaceSubject {
  return requireCandidateWorkspaceSubject(requireCurrentWorkspaceSubject());
}

/**
 * Shared-mode writes to global/operator data require an explicit current OIDC
 * operator allowlist entry. Private and local modes already have that boundary
 * at the authenticated request guard.
 */
export function isCurrentWorkspaceOperator(): boolean {
  const configuration = getAppConfig();
  if (
    configuration.runtimeProfile === 'local' ||
    configuration.workspaceMode === 'private'
  ) {
    return true;
  }
  const user = getCurrentTenant()?.user as
    | { email?: string | null }
    | undefined;
  return isConfiguredOidcAdminEmail(user?.email);
}

/**
 * Resolve a selected candidate profile only after the caller's tenant and
 * owner identity are established. A supplied profile id is a selector, never
 * a grant: the record must prove both values before it becomes part of the
 * returned subject.
 */
export async function resolveWorkspaceSubjectForProfile(
  profileId: string,
): Promise<CandidateWorkspaceSubject> {
  const subject = requireCurrentWorkspaceSubject();
  return await resolveVerifiedWorkspaceSubjectProfile(subject, profileId);
}

async function resolveVerifiedWorkspaceSubjectProfile(
  subject: WorkspaceSubject,
  profileId: string,
): Promise<CandidateWorkspaceSubject> {
  const selectedId = identifier(profileId);
  if (!selectedId) {
    throw new WorkspaceSubjectError(
      403,
      'A candidate profile selection is required.',
    );
  }
  const profiles = await getCollection<SmrtObject>('CandidateProfile');
  const profile = await profiles.get(selectedId);
  const record = profile as unknown as Record<string, unknown> | null;
  if (
    !record ||
    String(record.id ?? '') !== selectedId ||
    record.active !== true ||
    String(record.tenantId ?? '') !== subject.tenantId ||
    String(record.ownerUserId ?? '') !== subject.userId
  ) {
    throw new WorkspaceSubjectError(
      403,
      'Candidate profile is outside this workspace.',
    );
  }
  return Object.freeze(
    requireCandidateWorkspaceSubject({ ...subject, profileId: selectedId }),
  );
}

/**
 * Re-bind a server-resolved subject in a fresh principal context. The input is
 * checked against the active SMRT context and any profile id is revalidated;
 * callers must never construct this from route or tool arguments.
 */
export async function withVerifiedWorkspaceSubject<T>(
  subject: WorkspaceSubject,
  fn: (subject: WorkspaceSubject) => Promise<T>,
): Promise<T> {
  const context = getCurrentTenant();
  if (
    !context ||
    context.tenantId !== subject.tenantId ||
    context.userId !== subject.userId
  ) {
    throw new WorkspaceSubjectError(
      403,
      'Workspace subject context is invalid.',
    );
  }
  const { user } = await revalidateWorkspaceIdentity(subject);
  const verified = subject.profileId
    ? await resolveVerifiedWorkspaceSubjectProfile(subject, subject.profileId)
    : Object.freeze({ tenantId: subject.tenantId, userId: subject.userId });
  return await withTenant(
    {
      ...context,
      user,
      metadata: { ...context.metadata, workspaceSubject: verified },
    },
    async () => await fn(verified),
  );
}

/**
 * Run a profile-specific operation in a cloned public SMRT tenant context.
 * The selected profile is bounded to this callback and cannot alter a sibling
 * promise sharing the request's original context.
 */
export async function withWorkspaceSubjectForProfile<T>(
  profileId: string,
  fn: (subject: CandidateWorkspaceSubject) => Promise<T>,
): Promise<T> {
  const subject = await resolveWorkspaceSubjectForProfile(profileId);
  return await withVerifiedWorkspaceSubject(
    subject,
    async (verified) => await fn(requireCandidateWorkspaceSubject(verified)),
  );
}

/** Guard for pure callers that only have locals after the hook has run. */
export function workspaceSubjectFromLocals(
  locals: WorkspaceSubjectLocals,
): WorkspaceSubject {
  const subject = locals.workspaceSubject;
  if (
    !subject ||
    !isActiveMembership(locals.membership, subject.userId, subject.tenantId) ||
    locals.tenantId !== subject.tenantId ||
    locals.user?.id !== subject.userId
  ) {
    throw new WorkspaceSubjectError(403, 'Workspace session is not verified.');
  }
  return subject;
}
