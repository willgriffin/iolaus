import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getResumeImportStorage,
  resumeImportStorageOptions,
} from './resume-import-storage.js';

vi.mock('./runtime-paths.js', () => ({
  getIolausUserAssetsRoot: () => '/canonical/assets',
}));
const hosted = (config: unknown, profile = 'cloud') => ({
  SMRT_RUNTIME_PROFILE: profile,
  IOLAUS_RESUME_IMPORT_STORAGE_JSON: JSON.stringify(config),
});
const s3 = {
  type: 's3',
  bucket: 'private-ingestion',
  region: 'us-east-1',
  endpoint: 'https://objects.example.invalid',
  forcePathStyle: true,
};
afterEach(() => vi.unstubAllEnvs());

describe('private ingestion configuration', () => {
  it('keeps local installations on the canonical root independently of legacy configuration', () => {
    expect(
      getResumeImportStorage({ RESUME_FILES_CONFIG_JSON: JSON.stringify(s3) }),
    ).toEqual({ type: 'local', basePath: '/canonical/assets' });
    expect(
      getResumeImportStorage(
        hosted({ type: 'local', basePath: '/canonical/assets' }, 'local'),
      ),
    ).toEqual({ type: 'local', basePath: '/canonical/assets' });
    for (const config of [
      s3,
      { type: 'local', basePath: '/tmp/replica' },
      { type: 'local', cacheDir: '/tmp' },
    ]) {
      expect(() => getResumeImportStorage(hosted(config, 'local'))).toThrow(
        'Invalid private',
      );
    }
  });
  it('requires explicit durable storage for both hosted profiles', () => {
    for (const profile of ['self-hosted', 'cloud']) {
      expect(() =>
        getResumeImportStorage({
          SMRT_RUNTIME_PROFILE: profile,
          RESUME_FILES_CONFIG_JSON: JSON.stringify(s3),
        }),
      ).toThrow('Invalid private');
      expect(getResumeImportStorage(hosted(s3, profile))).toEqual(s3);
    }
  });
  it.each([
    null,
    [],
    '',
    { type: 'local', basePath: '/tmp' },
    { ...s3, type: 'gdrive' },
    { ...s3, bucket: '' },
    { ...s3, region: '' },
    { ...s3, bucket: '../public' },
    { ...s3, basePath: 'ingestion' },
    { ...s3, acl: 'public-read' },
    { ...s3, endpoint: 'http://objects.example.invalid' },
    { ...s3, endpoint: 'https://user:secret@objects.example.invalid' },
    { ...s3, endpoint: 'https://objects.example.invalid/prefix' },
    { ...s3, endpoint: 'https://objects.example.invalid/?token=secret' },
    { ...s3, forcePathStyle: 'true' },
    { ...s3, accessKeyId: 'secret' },
    { ...s3, accessKeyId: 'secret', secretAccessKey: '' },
  ])('rejects malformed or unsafe hosted storage without disclosing configuration', (config) => {
    expect(() => getResumeImportStorage(hosted(config))).toThrow(
      /^Invalid private resume ingestion storage configuration \(IOLAUS_RESUME_IMPORT_STORAGE_JSON\)\.$/,
    );
  });
  it('rejects malformed JSON and unknown profiles without echoing values', () => {
    expect(() =>
      getResumeImportStorage({
        SMRT_RUNTIME_PROFILE: 'cloud',
        IOLAUS_RESUME_IMPORT_STORAGE_JSON: 'secret-malformed',
      }),
    ).toThrow(/^Invalid private/);
    expect(() => getResumeImportStorage(hosted(s3, 'clodu'))).toThrow(
      /^Invalid private/,
    );
  });
  it('passes explicit credentials or the SDK IAM chain through without adding provider options', () => {
    const credentials = {
      ...s3,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    };
    expect(getResumeImportStorage(hosted(credentials))).toEqual(credentials);
    expect(getResumeImportStorage(hosted(s3))).not.toHaveProperty(
      'accessKeyId',
    );
  });
});

describe('persisted private provider identity', () => {
  function check(sourceUri: string, storage = s3) {
    const resolver = resumeImportStorageOptions(storage as any).storeOptions
      ?.resolver;
    if (!resolver) throw new Error('Storage identity resolver is required.');
    return resolver({ sourceUri } as any);
  }
  it('accepts only the configured bucket for read, write and delete resolution', () => {
    expect(check('s3://private-ingestion/document/asset.pdf')).toBeUndefined();
    for (const uri of [
      's3://other-bucket/document/asset.pdf',
      'file:///tmp/document/asset.pdf',
      'https://public.invalid/a.pdf',
      's3://private-ingestion/../asset.pdf',
      's3://private-ingestion/a/%2e%2e/asset.pdf',
      's3://private-ingestion/a//asset.pdf',
      's3://private-ingestion/',
    ]) {
      expect(() => check(uri)).toThrow('storage identity is unavailable');
    }
  });
  it('rejects local URI escapes and foreign roots', () => {
    const storage = { type: 'local', basePath: '/canonical/assets' } as any;
    expect(
      check('file:///canonical/assets/document/asset.pdf', storage),
    ).toBeUndefined();
    expect(() =>
      check('file:///canonical/assets-other/document/asset.pdf', storage),
    ).toThrow('storage identity');
    expect(() =>
      check('file:///canonical/assets/../asset.pdf', storage),
    ).toThrow('storage identity');
  });
});
