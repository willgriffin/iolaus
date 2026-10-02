import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationResumePdfExists,
  applicationResumePdfFile,
  applicationResumePdfPath,
} from './application-resume-file.js';

const mocks = vi.hoisted(() => ({
  assets: new Map<string, Record<string, unknown>>(),
  exists: vi.fn(async (_path: string) => true),
}));

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({
    get: async (id: string) => mocks.assets.get(id) ?? null,
  })),
}));

vi.mock('./resume-files.js', () => ({
  CURRENT_RESUME_PDF_BASENAME: 'resume.pdf',
  PUBLIC_RESUME_PDF_FILENAME: 'resume.pdf',
  getResumeFilesystem: vi.fn(async () => ({ exists: mocks.exists })),
}));

describe('application resume file resolution', () => {
  beforeEach(() => {
    mocks.assets.clear();
    mocks.exists.mockClear();
    mocks.exists.mockResolvedValue(true);
  });

  it('uses the selected application resume PDF rather than a global fallback', async () => {
    mocks.assets.set('resume-app-1', {
      candidateProfileId: subject.profileId,
      id: 'resume-app-1',
      ownerUserId: subject.userId,
      pdfBasename: 'resume.pdf',
      pdfPath: 'application-packages/app-1/resume.pdf',
      tenantId: subject.tenantId,
    });

    await expect(
      applicationResumePdfFile(
        {
          ...subject,
          resumeAssetId: 'resume-app-1',
          ownerUserId: subject.userId,
          candidateProfileId: subject.profileId,
        },
        subject,
      ),
    ).resolves.toEqual({
      filename: 'resume.pdf',
      pdfPath: 'application-packages/app-1/resume.pdf',
    });
    await expect(
      applicationResumePdfPath(
        {
          ...subject,
          resumeAssetId: 'resume-app-1',
          ownerUserId: subject.userId,
          candidateProfileId: subject.profileId,
        },
        subject,
      ),
    ).resolves.toBe('application-packages/app-1/resume.pdf');
    await expect(
      applicationResumePdfExists(
        {
          ...subject,
          resumeAssetId: 'resume-app-1',
          ownerUserId: subject.userId,
          candidateProfileId: subject.profileId,
        },
        subject,
      ),
    ).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenCalledWith(
      'application-packages/app-1/resume.pdf',
    );
  });

  it('fails closed when there is no selected resume PDF', async () => {
    await expect(
      applicationResumePdfPath(
        {
          ...subject,
          ownerUserId: subject.userId,
          candidateProfileId: subject.profileId,
        },
        subject,
      ),
    ).resolves.toBe('');
    await expect(
      applicationResumePdfExists(
        {
          ...subject,
          ownerUserId: subject.userId,
          candidateProfileId: subject.profileId,
        },
        subject,
      ),
    ).resolves.toBe(false);
    expect(mocks.exists).not.toHaveBeenCalled();
  });

  it("does not resolve another profile's selected asset from its opaque ID", async () => {
    mocks.assets.set('resume-other-profile', {
      candidateProfileId: 'profile-other',
      id: 'resume-other-profile',
      ownerUserId: subject.userId,
      pdfPath: 'application-packages/other/resume.pdf',
      tenantId: subject.tenantId,
    });

    await expect(
      applicationResumePdfFile(
        {
          candidateProfileId: subject.profileId,
          ownerUserId: subject.userId,
          resumeAssetId: 'resume-other-profile',
          tenantId: subject.tenantId,
        },
        subject,
      ),
    ).resolves.toBeNull();
  });
});
