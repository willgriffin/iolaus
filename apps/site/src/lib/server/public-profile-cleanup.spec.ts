import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFilesystem } from '@happyvertical/files';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSupportedPublicProfileCleanupProvider,
  reconcilePublicProfileOrphans,
} from './public-profile-cleanup.js';

const identity = 'f32dcdee-f946-4a2f-a735-409617081d11';
const orphanRevision = 'f32dcdee-f946-4a2f-a735-409617081d12';
const currentRevision = 'f32dcdee-f946-4a2f-a735-409617081d13';
const oldOrphan = `public-profiles/${identity}/${orphanRevision}/resume.pdf`;
const current = `public-profiles/${identity}/${currentRevision}/resume.pdf`;
const now = new Date('2026-10-08T12:00:00.000Z');

function entry(
  path: string,
  lastModified = new Date('2026-10-06T12:00:00.000Z'),
) {
  return {
    path,
    name: path.split('/').pop() ?? '',
    size: 1,
    isDirectory: false,
    lastModified,
  };
}

function dependencies(
  paths: ReturnType<typeof entry>[],
  referenced: string[] = [],
) {
  return {
    filesystem: {
      delete: vi.fn(),
      getStats: vi.fn(async (path: string) => ({
        isFile: true,
        mtime: paths.find((item) => item.path === path)?.lastModified ?? now,
      })),
      list: vi.fn(async () => paths),
    },
    database: {
      query: vi.fn(async () => ({
        rows: referenced.map((pdfPath) => ({ pdfPath })),
      })),
    },
  };
}

const offline = { appStopped: true, offlineConfirmed: true, now };

let temporaryDirectory: string | undefined;
afterEach(async () => {
  if (temporaryDirectory)
    await rm(temporaryDirectory, { force: true, recursive: true });
  temporaryDirectory = undefined;
});

describe('public-profile orphan cleanup', () => {
  it('uses the actual local @happyvertical/files provider and a native SQLite query', async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'iolaus-profile-cleanup-'),
    );
    const filesystem = await getFilesystem({
      basePath: temporaryDirectory,
      type: 'local',
    });
    const database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(temporaryDirectory, 'cleanup.sqlite'),
    });
    await database.query(
      'CREATE TABLE public_profile_revisions (pdf_path TEXT NOT NULL)',
    );
    await database.query(
      'INSERT INTO public_profile_revisions (pdf_path) VALUES (?)',
      [current],
    );
    await filesystem.write(oldOrphan, Buffer.from('orphan'), {
      createParents: true,
    });
    await filesystem.write(current, Buffer.from('current'), {
      createParents: true,
    });
    const oldTime = new Date('2026-10-06T12:00:00.000Z');
    await utimes(join(temporaryDirectory, oldOrphan), oldTime, oldTime);
    await utimes(join(temporaryDirectory, current), oldTime, oldTime);

    await expect(
      reconcilePublicProfileOrphans(filesystem, database, offline),
    ).resolves.toMatchObject({
      candidates: [oldOrphan],
      deleted: [],
      dryRun: true,
    });
    expect(await filesystem.exists(oldOrphan)).toBe(true);
    await expect(
      reconcilePublicProfileOrphans(filesystem, database, {
        ...offline,
        dryRun: false,
      }),
    ).resolves.toMatchObject({ deleted: [oldOrphan] });
    expect(await filesystem.exists(oldOrphan)).toBe(false);
    expect(await filesystem.exists(current)).toBe(true);
    await database.close?.();
  });

  it('deletes only an old, UUID-scoped unreferenced PDF after building its plan', async () => {
    const { filesystem, database } = dependencies(
      [entry(oldOrphan), entry(current)],
      [current],
    );
    await expect(
      reconcilePublicProfileOrphans(filesystem, database, {
        ...offline,
        dryRun: false,
      }),
    ).resolves.toMatchObject({
      candidates: [oldOrphan],
      deleted: [oldOrphan],
      dryRun: false,
    });
    expect(filesystem.delete).toHaveBeenCalledWith(oldOrphan);
    expect(filesystem.list).toHaveBeenCalledWith('public-profiles', {
      recursive: true,
      detailed: false,
    });
  });

  it('is a dry run by default', async () => {
    const { filesystem, database } = dependencies([entry(oldOrphan)]);
    await expect(
      reconcilePublicProfileOrphans(filesystem, database, offline),
    ).resolves.toMatchObject({
      candidates: [oldOrphan],
      deleted: [],
      dryRun: true,
    });
    expect(filesystem.delete).not.toHaveBeenCalled();
  });

  it('preserves young, referenced, malformed, and non-public-profile files', async () => {
    const young = entry(oldOrphan, new Date('2026-10-08T11:00:00.000Z'));
    const malformed = entry(
      `public-profiles/${identity}/not-a-uuid/resume.pdf`,
    );
    const foreign = entry('generated-resumes/private/resume.pdf');
    const { filesystem, database } = dependencies(
      [young, entry(current), malformed, foreign],
      [current],
    );
    await expect(
      reconcilePublicProfileOrphans(filesystem, database, {
        ...offline,
        dryRun: false,
      }),
    ).resolves.toMatchObject({ candidates: [], deleted: [] });
    expect(filesystem.delete).not.toHaveBeenCalled();
  });

  it('caps scans at one hundred paths and returns a cursor so referenced paths cannot starve later orphans', async () => {
    const paths = Array.from({ length: 101 }, (_, index) => {
      const revision = `f32dcdee-f946-4a2f-a735-${String(index).padStart(12, '0')}`;
      return entry(`public-profiles/${identity}/${revision}/resume.pdf`);
    });
    const { filesystem, database } = dependencies(
      paths,
      paths.slice(0, 100).map((item) => item.path),
    );
    const first = await reconcilePublicProfileOrphans(
      filesystem,
      database,
      offline,
    );
    expect(first).toMatchObject({ candidates: [], scanned: 100 });
    expect(first.nextCursor).toBe(paths[99]?.path);
    const second = await reconcilePublicProfileOrphans(filesystem, database, {
      ...offline,
      afterPath: first.nextCursor,
    });
    expect(second).toMatchObject({
      candidates: [paths[100]?.path],
      scanned: 1,
    });
    expect(second.nextCursor).toBeUndefined();
  });

  it('fails closed before deletion when listing, stat, or database lookup fails', async () => {
    const listing = dependencies([entry(oldOrphan)]);
    listing.filesystem.list.mockRejectedValueOnce(new Error('list failed'));
    await expect(
      reconcilePublicProfileOrphans(listing.filesystem, listing.database, {
        ...offline,
        dryRun: false,
      }),
    ).rejects.toThrow('listing failed');
    expect(listing.filesystem.delete).not.toHaveBeenCalled();

    const stats = dependencies([entry(oldOrphan)]);
    stats.filesystem.getStats.mockRejectedValueOnce(new Error('stat failed'));
    await expect(
      reconcilePublicProfileOrphans(stats.filesystem, stats.database, {
        ...offline,
        dryRun: false,
      }),
    ).rejects.toThrow('stat failed');
    expect(stats.filesystem.delete).not.toHaveBeenCalled();

    const database = dependencies([entry(oldOrphan)]);
    database.database.query.mockRejectedValueOnce(new Error('database failed'));
    await expect(
      reconcilePublicProfileOrphans(database.filesystem, database.database, {
        ...offline,
        dryRun: false,
      }),
    ).rejects.toThrow('revision lookup failed');
    expect(database.filesystem.delete).not.toHaveBeenCalled();

    const invalidTime = dependencies([entry(oldOrphan)]);
    invalidTime.filesystem.getStats.mockResolvedValueOnce({
      isFile: true,
      mtime: new Date('invalid'),
    });
    await expect(
      reconcilePublicProfileOrphans(
        invalidTime.filesystem,
        invalidTime.database,
        {
          ...offline,
          dryRun: false,
        },
      ),
    ).rejects.toThrow('filesystem stat failed');
    expect(invalidTime.filesystem.delete).not.toHaveBeenCalled();
  });

  it('requires both offline confirmations and refuses unsupported providers', async () => {
    const { filesystem, database } = dependencies([entry(oldOrphan)]);
    await expect(
      reconcilePublicProfileOrphans(filesystem, database, {
        appStopped: true,
        offlineConfirmed: false,
        now,
      }),
    ).rejects.toThrow('offline confirmation');
    expect(isSupportedPublicProfileCleanupProvider('local')).toBe(true);
    expect(isSupportedPublicProfileCleanupProvider('s3')).toBe(false);
    expect(isSupportedPublicProfileCleanupProvider(undefined)).toBe(false);
  });
});
