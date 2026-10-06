import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireCurrentWorkspaceSubject: vi.fn(),
}));

vi.mock('./workspace-subject.js', () => ({
  requireCurrentWorkspaceSubject: mocks.requireCurrentWorkspaceSubject,
}));

import { resolveAgentAuditSubject } from './agent-audit-subject.js';
import { PrivateWorkspaceSubjectError } from './private-workspace.js';

const owner = {
  profileId: 'profile-owner',
  tenantId: 'tenant-1',
  userId: 'user-owner',
};

const owned = {
  candidateProfileId: owner.profileId,
  ownerUserId: owner.userId,
  tenantId: owner.tenantId,
};

describe('agent audit subject binding', () => {
  beforeEach(() => {
    mocks.requireCurrentWorkspaceSubject.mockReset();
    mocks.requireCurrentWorkspaceSubject.mockReturnValue(owner);
  });

  it('derives every audit identity field from the current verified subject', async () => {
    const loadTask = vi.fn(async () => ({ id: 'task-1', ...owned }));

    await expect(
      resolveAgentAuditSubject({
        application: { id: 'application-1', ...owned },
        loadTask,
        taskId: 'task-1',
        user: { id: owner.userId },
      }),
    ).resolves.toEqual({
      candidateProfileId: owner.profileId,
      initiatedByUserId: owner.userId,
      ownerUserId: owner.userId,
      tenantId: owner.tenantId,
    });
    expect(loadTask).toHaveBeenCalledWith('task-1');
  });

  it('fails closed when the native subject has no selected profile', async () => {
    mocks.requireCurrentWorkspaceSubject.mockReturnValue({
      tenantId: owner.tenantId,
      userId: owner.userId,
    });

    await expect(resolveAgentAuditSubject({})).rejects.toBeInstanceOf(
      PrivateWorkspaceSubjectError,
    );
  });

  it('rejects a forged user before looking up or writing a target', async () => {
    const loadTask = vi.fn(async () => ({ id: 'task-1', ...owned }));

    await expect(
      resolveAgentAuditSubject({
        loadTask,
        taskId: 'task-1',
        user: { id: 'user-forged' },
      }),
    ).rejects.toThrow('must match');
    expect(loadTask).not.toHaveBeenCalled();
  });

  it('rejects an application owned by another profile in the same tenant', async () => {
    await expect(
      resolveAgentAuditSubject({
        application: {
          id: 'application-foreign',
          ...owned,
          candidateProfileId: 'profile-foreign',
        },
      }),
    ).rejects.toThrow('Application is outside');
  });

  it('rejects an application target with missing ownership', async () => {
    await expect(
      resolveAgentAuditSubject({ application: { id: 'application-legacy' } }),
    ).rejects.toThrow('Application is outside');
  });

  it('rejects a task owned by another profile in the same tenant', async () => {
    await expect(
      resolveAgentAuditSubject({
        loadTask: async () => ({
          id: 'task-foreign',
          ...owned,
          candidateProfileId: 'profile-foreign',
        }),
        taskId: 'task-foreign',
      }),
    ).rejects.toThrow('Task is outside');
  });
});
