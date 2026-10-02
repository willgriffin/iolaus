import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadResumeAssetPdf } from './resume-asset-pdf.js';

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

const mocks = vi.hoisted(() => ({
  assets: new Map<string, Record<string, unknown>>(),
  read: vi.fn(async () => Buffer.from('%PDF-1.7 test')),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({
    get: async (id: string) => mocks.assets.get(id) ?? null,
  })),
}));

describe('resume asset PDF', () => {
  beforeEach(() => {
    mocks.assets.clear();
    mocks.read.mockClear();
  });

  it('reads a PDF owned by the selected workspace profile', async () => {
    mocks.assets.set('asset-1', {
      candidateProfileId: subject.profileId,
      id: 'asset-1',
      ownerUserId: subject.userId,
      pdfBasename: 'resume.pdf',
      pdfPath: 'generated/asset-1.pdf',
      tenantId: subject.tenantId,
    });

    await expect(
      loadResumeAssetPdf('asset-1', subject, { read: mocks.read } as never),
    ).resolves.toMatchObject({ filename: 'resume.pdf' });
    expect(mocks.read).toHaveBeenCalledWith('generated/asset-1.pdf', {
      raw: true,
    });
  });

  it('does not reveal a PDF whose profile differs from the authenticated subject', async () => {
    mocks.assets.set('asset-other', {
      candidateProfileId: 'profile-other',
      id: 'asset-other',
      ownerUserId: subject.userId,
      pdfPath: 'generated/other.pdf',
      tenantId: subject.tenantId,
    });

    await expect(
      loadResumeAssetPdf('asset-other', subject, { read: mocks.read } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
