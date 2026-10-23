import { resolve } from 'node:path';
import type { GetFilesystemOptions } from '@happyvertical/files';
import type { AssetRuntimeOptions } from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { resolveQuarantinedResumeStorage } from './resume-import-quarantine.js';
import { getIolausUserAssetsRoot } from './runtime-paths.js';

const CONFIG = 'IOLAUS_RESUME_IMPORT_STORAGE_JSON';
const invalid = () =>
  new Error(
    `Invalid private resume ingestion storage configuration (${CONFIG}).`,
  );

/** Deliberately separate from legacy/public resume file storage. Never log this result. */
export function getResumeImportStorage(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GetFilesystemOptions {
  const profile = environment.SMRT_RUNTIME_PROFILE?.trim() || 'local';
  if (!['local', 'self-hosted', 'cloud'].includes(profile)) throw invalid();
  const raw = environment[CONFIG];
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = raw === undefined ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw invalid();
    config = parsed as Record<string, unknown>;
  } catch {
    throw invalid();
  }
  if (profile === 'local') {
    const root = getIolausUserAssetsRoot();
    if (
      Object.keys(config).some((key) => !['type', 'basePath'].includes(key)) ||
      (config.type !== undefined && config.type !== 'local') ||
      (config.basePath !== undefined &&
        (typeof config.basePath !== 'string' ||
          resolve(config.basePath) !== root))
    )
      throw invalid();
    return { type: 'local', basePath: root };
  }
  const allowed = [
    'type',
    'bucket',
    'region',
    'endpoint',
    'forcePathStyle',
    'accessKeyId',
    'secretAccessKey',
  ];
  const cleanString = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
  if (
    Object.keys(config).some((key) => !allowed.includes(key)) ||
    config.type !== 's3' ||
    !cleanString(config.bucket) ||
    !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(
      config.bucket,
    ) ||
    config.bucket.includes('..') ||
    !cleanString(config.region) ||
    !/^[a-z0-9-]+$/.test(config.region) ||
    (config.forcePathStyle !== undefined &&
      typeof config.forcePathStyle !== 'boolean') ||
    ((config.accessKeyId !== undefined ||
      config.secretAccessKey !== undefined) &&
      (!cleanString(config.accessKeyId) ||
        !cleanString(config.secretAccessKey)))
  )
    throw invalid();
  if (config.endpoint !== undefined) {
    try {
      if (!cleanString(config.endpoint)) throw invalid();
      const endpoint = new URL(config.endpoint);
      if (
        (endpoint.protocol !== 'https:' &&
          !(
            environment.IOLAUS_RESUME_IMPORT_CLUSTER_GARAGE === '1' &&
            config.endpoint === 'http://garage.garage.svc.cluster.local:3900' &&
            config.forcePathStyle === true &&
            config.region === 'garage'
          )) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/'
      )
        throw invalid();
    } catch {
      throw invalid();
    }
  }
  return config as unknown as GetFilesystemOptions;
}

/** AssetStore does not validate persisted URI provider identity itself. */
export function assertResumeImportStorageIdentity(
  storage: GetFilesystemOptions,
  sourceUri: string,
): { prefix: string; key: string } {
  const prefix =
    storage.type === 's3'
      ? `s3://${storage.bucket}/`
      : `file://${storage.basePath}/`;
  const key = sourceUri.startsWith(prefix)
    ? sourceUri.slice(prefix.length)
    : '';
  if (
    !key ||
    key.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\?#%\p{Cc}\p{Cf}]/u.test(key)
  ) {
    throw new Error('Private resume asset storage identity is unavailable.');
  }
  return { prefix, key };
}

/** Database is mandatory: a missing quarantine schema cannot bypass deletion policy. */
export function resumeImportStorageOptions(
  storage: GetFilesystemOptions,
  db: DatabaseInterface,
): Pick<AssetRuntimeOptions, 'storage' | 'storeOptions'> {
  return {
    storage,
    storeOptions: {
      resolver: (request) => {
        const { prefix, key } = assertResumeImportStorageIdentity(
          storage,
          request.sourceUri,
        );
        return resolveQuarantinedResumeStorage(db, prefix, key, request);
      },
    },
  };
}
