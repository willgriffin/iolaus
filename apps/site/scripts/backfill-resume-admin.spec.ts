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
  isSharedHosted: vi.fn(),
  records: [] as Array<Record<string, unknown> & { save?: () => Promise<void> }>,
}));

vi.mock('../src/lib/server/smrt.js', () => ({
  getCollection: mocks.getCollection,
}));

vi.mock('../src/lib/server/app-config.js', () => ({
  isSharedHosted: mocks.isSharedHosted,
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
    mocks.isSharedHosted.mockReset();
    mocks.isSharedHosted.mockReturnValue(false);
  });

  async function expectFailClosed(): Promise<void> {
    await expect(ensurePublishedCurrentResumeAssetFiles()).rejects.toThrow(
      'lack a verified candidate workspace subject',
    );
    expect(mocks.getCollection).not.toHaveBeenCalled();
    expect(mocks.getResumeFilesystem).not.toHaveBeenCalled();
    expect(mocks.filesystem.exists).not.toHaveBeenCalled();
    expect(mocks.filesystem.write).not.toHaveBeenCalled();
  }

  it('does not inspect or restore a personal asset in private mode', async () => {
    await expectFailClosed();
  });

  it('does not inspect or restore a personal asset in shared hosted mode', async () => {
    mocks.isSharedHosted.mockReturnValue(true);

    await expectFailClosed();
  });
});
