import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  shared: true,
  operator: false,
  subject: {
    tenantId: 'tenant-a',
    userId: 'user-a',
    profileId: 'profile-a',
  } as { tenantId: string; userId: string; profileId?: string } | null,
}));
vi.mock('./app-config.js', () => ({ isSharedHosted: () => state.shared }));
vi.mock('./workspace-subject.js', () => ({
  getCurrentWorkspaceSubject: () => state.subject,
  isCurrentWorkspaceOperator: () => state.operator,
}));
vi.mock('./private-workspace.js', () => ({
  candidateProfileWhere: (subject: any) => ({
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
  }),
  privateRecordWhere: (subject: any) => ({
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    candidateProfileId: subject.profileId,
  }),
  requireWorkspaceSubject: (subject: any) => subject,
}));

import {
  assertGenericResourceAccess,
  assertWorkspaceResourceWritable,
  workspaceRecordAllowed,
  workspaceResourcePayload,
  workspaceResourceWhere,
} from './workspace-resource-policy.js';

describe('shared workspace resource boundary', () => {
  beforeEach(() => {
    state.shared = true;
    state.operator = false;
    state.subject = {
      tenantId: 'tenant-a',
      userId: 'user-a',
      profileId: 'profile-a',
    };
  });
  it('narrows private records by all ownership dimensions', () => {
    expect(workspaceResourceWhere('Application')).toEqual({
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      candidateProfileId: 'profile-a',
    });
    expect(
      workspaceRecordAllowed('Application', {
        tenantId: 'tenant-a',
        ownerUserId: 'user-a',
        candidateProfileId: 'profile-b',
      }),
    ).toBe(false);
    expect(
      workspaceRecordAllowed('Application', {
        tenantId: 'tenant-b',
        ownerUserId: 'user-a',
        candidateProfileId: 'profile-a',
      }),
    ).toBe(false);
  });
  it('rejects ownership forgery and absent selected profiles', () => {
    expect(() =>
      workspaceResourcePayload('Application', { ownerUserId: 'other' }),
    ).toThrow();
    state.subject = { tenantId: 'tenant-a', userId: 'user-a' };
    expect(() => workspaceResourceWhere('Application')).toThrow();
  });
  it('resolves switching and concurrent contexts on every call', () => {
    expect(workspaceResourceWhere('CandidateProfile').id).toBe('profile-a');
    state.subject = {
      tenantId: 'tenant-b',
      userId: 'user-b',
      profileId: 'profile-b',
    };
    expect(workspaceResourceWhere('CandidateProfile')).toEqual({
      id: 'profile-b',
      tenantId: 'tenant-b',
      ownerUserId: 'user-b',
    });
  });
  it('keeps catalog mutation and raw generated access operator-only', () => {
    expect(() => assertWorkspaceResourceWritable('Opportunity')).toThrow();
    expect(() => assertGenericResourceAccess()).toThrow();
    expect(() => assertWorkspaceResourceWritable('Application')).not.toThrow();
    state.operator = true;
    expect(() => assertWorkspaceResourceWritable('Opportunity')).not.toThrow();
  });
  it('denies broad facts and governance controls even with a workspace', () => {
    expect(() => workspaceResourceWhere('Fact')).toThrow();
    expect(() =>
      workspaceResourceWhere('OpportunityIntelligenceControl'),
    ).toThrow();
  });
  it('preserves private installation resource behavior', () => {
    state.shared = false;
    state.subject = null;
    expect(workspaceResourceWhere('Application')).toEqual({});
    expect(() => assertGenericResourceAccess()).not.toThrow();
  });
});
