import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  assert: vi.fn(),
  resolve: vi.fn(),
  profile: vi.fn(),
  source: vi.fn(),
  project: vi.fn(),
  render: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  reserve: vi.fn(),
  prepare: vi.fn(),
  getPrepared: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  getOwner: vi.fn(),
  resolvePublic: vi.fn(),
  list: vi.fn(),
  listRevisions: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: vi.fn(async () => ({})),
}));
vi.mock('./app-config.js', () => ({ isSharedHosted: () => true }));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./owner-principal.js', () => ({ runAsOwner: mocks.owner }));
vi.mock('./workspace-workflow-capabilities.js', () => ({
  workspaceWorkflowOperation: () => ({
    collection: 'workflow',
    action: 'public-profile.manage',
  }),
}));
vi.mock('./workspace-subject.js', () => ({
  workspaceSubjectFromLocals: () => ({ userId: 'owner', tenantId: 'tenant' }),
  resolveWorkspaceSubjectForProfile: mocks.resolve,
}));
vi.mock('./private-workspace.js', () => ({
  candidateProfileWhere: () => ({ tenantId: 'tenant', ownerUserId: 'owner' }),
  getPrivateRecord: mocks.profile,
}));
vi.mock('./resume-data.js', () => ({ loadAdminResumeSource: mocks.source }));
vi.mock('./public-profile-render.js', () => ({
  projectPublicProfileSnapshot: mocks.project,
  renderPublicProfilePdf: mocks.render,
}));
vi.mock('./resume-files.js', () => ({
  getResumeFilesystem: async () => ({
    write: mocks.write,
    read: mocks.read,
    delete: mocks.remove,
  }),
}));
vi.mock('./smrt.js', () => ({
  getCollection: async () => ({ list: mocks.list }),
}));
vi.mock('./public-profile-store.js', () => ({
  createPublicProfileStore: () => ({
    listRevisions: mocks.listRevisions,
    reserve: mocks.reserve,
    prepare: mocks.prepare,
    getPrepared: mocks.getPrepared,
    publish: mocks.publish,
    unpublish: mocks.unpublish,
    getOwner: mocks.getOwner,
    resolvePublic: mocks.resolvePublic,
  }),
}));

import { createHash } from 'node:crypto';
import {
  getPublicProfile,
  getPublicProfileManager,
  getPublicProfilePdf,
  preparePublicProfile,
  publishPublicProfile,
  unpublishPublicProfile,
} from './public-profile-service.js';

const identity = {
  id: 'f32dcdee-f946-4a2f-a735-409617081d11',
  handle: 'synthetic-nurse',
  revision: 0,
  status: 'draft',
  currentRevisionId: null,
};
const revisionId = 'f32dcdee-f946-4a2f-a735-409617081d12';
const bytes = Buffer.from('%PDF-synthetic');
const snapshot = {
  version: 1,
  name: 'Synthetic Nurse',
  title: 'Nurse',
  summary: '',
  links: [],
  experience: [],
  education: [],
  other: [],
  skills: [],
};
const revision = {
  id: revisionId,
  snapshot,
  sourceProfileId: 'profile',
  baseRevision: 0,
  pdfPath: `public-profiles/${identity.id}/${revisionId}/resume.pdf`,
  pdfSha256: createHash('sha256').update(bytes).digest('hex'),
  pdfBytes: bytes.length,
};
const input = {
  handle: identity.handle,
  profileId: 'profile',
  visibility: {
    contacts: { email: false, phone: false, location: false, links: false },
    sections: { experience: true, education: true, other: true, skills: true },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'true');
  mocks.owner.mockImplementation(async (_locals, fn) => {
    await mocks.assert();
    return await fn({ assertOperation: mocks.assert });
  });
  mocks.resolve.mockResolvedValue({
    userId: 'owner',
    tenantId: 'tenant',
    profileId: 'profile',
  });
  mocks.profile.mockResolvedValue({ email: 'private@example.invalid' });
  mocks.source.mockResolvedValue({ profile: { email: '' } });
  mocks.project.mockReturnValue(snapshot);
  mocks.render.mockResolvedValue(bytes);
  mocks.reserve.mockResolvedValue(identity);
  mocks.getOwner.mockResolvedValue(identity);
  mocks.prepare.mockImplementation(async (_subject, value) => value);
  mocks.getPrepared.mockResolvedValue(revision);
  mocks.read.mockResolvedValue(bytes);
  mocks.list.mockResolvedValue([]);
  mocks.listRevisions.mockResolvedValue([]);
  mocks.resolvePublic.mockResolvedValue({ identity, revision });
});
describe('public profile service publication fences', () => {
  it('captures owned facts, renders once and returns no artifact path to the preview', async () => {
    const result = await preparePublicProfile({}, input);
    expect(mocks.resolve).toHaveBeenCalledWith('profile');
    expect(mocks.owner).toHaveBeenCalledTimes(3);
    expect(mocks.prepare.mock.calls[0][1]).toMatchObject({
      snapshot,
      sourceProfileId: 'profile',
      baseRevision: 0,
    });
    expect(result).not.toHaveProperty('pdfPath');
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it('never writes an artifact when the selected source is foreign', async () => {
    mocks.resolve.mockRejectedValue(new Error('foreign profile'));
    await expect(preparePublicProfile({}, input)).rejects.toThrow('foreign');
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('keeps current publication intact on renderer failure', async () => {
    mocks.render.mockRejectedValue(new Error('render failed'));
    await expect(preparePublicProfile({}, input)).rejects.toThrow(
      'render failed',
    );
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('rechecks authorization after rendering and never writes when revoked', async () => {
    mocks.render.mockImplementation(async () => {
      mocks.assert.mockRejectedValue(new Error('revoked'));
      return bytes;
    });
    await expect(preparePublicProfile({}, input)).rejects.toThrow('revoked');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('removes the staged artifact when final preparation loses the race', async () => {
    mocks.prepare.mockRejectedValue(new Error('deleted or stale'));
    mocks.getPrepared.mockResolvedValue(null);
    await expect(preparePublicProfile({}, input)).rejects.toThrow('deleted');
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.stringMatching(/^public-profiles\//),
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('verifies reviewed PDF integrity before publishing and re-enters authorization', async () => {
    await publishPublicProfile({}, { revisionId, expectedRevision: 0 });
    expect(mocks.owner).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledWith(
      { tenantId: 'tenant', userId: 'owner' },
      { revisionId, expectedRevision: 0 },
    );
    mocks.read.mockResolvedValue(Buffer.from('corrupt'));
    mocks.publish.mockClear();
    await expect(
      publishPublicProfile({}, { revisionId, expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('public projection strips all private ownership and artifact metadata', async () => {
    expect(await getPublicProfile(identity.handle)).toEqual({
      handle: identity.handle,
      snapshot,
      publishedAt: undefined,
      revisionId,
    });
  });
  it('does not release bytes if unpublished during storage read', async () => {
    mocks.resolvePublic
      .mockResolvedValueOnce({ identity, revision })
      .mockResolvedValueOnce(null);
    expect(await getPublicProfilePdf(identity.handle)).toBeNull();
  });
  it('blocks arbitrary artifact paths and disabled feature reads', async () => {
    mocks.resolvePublic.mockResolvedValue({
      identity,
      revision: { ...revision, pdfPath: '../private.pdf' },
    });
    await expect(getPublicProfilePdf(identity.handle)).rejects.toMatchObject({
      status: 404,
    });
    expect(mocks.read).not.toHaveBeenCalled();
    vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'false');
    await expect(getPublicProfile(identity.handle)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('unpublishes only as a fresh owner and lists only owned active source profiles', async () => {
    await unpublishPublicProfile({}, { expectedRevision: 3 });
    expect(mocks.unpublish).toHaveBeenCalledWith(
      { tenantId: 'tenant', userId: 'owner' },
      3,
    );
    mocks.list.mockResolvedValue([
      { id: 'foreign', tenantId: 'tenant', ownerUserId: 'other', active: true },
      {
        id: 'profile',
        tenantId: 'tenant',
        ownerUserId: 'owner',
        active: true,
        name: 'Nurse',
      },
    ]);
    expect((await getPublicProfileManager({})).profiles).toEqual([
      { id: 'profile', label: 'Nurse' },
    ]);
  });
});
