import type { SmrtObject } from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionResolver,
  type User,
} from '@happyvertical/smrt-users';
import { isConfiguredOidcAdminEmail } from './administrative-auth.js';
import { getAppConfig } from './app-config.js';
import { getSmrtOptions } from './db.js';
import { getCollection } from './smrt.js';

/**
 * Server-verified identity for a private workspace request. This is the only
 * source of tenant, user, and selected-profile authority for app services.
 */
export interface WorkspaceSubject {
  profileId?: string;
  tenantId: string;
  userId: string;
}

export interface WorkspaceSubjectLocals {
  membership?: {
    roleId?: string | null;
    status?: string | null;
    tenantId?: string | null;
    userId?: string | null;
  } | null;
  permissions?: string[] | null;
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

function identifier(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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

  const memberships = await MembershipCollection.create(getSmrtOptions());
  const membership = await memberships.findByUserAndTenant(userId, tenantId);
  if (
    !membership ||
    membership.status !== MembershipStatus.ACTIVE ||
    !identifier(membership.roleId) ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId
  ) {
    locals.membership = null;
    locals.permissions = [];
    return null;
  }

  const resolver = await PermissionResolver.create(getSmrtOptions());
  const permissions = await resolver.resolvePermissions(userId, tenantId, {
    membership,
  });
  const baseSubject = { tenantId, userId };
  const profileId = await resolveDefaultWorkspaceProfileId(baseSubject);
  const subject = Object.freeze(
    profileId ? { ...baseSubject, profileId } : baseSubject,
  );
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
      ownerUserId: subject.userId,
      profileKey: 'default',
      tenantId: subject.tenantId,
    },
  });
  const profile = records[0] as unknown as Record<string, unknown> | undefined;
  if (
    !profile ||
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
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    !context?.tenantId ||
    !context.userId
  ) {
    return null;
  }
  const subject = candidate as Partial<WorkspaceSubject>;
  if (
    subject.tenantId !== context.tenantId ||
    subject.userId !== context.userId
  ) {
    return null;
  }
  return subject as WorkspaceSubject;
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
): Promise<WorkspaceSubject> {
  const subject = requireCurrentWorkspaceSubject();
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
    String(record.tenantId ?? '') !== subject.tenantId ||
    String(record.ownerUserId ?? '') !== subject.userId
  ) {
    throw new WorkspaceSubjectError(
      403,
      'Candidate profile is outside this workspace.',
    );
  }
  const selectedSubject = Object.freeze({ ...subject, profileId: selectedId });
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
  context.metadata = {
    ...context.metadata,
    workspaceSubject: selectedSubject,
  };
  return selectedSubject;
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
