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
      id: 'resume-app-1',
      pdfBasename: 'resume.pdf',
      pdfPath: 'application-packages/app-1/resume.pdf',
    });

    await expect(
      applicationResumePdfFile({ resumeAssetId: 'resume-app-1' }),
    ).resolves.toEqual({
      filename: 'resume.pdf',
      pdfPath: 'application-packages/app-1/resume.pdf',
    });
    await expect(
      applicationResumePdfPath({ resumeAssetId: 'resume-app-1' }),
    ).resolves.toBe('application-packages/app-1/resume.pdf');
    await expect(
      applicationResumePdfExists({ resumeAssetId: 'resume-app-1' }),
    ).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenCalledWith(
      'application-packages/app-1/resume.pdf',
    );
  });

  it('fails closed when there is no selected resume PDF', async () => {
    await expect(applicationResumePdfPath({})).resolves.toBe('');
    await expect(applicationResumePdfExists({})).resolves.toBe(false);
    expect(mocks.exists).not.toHaveBeenCalled();
  });
});
