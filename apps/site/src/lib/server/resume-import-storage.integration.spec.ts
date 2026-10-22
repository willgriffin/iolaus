import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, expect, it, vi } from 'vitest';
import {
  getResumeImportStorage,
  resumeImportStorageOptions,
} from './resume-import-storage.js';
import './smrt.js';

let root: string;
let db: DatabaseInterface;
afterEach(async () => {
  await db?.close?.();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('reopens native AssetRuntime metadata and bytes after a local restart, then deletes durably', async () => {
  root = await mkdtemp(join(tmpdir(), 'iolaus-private-storage-'));
  vi.stubEnv('SMRT_DATA_DIR', root);
  vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
  vi.stubEnv('IOLAUS_RESUME_IMPORT_STORAGE_JSON', undefined);
  const options = {
    type: 'sqlite' as const,
    url: join(root, 'metadata.sqlite'),
    cache: false,
  };
  db = await getDatabase(options);
  await getTestDatabase({
    db,
    classes: [
      'Asset',
      'AssetAssociation',
      'AssetType',
      'AssetStatus',
      'Folder',
      'AssetTag',
      'Tag',
      'PlaceAsset',
      'ProfileAsset',
    ],
  });
  let runtime = await createAssetRuntime({
    db,
    ...resumeImportStorageOptions(getResumeImportStorage()),
  });
  const data = Buffer.from('fictional private resume');
  const asset = await runtime.storeSourceAsset('Resume.txt', data, {
    mimeType: 'text/plain',
    tenantId: randomUUID(),
    ownerProfileId: randomUUID(),
  });
  const id = asset.id;
  if (!id) throw new Error('Asset ID was not persisted.');
  await db.close?.();
  db = await getDatabase(options);
  runtime = await createAssetRuntime({
    db,
    ...resumeImportStorageOptions(getResumeImportStorage()),
  });
  const restored = await runtime.collection.get(id);
  if (!restored) throw new Error('Asset was not restored.');
  expect(await runtime.store.read(restored)).toEqual(data);
  const uri = restored.sourceUri;
  restored.sourceUri = 's3://foreign-bucket/document/file.txt';
  await expect(runtime.store.read(restored)).rejects.toThrow(
    'storage identity',
  );
  await expect(runtime.store.remove(restored)).rejects.toThrow(
    'storage identity',
  );
  restored.sourceUri = uri;
  expect(await runtime.store.read(restored)).toEqual(data);
  await runtime.store.remove(restored);
  await expect(runtime.store.read(restored)).rejects.toThrow();
}, 30_000);
