// No personal resume files are required by this regression test.
vi.mock('node:fs/promises', async (original) => ({...await original<typeof import('node:fs/promises')>(), access: vi.fn(async () => {}), stat: vi.fn(async () => ({mtime:new Date('2026-01-01')})), readFile:vi.fn(async () => Buffer.from('synthetic test document'))}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePublishedCurrentResumeAssetFiles } from './backfill-resume-admin.js';

const mocks = vi.hoisted(() => ({
  collection: {
    list: vi.fn(),
  },
  filesystem: {
    exists: vi.fn(),
    write: vi.fn(),
  },
  getCollection: vi.fn(),
  getResumeFilesystem: vi.fn(),
  records: [] as Array<Record<string, unknown> & { save?: () => Promise<void> }>,
}));

vi.mock('../src/lib/server/smrt.js', () => ({
  getCollection: mocks.getCollection,
}));

vi.mock('../src/lib/server/resume-files.js', () => ({
  CURRENT_RESUME_DIR_PATH: 'current-resume',
  CURRENT_RESUME_PDF_BASENAME: 'resume.pdf',
  PUBLISHED_RESUME_PDF_PATH: 'published/resume.pdf',
  getResumeFilesystem: mocks.getResumeFilesystem,
}));

describe('ensurePublishedCurrentResumeAssetFiles', () => {
  beforeEach(() => {
    mocks.records = [];
    mocks.collection.list.mockReset();
    mocks.collection.list.mockImplementation(async () => mocks.records);
    mocks.filesystem.exists.mockReset();
    mocks.filesystem.write.mockReset();
    mocks.filesystem.write.mockResolvedValue(undefined);
    mocks.getCollection.mockReset();
    mocks.getCollection.mockResolvedValue(mocks.collection);
    mocks.getResumeFilesystem.mockReset();
    mocks.getResumeFilesystem.mockResolvedValue(mocks.filesystem);
  });

  it('restores missing current-resume files for the published legacy asset', async () => {
    const save = vi.fn(async () => {});
    const current = {
      generatedPath: 'generated-resumes/legacy-current',
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      save,
      sourcePath: 'var/profile-assets/current-resume',
    };
    mocks.records = [current];
    mocks.filesystem.exists.mockResolvedValue(false);

    await expect(ensurePublishedCurrentResumeAssetFiles()).resolves.toBe(1);

    expect(mocks.filesystem.write).toHaveBeenCalledWith(
      'generated-resumes/legacy-current/resume.pdf',
      expect.any(Buffer),
      { createParents: true },
    );
    expect(mocks.filesystem.write).toHaveBeenCalledWith(
      'published/resume.pdf',
      expect.any(Buffer),
      { createParents: true },
    );
    expect(current).toMatchObject({
      htmlPath: 'generated-resumes/legacy-current/resume.html',
      markdownPath: 'generated-resumes/legacy-current/resume.md',
      pdfBasename: 'resume.pdf',
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      textPath: 'generated-resumes/legacy-current/resume.txt',
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('leaves existing published resume files untouched', async () => {
    const save = vi.fn(async () => {});
    mocks.records = [
      {
        generatedPath: 'generated-resumes/legacy-current',
        id: 'legacy-current',
        isPublished: true,
        pdfPath: 'generated-resumes/legacy-current/resume.pdf',
        save,
      },
    ];
    mocks.filesystem.exists.mockResolvedValue(true);

    await expect(ensurePublishedCurrentResumeAssetFiles()).resolves.toBe(0);

    expect(mocks.filesystem.write).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
