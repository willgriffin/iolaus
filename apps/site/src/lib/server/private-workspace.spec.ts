import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPrivateRecord,
  getPrivateRecord,
  listPrivateRecords,
  PrivateWorkspaceSubjectError,
  privateRecordWhere,
  requireWorkspaceSubject,
} from './private-workspace.js';

const mocks = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({
    create: mocks.create,
    get: async (id: string) => mocks.records.get(id) ?? null,
    list: mocks.list,
  })),
}));

const owner = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
};
const otherProfile = {
  profileId: 'profile-b',
  tenantId: 'tenant-a',
  userId: 'user-b',
};

describe('private workspace ownership helpers', () => {
  beforeEach(() => {
    mocks.records.clear();
    mocks.list.mockReset();
    mocks.create.mockReset();
  });

  it('requires a complete, well-formed tenant/user/profile subject', () => {
    expect(privateRecordWhere(owner)).toEqual({
      candidateProfileId: 'profile-a',
      ownerUserId: 'user-a',
      tenantId: 'tenant-a',
    });
    expect(() =>
      requireWorkspaceSubject({ ...owner, profileId: 'bad\nprofile' }),
    ).toThrow(PrivateWorkspaceSubjectError);
    expect(() => requireWorkspaceSubject({ ...owner, tenantId: '' })).toThrow(
      'Invalid tenant ID.',
    );
  });

  it('never returns another profile record, even when the collection get leaks it', async () => {
    mocks.records.set('asset-foreign', {
      candidateProfileId: otherProfile.profileId,
      id: 'asset-foreign',
      ownerUserId: otherProfile.userId,
      tenantId: otherProfile.tenantId,
    });

    await expect(
      getPrivateRecord('ResumeAsset', 'asset-foreign', owner),
    ).resolves.toBeNull();
  });

  it('adds the immutable ownership predicate and defensively filters faulty list adapters', async () => {
    const own = { ...privateRecordWhere(owner), id: 'application-a' };
    const foreign = {
      ...privateRecordWhere(otherProfile),
      id: 'application-b',
    };
    mocks.list.mockResolvedValue([own, foreign]);

    await expect(
      listPrivateRecords('Application', owner, {
        limit: 50,
        where: { status: 'draft', tenantId: 'forged' },
      }),
    ).resolves.toEqual([own]);
    expect(mocks.list).toHaveBeenCalledWith({
      limit: 50,
      where: { ...privateRecordWhere(owner), status: 'draft' },
    });
  });

  it('derives ownership on create and rejects a forged cross-profile payload', async () => {
    mocks.create.mockImplementation(async (payload) => payload);
    await expect(
      createPrivateRecord('Application', owner, { status: 'draft' }),
    ).resolves.toMatchObject({ ...privateRecordWhere(owner), status: 'draft' });
    await expect(
      createPrivateRecord('Application', owner, {
        candidateProfileId: otherProfile.profileId,
      }),
    ).rejects.toThrow(PrivateWorkspaceSubjectError);
  });
});
