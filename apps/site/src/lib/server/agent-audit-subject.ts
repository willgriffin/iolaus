import {
  PrivateWorkspaceSubjectError,
  recordOwnedBySubject,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { requireCurrentWorkspaceSubject } from './workspace-subject.js';

type PrivateRecord = Record<string, unknown>;
type AuditUser = { id?: string | null };

export interface AgentAuditSubject {
  candidateProfileId: string;
  initiatedByUserId: string;
  ownerUserId: string;
  tenantId: string;
}

function requestedId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the native subject and require its selected candidate profile before a
 * private service reads or writes candidate-owned records.
 */
export function requireCurrentPrivateWorkspaceSubject(): WorkspaceSubject {
  const subject = requireCurrentWorkspaceSubject();
  if (!subject.profileId) {
    throw new PrivateWorkspaceSubjectError('A candidate profile is required.');
  }
  return requireWorkspaceSubject({ ...subject, profileId: subject.profileId });
}

function requireAuditSubject(
  user: AuditUser | null | undefined,
): WorkspaceSubject {
  const subject = requireCurrentPrivateWorkspaceSubject();
  if (user && requestedId(user.id) !== subject.userId) {
    throw new PrivateWorkspaceSubjectError(
      'Agent audit user must match the authenticated workspace subject.',
    );
  }
  return subject;
}

/**
 * Bind an AgentRun to the native, server-verified workspace subject.  Audit
 * callers may name a target, but may never choose its tenant, owner, profile,
 * or initiating user.  Targets with an opaque task id are re-read through the
 * caller's executor before the audit write.
 */
export async function resolveAgentAuditSubject(options: {
  application?: PrivateRecord;
  loadTask?: (id: string) => Promise<PrivateRecord | null>;
  taskId?: string;
  user?: AuditUser | null;
}): Promise<AgentAuditSubject> {
  const subject = requireAuditSubject(options.user);
  const applicationId = requestedId(options.application?.id);
  if (applicationId && !recordOwnedBySubject(options.application, subject)) {
    throw new PrivateWorkspaceSubjectError(
      'Application is outside the authenticated workspace.',
    );
  }

  const taskId = requestedId(options.taskId);
  if (taskId) {
    if (!options.loadTask) {
      throw new PrivateWorkspaceSubjectError(
        'Agent audit task lookup is required.',
      );
    }
    const task = await options.loadTask(taskId);
    if (!recordOwnedBySubject(task, subject)) {
      throw new PrivateWorkspaceSubjectError(
        'Task is outside the authenticated workspace.',
      );
    }
  }

  return {
    candidateProfileId: subject.profileId,
    initiatedByUserId: subject.userId,
    ownerUserId: subject.userId,
    tenantId: subject.tenantId,
  };
}
