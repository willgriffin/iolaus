import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Asset, createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, expect, it } from 'vitest';
import {
  getResumeImportStorage,
  resumeImportStorageOptions,
} from './resume-import-storage.js';
import './smrt.js';

// Opt in only with an isolated, precreated private bucket. Never point this at
// a candidate bucket. NODE_EXTRA_CA_CERTS supplies the staging TLS root CA.
const rawConfig = process.env.IOLAUS_RESUME_IMPORT_S3_TEST_CONFIG_JSON;
const fictional = Buffer.from(
  'Fictional Candidate. Synthetic provider qualification only.',
);
let root: string | undefined;
let db: DatabaseInterface | undefined;
let runtime: Awaited<ReturnType<typeof createAssetRuntime>> | undefined;
const cleanup: Asset[] = [];

async function mustReject(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

afterEach(async () => {
  let cleanupFailed = false;
  for (const asset of cleanup.splice(0)) {
    try {
      await runtime?.store.removeFile(asset);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await db?.close?.();
    if (root) await rm(root, { recursive: true, force: true });
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed)
    throw new Error(
      'Synthetic private S3 fixture cleanup failed; inspect the isolated test bucket.',
    );
});

async function childRead(metadata: string, ids: string[]): Promise<void> {
  // Configuration is passed only through the environment, never argv or output.
  // Import the actual application resolver and released provider in a fresh
  // process; this cannot reuse a parent filesystem adapter or in-memory bytes.
  const script = `
    const quiet = () => {};
    console.log = console.warn = console.error = console.info = console.debug = quiet;
    let db;
    try {
      const { createAssetRuntime } = await import('@happyvertical/smrt-assets');
      const { getDatabase } = await import('@happyvertical/sql');
      const { getResumeImportStorage, resumeImportStorageOptions } = await import(${JSON.stringify(new URL('./resume-import-storage.ts', import.meta.url).href)});
      db = await getDatabase({type: 'sqlite', url: process.env.IOLAUS_S3_QA_METADATA, cache: false});
      const assets = await createAssetRuntime({db, ...resumeImportStorageOptions(getResumeImportStorage())});
      for (const id of JSON.parse(process.env.IOLAUS_S3_QA_ASSET_IDS)) {
        const asset = await assets.collection.get(id);
        if (!asset || !(await assets.store.read(asset)).equals(Buffer.from('Fictional Candidate. Synthetic provider qualification only.'))) throw new Error('read failed');
      }
      await db.close?.();
      process.stdout.write('private-storage-child-ok');
    } catch {
      await db?.close?.().catch(() => {});
      process.exitCode = 1;
    }
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SMRT_RUNTIME_PROFILE: 'self-hosted',
          IOLAUS_RESUME_IMPORT_STORAGE_JSON: rawConfig,
          IOLAUS_S3_QA_METADATA: metadata,
          IOLAUS_S3_QA_ASSET_IDS: JSON.stringify(ids),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (data: Buffer) => {
      if (output.length < 1024) output += data.toString();
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Private S3 child process could not start.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.includes('private-storage-child-ok')) resolve();
      else reject(new Error('Private S3 child process read failed.'));
    });
  });
}

it.skipIf(rawConfig === undefined)(
  'qualifies private S3 across restart and another process (requires IOLAUS_RESUME_IMPORT_S3_TEST_CONFIG_JSON for an isolated precreated bucket)',
  async () => {
    let stage = 'configuration';
    try {
      const storage = getResumeImportStorage({
        SMRT_RUNTIME_PROFILE: 'self-hosted',
        IOLAUS_RESUME_IMPORT_STORAGE_JSON: rawConfig,
      });
      if (storage.type !== 's3') throw new Error('S3 required');
      root = await mkdtemp(join(tmpdir(), 'iolaus-private-s3-'));
      const metadata = join(root, 'metadata.sqlite');
      const dbOptions = {
        type: 'sqlite' as const,
        url: metadata,
        cache: false,
      };
      db = await getDatabase(dbOptions);
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
      runtime = await createAssetRuntime({
        db,
        ...resumeImportStorageOptions(storage),
      });
      const tenantId = randomUUID();
      const ownerProfileId = randomUUID();
      const ids: string[] = [];
      stage = 'source and evidence write';
      for (const name of ['Fictional source.txt', 'Fictional evidence.txt']) {
        const asset = await runtime.collection.create({
          name,
          mimeType: 'text/plain',
          typeSlug: 'file',
          tenantId,
          ownerProfileId,
          sourceAssetId: ids[0] ?? null,
        });
        // Keep the native planned locator before writing so uncertain writes
        // can always be cleaned, just as ingestion retains cleanup locators.
        asset.sourceUri = await runtime.store.planFile(asset, {
          mimeType: 'text/plain',
        });
        cleanup.push(asset);
        await asset.save();
        await runtime.store.preserveFile(asset, fictional, {
          mimeType: 'text/plain',
        });
        if (!asset.id) throw new Error('Asset metadata not persisted');
        ids.push(asset.id);
        expect((await runtime.store.read(asset)).equals(fictional)).toBe(true);
      }
      stage = 'private unauthenticated read denial';
      const key = cleanup[0].sourceUri.slice(`s3://${storage.bucket}/`.length);
      const url = new URL(
        storage.endpoint ?? `https://s3.${storage.region}.amazonaws.com`,
      );
      url.pathname = `/${storage.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const unsigned = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      await unsigned.body?.cancel();
      expect([401, 403, 404].includes(unsigned.status)).toBe(true);

      stage = 'metadata reopen';
      await db.close?.();
      db = await getDatabase(dbOptions);
      runtime = await createAssetRuntime({
        db,
        ...resumeImportStorageOptions(storage),
      });
      for (const id of ids) {
        const asset = await runtime.collection.get(id);
        if (!asset) throw new Error('Asset metadata missing after reopen');
        expect((await runtime.store.read(asset)).equals(fictional)).toBe(true);
      }
      stage = 'separate process read';
      await db.close?.();
      await childRead(metadata, ids);
      db = await getDatabase(dbOptions);
      runtime = await createAssetRuntime({
        db,
        ...resumeImportStorageOptions(storage),
      });
      const asset = await runtime.collection.get(ids[0]);
      if (!asset) throw new Error('Source metadata missing');
      const sourceUri = asset.sourceUri;
      const authorizedRuntime = runtime;
      stage = 'foreign provider identity denial';
      asset.sourceUri = `s3://foreign-${randomUUID()}/file/source.txt`;
      await mustReject(async () => await authorizedRuntime.store.read(asset));
      await mustReject(
        async () => await authorizedRuntime.store.removeFile(asset),
      );
      asset.sourceUri = 'file:///tmp/not-an-ingestion-object.txt';
      await mustReject(async () => await authorizedRuntime.store.read(asset));
      asset.sourceUri = sourceUri;

      stage = 'provider authorization failure and recovery';
      const denied = await createAssetRuntime({
        db,
        ...resumeImportStorageOptions({
          ...storage,
          accessKeyId: `denied-${randomUUID()}`,
          secretAccessKey: randomUUID(),
        }),
      });
      await mustReject(async () => await denied.store.read(asset));
      await mustReject(async () => await denied.store.removeFile(asset));
      await mustReject(
        async () =>
          await denied.store.preserveFile(asset, fictional, {
            mimeType: 'text/plain',
          }),
      );
      // Failed reads/deletion must leave the actual private object intact and
      // retryable with the authorized provider, without a fallback filesystem.
      expect((await runtime.store.read(asset)).equals(fictional)).toBe(true);
      stage = 'durable deletion';
      for (const id of [...ids].reverse()) {
        const restored = await runtime.collection.get(id);
        if (!restored) throw new Error('Asset missing before deletion');
        await runtime.store.remove(restored);
      }
      await db.close?.();
      db = await getDatabase(dbOptions);
      runtime = await createAssetRuntime({
        db,
        ...resumeImportStorageOptions(storage),
      });
      const reopenedRuntime = runtime;
      for (const original of cleanup) {
        await mustReject(
          async () => await reopenedRuntime.store.read(original),
        );
        if (!original.id) throw new Error('Deleted asset ID missing');
        expect(await runtime.collection.get(original.id)).toBeNull();
        await runtime.store.removeFile(original); // cleanup retry is idempotent
      }
    } catch {
      // Never expose an SDK exception, config object, child stderr or credentials
      // through Vitest's rich assertion/error diagnostics.
      throw new Error(
        `Private S3 qualification failed during ${stage}; provider details withheld.`,
      );
    }
  },
  90_000,
);
